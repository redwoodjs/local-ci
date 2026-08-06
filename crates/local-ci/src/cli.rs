use crate::{clean, env, retry_abort, run_command};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

pub const USAGE: &str = r#"Usage: local-ci <command> [args]

Commands:
  run [sha] --workflow <path>   Run all jobs in a workflow file (defaults to HEAD)
  run --all                     Run all relevant PR/Push workflows for current branch
  retry --name <name>           Send retry signal to a paused runner
    --from-step <N>              Re-run from step N (skips earlier steps)
    --from-start                 Re-run all run: steps from the beginning
  abort --name <name>           Send abort signal to a paused runner
  clean                         Delete old per-run log directories

Options:
  -w, --workflow <path>         Path to the workflow file
  -a, --all                     Discover and run all relevant workflows
  -p, --pause-on-failure         Pause on step failure for interactive debugging
  -q, --quiet                   Suppress animated rendering (also enabled by AI_AGENT=1)
      --json                    Emit NDJSON event stream on stdout (also enabled by LOCAL_CI_JSON=1)
      --no-matrix               Collapse all matrix combinations into a single job (uses first value of each key)
  -j, --jobs <N>                Maximum jobs to run at once
      --prewarm-through <workflow:job:step-id>
                                Populate the private dependency cache before parallel jobs
                                Or set: LOCAL_CI_PREWARM_THROUGH env var
      --github-token [<token>]  GitHub token for fetching remote reusable workflows
                                (auto-resolves via `gh auth token` if no value given)
                                Or set: LOCAL_CI_GITHUB_TOKEN env var
      --commit-status           Post a GitHub commit status after the run (requires --github-token)
      --var KEY=VALUE           Provide a workflow variable (${{ vars.KEY }}); repeat for multiple
      --var-file <path|->       Load workflow variables from JSON file or stdin

Secrets:
  Workflow secrets (${{ secrets.FOO }}) are resolved from:
    1. .env.local-ci file in the repo root
    2. Environment variables (shell env acts as fallback)
    3. --github-token automatically provides secrets.GITHUB_TOKEN

Vars:
  Workflow vars (${{ vars.FOO }}) can be provided via --var FOO=VALUE
  or --var-file <path|-> (JSON object or gh variable list JSON).
  The run fails if any referenced var is missing.
"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedCli {
    Help,
    Command(Command),
    UsageError,
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Run(RunArgs),
    Retry(RetryAbortArgs),
    Abort(RetryAbortArgs),
    Clean,
}

impl Command {
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::Run(_) => "run",
            Self::Retry(_) => "retry",
            Self::Abort(_) => "abort",
            Self::Clean => "clean",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunArgs {
    pub sha: Option<String>,
    pub workflow: Option<String>,
    pub pause_on_failure: bool,
    pub run_all: bool,
    pub quiet: bool,
    pub json: bool,
    pub no_matrix: bool,
    pub max_jobs: Option<u32>,
    pub prewarm_through: Option<String>,
    pub github_token: GithubTokenFlag,
    pub commit_status: bool,
    pub cli_vars: Vec<(String, String)>,
    pub var_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum GithubTokenFlag {
    #[default]
    Absent,
    Auto,
    Value(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RetryAbortArgs {
    pub runner_name: Option<String>,
    pub from_step: Option<RetryFromStep>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetryFromStep {
    Step(u32),
    Start,
}

#[must_use]
pub fn parse_cli<I, S>(args: I) -> ParsedCli
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    let Some(command) = args.first().map(String::as_str) else {
        return ParsedCli::UsageError;
    };

    match command {
        "--help" | "-h" => ParsedCli::Help,
        "run" => match parse_run_args(&args[1..]) {
            Ok(parsed) => ParsedCli::Command(Command::Run(parsed)),
            Err(err) => ParsedCli::Error(err),
        },
        "retry" => match parse_retry_abort_args(&args[1..]) {
            Ok(parsed) => ParsedCli::Command(Command::Retry(parsed)),
            Err(err) => ParsedCli::Error(err),
        },
        "abort" => match parse_retry_abort_args(&args[1..]) {
            Ok(parsed) => ParsedCli::Command(Command::Abort(parsed)),
            Err(err) => ParsedCli::Error(err),
        },
        "clean" => ParsedCli::Command(Command::Clean),
        _ => ParsedCli::UsageError,
    }
}

pub fn bootstrap_from_process() -> Result<env::RuntimeEnv, String> {
    let current_dir = std::env::current_dir()
        .map_err(|err| format!("[Local CI] Error: failed to read current directory: {err}"))?;
    let current_env = std::env::vars().collect::<BTreeMap<_, _>>();
    let runtime = bootstrap_from_env(&current_dir, &current_env)?;
    env::set_bootstrapped_local_ci_env(&runtime.local_ci);
    Ok(runtime)
}

pub fn bootstrap_from_env(
    current_dir: &Path,
    current_env: &BTreeMap<String, String>,
) -> Result<env::RuntimeEnv, String> {
    env::bootstrap_env(current_dir, current_env)
}

pub fn run_cli<I, S>(args: I, stdout: &mut impl Write, stderr: &mut impl Write) -> i32
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    match parse_cli(args) {
        ParsedCli::Help => {
            let _ = write!(stdout, "{USAGE}");
            0
        }
        ParsedCli::UsageError => {
            let _ = write!(stdout, "{USAGE}");
            1
        }
        ParsedCli::Error(err) => {
            let _ = writeln!(stderr, "[Local CI] Error: {err}");
            1
        }
        ParsedCli::Command(Command::Clean) => {
            clean::run_clean_command(clean::PruneOptions::from_process(true), stdout)
        }
        ParsedCli::Command(Command::Retry(args)) => retry_abort::run_retry_abort_command(
            retry_abort::RetryAbortKind::Retry,
            args,
            &retry_abort::RetryAbortOptions::from_process(),
            stdout,
            stderr,
        ),
        ParsedCli::Command(Command::Abort(args)) => retry_abort::run_retry_abort_command(
            retry_abort::RetryAbortKind::Abort,
            args,
            &retry_abort::RetryAbortOptions::from_process(),
            stdout,
            stderr,
        ),
        ParsedCli::Command(Command::Run(args)) => {
            run_command::run_run_command(args, stdout, stderr)
        }
    }
}

fn parse_run_args(args: &[String]) -> Result<RunArgs, String> {
    let mut parsed = RunArgs::default();
    let mut index = 0;

    while index < args.len() {
        let arg = &args[index];
        match arg.as_str() {
            "--workflow" | "-w" => {
                parsed.workflow = Some(take_next(args, &mut index, arg)?);
            }
            "--pause-on-failure" | "-p" => parsed.pause_on_failure = true,
            "--all" | "-a" => parsed.run_all = true,
            "--quiet" | "-q" => parsed.quiet = true,
            "--json" => parsed.json = true,
            "--no-matrix" => parsed.no_matrix = true,
            "--jobs" | "-j" => {
                let raw = take_next(args, &mut index, arg)?;
                parsed.max_jobs = Some(parse_positive_u32(&raw, "--jobs")?);
            }
            "--prewarm-through" => {
                parsed.prewarm_through = Some(take_next(args, &mut index, arg)?);
            }
            "--commit-status" => parsed.commit_status = true,
            "--var" => {
                let raw = take_next(args, &mut index, arg)?;
                parsed.cli_vars.push(parse_var_flag(&raw)?);
            }
            "--var-file" => {
                let file = take_next(args, &mut index, arg)?;
                if file.is_empty() {
                    return Err("--var-file expects a path or - for stdin".to_owned());
                }
                parsed.var_files.push(file);
            }
            "--github-token" => match args.get(index + 1) {
                Some(next) if !next.starts_with('-') => {
                    parsed.github_token = GithubTokenFlag::Value(next.clone());
                    index += 1;
                }
                _ => parsed.github_token = GithubTokenFlag::Auto,
            },
            _ => {
                if let Some(value) = arg.strip_prefix("--workflow=") {
                    parsed.workflow = Some(value.to_owned());
                } else if let Some(value) = arg.strip_prefix("--jobs=") {
                    parsed.max_jobs = Some(parse_positive_u32(value, "--jobs")?);
                } else if let Some(value) = arg.strip_prefix("--prewarm-through=") {
                    parsed.prewarm_through = Some(value.to_owned());
                } else if let Some(value) = arg.strip_prefix("--var=") {
                    parsed.cli_vars.push(parse_var_flag(value)?);
                } else if let Some(value) = arg.strip_prefix("--var-file=") {
                    if value.is_empty() {
                        return Err("--var-file expects a path or - for stdin".to_owned());
                    }
                    parsed.var_files.push(value.to_owned());
                } else if let Some(value) = arg.strip_prefix("--github-token=") {
                    parsed.github_token = GithubTokenFlag::Value(value.to_owned());
                } else if !arg.starts_with('-') {
                    parsed.sha = Some(arg.clone());
                }
            }
        }
        index += 1;
    }

    Ok(parsed)
}

fn parse_retry_abort_args(args: &[String]) -> Result<RetryAbortArgs, String> {
    let mut parsed = RetryAbortArgs::default();
    let mut index = 0;

    while index < args.len() {
        let arg = &args[index];
        match arg.as_str() {
            "--name" | "-n" | "--runner" => {
                parsed.runner_name = Some(take_next(args, &mut index, arg)?);
            }
            "--from-step" => {
                let raw = take_next(args, &mut index, arg)?;
                parsed.from_step = Some(RetryFromStep::Step(parse_positive_u32(
                    &raw,
                    "--from-step",
                )?));
            }
            "--from-start" => parsed.from_step = Some(RetryFromStep::Start),
            _ => {
                if let Some(value) = arg.strip_prefix("--name=") {
                    parsed.runner_name = Some(value.to_owned());
                } else if let Some(value) = arg.strip_prefix("--runner=") {
                    parsed.runner_name = Some(value.to_owned());
                } else if let Some(value) = arg.strip_prefix("--from-step=") {
                    parsed.from_step = Some(RetryFromStep::Step(parse_positive_u32(
                        value,
                        "--from-step",
                    )?));
                }
            }
        }
        index += 1;
    }

    Ok(parsed)
}

fn take_next(args: &[String], index: &mut usize, flag: &str) -> Result<String, String> {
    let Some(value) = args.get(*index + 1) else {
        return Err(format!("{flag} expects a value"));
    };
    *index += 1;
    Ok(value.clone())
}

fn parse_positive_u32(raw: &str, flag: &str) -> Result<u32, String> {
    let value = raw
        .parse::<u32>()
        .map_err(|_| format!("{flag} must be a positive integer"))?;
    if value == 0 {
        return Err(format!("{flag} must be a positive integer"));
    }
    Ok(value)
}

fn parse_var_flag(raw: &str) -> Result<(String, String), String> {
    let Some((key, value)) = raw.split_once('=') else {
        return Err(format!("--var expects KEY=VALUE, got: {raw}"));
    };
    let key = key.trim();
    if key.is_empty() {
        return Err(format!("--var expects KEY=VALUE, got: {raw}"));
    }
    Ok((key.to_owned(), value.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_level_help_prints_usage_and_exits_zero() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let exit_code = run_cli(["--help"], &mut stdout, &mut stderr);

        assert_eq!(exit_code, 0);
        assert_eq!(String::from_utf8(stdout).unwrap(), USAGE);
        assert!(stderr.is_empty());
    }

    #[test]
    fn no_args_prints_usage_and_exits_one() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let exit_code = run_cli(std::iter::empty::<&str>(), &mut stdout, &mut stderr);

        assert_eq!(exit_code, 1);
        assert_eq!(String::from_utf8(stdout).unwrap(), USAGE);
        assert!(stderr.is_empty());
    }

    #[test]
    fn parses_run_flags() {
        let parsed = parse_cli([
            "run",
            "abc123",
            "--workflow",
            ".github/workflows/ci.yml",
            "--pause-on-failure",
            "--all",
            "--quiet",
            "--json",
            "--no-matrix",
            "--github-token",
            "ghp_token",
            "--commit-status",
            "--prewarm-through",
            ".github/workflows/ci.yml:test:install",
            "--var",
            "FOO=bar",
            "--var-file=vars.json",
        ]);

        assert_eq!(
            parsed,
            ParsedCli::Command(Command::Run(RunArgs {
                sha: Some("abc123".to_owned()),
                workflow: Some(".github/workflows/ci.yml".to_owned()),
                pause_on_failure: true,
                run_all: true,
                quiet: true,
                json: true,
                no_matrix: true,
                max_jobs: None,
                prewarm_through: Some(".github/workflows/ci.yml:test:install".to_owned()),
                github_token: GithubTokenFlag::Value("ghp_token".to_owned()),
                commit_status: true,
                cli_vars: vec![("FOO".to_owned(), "bar".to_owned())],
                var_files: vec!["vars.json".to_owned()],
            }))
        );
    }

    #[test]
    fn parses_github_token_auto_mode() {
        let parsed = parse_cli(["run", "--github-token", "--all"]);

        assert!(matches!(
            parsed,
            ParsedCli::Command(Command::Run(RunArgs {
                github_token: GithubTokenFlag::Auto,
                run_all: true,
                ..
            }))
        ));
    }

    #[test]
    fn parses_retry_and_abort_flags() {
        let retry = parse_cli(["retry", "--name", "runner-1", "--from-step", "4"]);
        let abort = parse_cli(["abort", "--runner=runner-2", "--from-start"]);

        assert_eq!(
            retry,
            ParsedCli::Command(Command::Retry(RetryAbortArgs {
                runner_name: Some("runner-1".to_owned()),
                from_step: Some(RetryFromStep::Step(4)),
            }))
        );
        assert_eq!(
            abort,
            ParsedCli::Command(Command::Abort(RetryAbortArgs {
                runner_name: Some("runner-2".to_owned()),
                from_step: Some(RetryFromStep::Start),
            }))
        );
    }

    #[test]
    fn rejects_invalid_positive_integer_flags() {
        assert_eq!(
            parse_cli(["run", "--jobs", "0"]),
            ParsedCli::Error("--jobs must be a positive integer".to_owned())
        );
        assert!(matches!(
            parse_cli(["run", "--jobs", "2"]),
            ParsedCli::Command(Command::Run(RunArgs {
                max_jobs: Some(2),
                ..
            }))
        ));
        assert!(matches!(
            parse_cli(["run", "--jobs=3"]),
            ParsedCli::Command(Command::Run(RunArgs {
                max_jobs: Some(3),
                ..
            }))
        ));
        assert_eq!(
            parse_cli(["retry", "--from-step", "nope"]),
            ParsedCli::Error("--from-step must be a positive integer".to_owned())
        );
    }
}
