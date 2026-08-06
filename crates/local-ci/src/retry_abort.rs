use crate::{RetryAbortArgs, RetryFromStep};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryAbortKind {
    Retry,
    Abort,
}

impl RetryAbortKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Retry => "retry",
            Self::Abort => "abort",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryAbortOptions {
    pub working_dir: PathBuf,
    pub current_dir: PathBuf,
}

impl RetryAbortOptions {
    pub fn from_process() -> Self {
        let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let env = crate::env::effective_process_env();
        let working_dir = resolve_working_dir(&env, &current_dir);
        Self {
            working_dir,
            current_dir,
        }
    }
}

pub fn run_retry_abort_command(
    kind: RetryAbortKind,
    args: RetryAbortArgs,
    options: &RetryAbortOptions,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> i32 {
    send_signal(
        kind,
        &args,
        options,
        stdout,
        stderr,
        docker_runner_is_running,
        |run_dir, current_dir, stdout| sync_workspace_for_retry(run_dir, current_dir, stdout),
    )
}

pub fn send_signal<IsRunning, SyncWorkspace>(
    kind: RetryAbortKind,
    args: &RetryAbortArgs,
    options: &RetryAbortOptions,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    is_runner_running: IsRunning,
    sync_workspace: SyncWorkspace,
) -> i32
where
    IsRunning: Fn(&str) -> bool,
    SyncWorkspace: Fn(&Path, &Path, &mut dyn Write) -> io::Result<()>,
{
    let Some(runner_name) = args.runner_name.as_deref() else {
        let _ = writeln!(
            stderr,
            "[Local CI] Error: --name <name> is required for '{}'",
            kind.as_str()
        );
        return 1;
    };

    let Some(signals_dir) = find_signals_dir(&options.working_dir, runner_name) else {
        let _ = writeln!(
            stderr,
            "[Local CI] Error: No runner '{runner_name}' found. It may have already exited."
        );
        return 1;
    };

    let paused_file = signals_dir.join("paused");
    if !paused_file.exists() {
        let _ = fs::remove_dir_all(&signals_dir);
        let _ = writeln!(
            stderr,
            "[Local CI] Error: Runner '{runner_name}' is not currently paused. It may have already exited."
        );
        return 1;
    }

    if !is_runner_running(runner_name) {
        let _ = fs::remove_dir_all(&signals_dir);
        let _ = writeln!(
            stderr,
            "[Local CI] Error: Runner '{runner_name}' is no longer running."
        );
        return 1;
    }

    if kind == RetryAbortKind::Retry {
        let run_dir = signals_dir.parent().unwrap_or(&signals_dir);
        if let Err(err) = sync_workspace(run_dir, &options.current_dir, stdout) {
            let _ = writeln!(stderr, "[Local CI] Error: Failed to sync workspace: {err}");
            return 1;
        }
        if let Some(from_step) = &args.from_step {
            let value = match from_step {
                RetryFromStep::Step(step) => step.to_string(),
                RetryFromStep::Start => "*".to_owned(),
            };
            if let Err(err) = fs::write(signals_dir.join("from-step"), value) {
                let _ = writeln!(
                    stderr,
                    "[Local CI] Error: Failed to write from-step signal: {err}"
                );
                return 1;
            }
        }
    }

    if let Err(err) = fs::write(signals_dir.join(kind.as_str()), "") {
        let _ = writeln!(
            stderr,
            "[Local CI] Error: Failed to write '{}' signal: {err}",
            kind.as_str()
        );
        return 1;
    }

    let extra = args
        .from_step
        .as_ref()
        .map_or_else(String::new, |from_step| {
            let step = match from_step {
                RetryFromStep::Step(step) => step.to_string(),
                RetryFromStep::Start => "1".to_owned(),
            };
            format!(" (from step {step})")
        });
    let _ = writeln!(
        stdout,
        "[Local CI] Sent '{}' signal to {runner_name}{extra}",
        kind.as_str()
    );
    0
}

pub fn find_signals_dir(working_dir: &Path, runner_name: &str) -> Option<PathBuf> {
    let runs_dir = working_dir.join("runs");
    let entries = fs::read_dir(runs_dir).ok()?;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == runner_name || name.ends_with(runner_name) {
            let signals_dir = entry.path().join("signals");
            if signals_dir.exists() {
                return Some(signals_dir);
            }
        }
    }
    None
}

pub fn sync_workspace_for_retry(
    run_dir: &Path,
    current_dir: &Path,
    stdout: &mut dyn Write,
) -> io::Result<()> {
    let Some(workspace_dir) = find_workspace_dir(run_dir) else {
        return Ok(());
    };
    let repo_root = crate::env::resolve_repo_root(current_dir);
    let files = git_file_list(&repo_root)?;
    let input = files.join("\0");

    if !rsync_files(&repo_root, &workspace_dir, input.as_bytes())? {
        copy_files_individually(&repo_root, &workspace_dir, &files);
    }

    writeln!(
        stdout,
        "[Local CI] Synced workspace from {}",
        repo_root.display()
    )
}

fn resolve_working_dir(env: &BTreeMap<String, String>, current_dir: &Path) -> PathBuf {
    if let Some(dir) = env.get("LOCAL_CI_WORKING_DIR") {
        let path = PathBuf::from(dir);
        return if path.is_absolute() {
            path
        } else {
            current_dir.join(path)
        };
    }
    let repo_root = crate::env::resolve_repo_root(current_dir);
    if Path::new("/.dockerenv").exists() {
        return repo_root.join(".local-ci");
    }
    let project_slug = repo_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");
    std::env::temp_dir().join("local-ci").join(project_slug)
}

fn find_workspace_dir(run_dir: &Path) -> Option<PathBuf> {
    let work_dir = run_dir.join("work");
    let entries = fs::read_dir(work_dir).ok()?;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let nested = entry.path().join(&name);
        if nested.is_dir() {
            return Some(nested);
        }
    }
    None
}

fn git_file_list(repo_root: &Path) -> io::Result<Vec<String>> {
    let output = Command::new("git")
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .current_dir(repo_root)
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other("git ls-files failed"));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

fn rsync_files(repo_root: &Path, workspace_dir: &Path, input: &[u8]) -> io::Result<bool> {
    let mut child = match Command::new("rsync")
        .args([
            "-a",
            "--delete",
            "--files-from=-",
            "--from0",
            "./",
            &format!("{}/", workspace_dir.display()),
        ])
        .current_dir(repo_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input)?;
    }

    Ok(child.wait()?.success())
}

fn copy_files_individually(repo_root: &Path, workspace_dir: &Path, files: &[String]) {
    for file in files {
        let source = repo_root.join(file);
        let destination = workspace_dir.join(file);
        if let Some(parent) = destination.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::copy(source, destination);
    }
}

fn docker_runner_is_running(runner_name: &str) -> bool {
    let output = Command::new("docker")
        .args(["inspect", "-f", "{{.State.Running}}", runner_name])
        .output();
    let Ok(output) = output else {
        return false;
    };
    output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("local-ci-rust-retry-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn opts(root: &Path) -> RetryAbortOptions {
        RetryAbortOptions {
            working_dir: root.to_path_buf(),
            current_dir: root.to_path_buf(),
        }
    }

    fn paused_runner(root: &Path, run_name: &str) -> PathBuf {
        let signals = root.join("runs").join(run_name).join("signals");
        fs::create_dir_all(&signals).unwrap();
        fs::write(signals.join("paused"), "").unwrap();
        signals
    }

    #[test]
    fn finds_exact_or_suffix_runner_signal_dirs() {
        let root = temp_dir("find");
        let exact = paused_runner(&root, "runner-one");
        let suffix = paused_runner(&root, "local-ci-1-runner-two");

        assert_eq!(find_signals_dir(&root, "runner-one"), Some(exact));
        assert_eq!(find_signals_dir(&root, "runner-two"), Some(suffix));
        assert_eq!(find_signals_dir(&root, "missing"), None);
    }

    #[test]
    fn requires_runner_name() {
        let root = temp_dir("missing-name");
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let exit = send_signal(
            RetryAbortKind::Retry,
            &RetryAbortArgs::default(),
            &opts(&root),
            &mut stdout,
            &mut stderr,
            |_| true,
            |_, _, _| Ok(()),
        );

        assert_eq!(exit, 1);
        assert!(
            String::from_utf8(stderr)
                .unwrap()
                .contains("--name <name> is required")
        );
    }

    #[test]
    fn writes_retry_signal_and_from_step() {
        let root = temp_dir("retry");
        let signals = paused_runner(&root, "runner-one");
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let args = RetryAbortArgs {
            runner_name: Some("runner-one".to_owned()),
            from_step: Some(RetryFromStep::Step(4)),
        };

        let exit = send_signal(
            RetryAbortKind::Retry,
            &args,
            &opts(&root),
            &mut stdout,
            &mut stderr,
            |_| true,
            |_, _, _| Ok(()),
        );

        assert_eq!(exit, 0);
        assert!(stderr.is_empty());
        assert!(signals.join("retry").exists());
        assert_eq!(fs::read_to_string(signals.join("from-step")).unwrap(), "4");
        assert!(
            String::from_utf8(stdout)
                .unwrap()
                .contains("Sent 'retry' signal")
        );
    }

    #[test]
    fn writes_from_start_as_star_and_prints_step_one() {
        let root = temp_dir("from-start");
        let signals = paused_runner(&root, "runner-one");
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let args = RetryAbortArgs {
            runner_name: Some("runner-one".to_owned()),
            from_step: Some(RetryFromStep::Start),
        };

        let exit = send_signal(
            RetryAbortKind::Retry,
            &args,
            &opts(&root),
            &mut stdout,
            &mut stderr,
            |_| true,
            |_, _, _| Ok(()),
        );

        assert_eq!(exit, 0);
        assert_eq!(fs::read_to_string(signals.join("from-step")).unwrap(), "*");
        assert!(String::from_utf8(stdout).unwrap().contains("from step 1"));
    }

    #[test]
    fn writes_abort_signal_without_from_step() {
        let root = temp_dir("abort");
        let signals = paused_runner(&root, "runner-one");
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let args = RetryAbortArgs {
            runner_name: Some("runner-one".to_owned()),
            from_step: Some(RetryFromStep::Start),
        };

        let exit = send_signal(
            RetryAbortKind::Abort,
            &args,
            &opts(&root),
            &mut stdout,
            &mut stderr,
            |_| true,
            |_, _, _| Ok(()),
        );

        assert_eq!(exit, 0);
        assert!(signals.join("abort").exists());
        assert!(!signals.join("from-step").exists());
    }

    #[test]
    fn removes_stale_signals_when_runner_is_not_paused() {
        let root = temp_dir("not-paused");
        let signals = root.join("runs/runner-one/signals");
        fs::create_dir_all(&signals).unwrap();
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let args = RetryAbortArgs {
            runner_name: Some("runner-one".to_owned()),
            from_step: None,
        };

        let exit = send_signal(
            RetryAbortKind::Retry,
            &args,
            &opts(&root),
            &mut stdout,
            &mut stderr,
            |_| true,
            |_, _, _| Ok(()),
        );

        assert_eq!(exit, 1);
        assert!(!signals.exists());
        assert!(
            String::from_utf8(stderr)
                .unwrap()
                .contains("not currently paused")
        );
    }

    #[test]
    fn removes_stale_signals_when_container_is_not_running() {
        let root = temp_dir("not-running");
        let signals = paused_runner(&root, "runner-one");
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let args = RetryAbortArgs {
            runner_name: Some("runner-one".to_owned()),
            from_step: None,
        };

        let exit = send_signal(
            RetryAbortKind::Retry,
            &args,
            &opts(&root),
            &mut stdout,
            &mut stderr,
            |_| false,
            |_, _, _| Ok(()),
        );

        assert_eq!(exit, 1);
        assert!(!signals.exists());
        assert!(
            String::from_utf8(stderr)
                .unwrap()
                .contains("no longer running")
        );
    }
}
