use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub use local_ci_core::state::{
    JobResultInput, JobResultStatus, RUN_RESULT_SCHEMA_VERSION, RunResultFile, RunResultInput,
    RunResultJobEntry, RunResultStepEntry, StepResultInput, StepResultStatus,
    build_run_result_json, normalize_run_result,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateDirEnv {
    pub local_ci_state_dir: Option<String>,
    pub local_ci_log_dir: Option<String>,
    pub xdg_state_home: Option<String>,
    pub home: Option<String>,
}

impl StateDirEnv {
    pub fn from_env(env: &BTreeMap<String, String>) -> Self {
        Self {
            local_ci_state_dir: env
                .get("LOCAL_CI_STATE_DIR")
                .or_else(|| env.get("AGENT_CI_STATE_DIR"))
                .cloned(),
            local_ci_log_dir: env
                .get("LOCAL_CI_LOG_DIR")
                .or_else(|| env.get("AGENT_CI_LOG_DIR"))
                .cloned(),
            xdg_state_home: env.get("XDG_STATE_HOME").cloned(),
            home: env.get("HOME").cloned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogContext {
    pub num: u32,
    pub name: String,
    pub run_dir: PathBuf,
    pub log_dir: PathBuf,
    pub output_log_path: PathBuf,
    pub debug_log_path: PathBuf,
}

pub fn resolve_state_dir(env: &StateDirEnv, platform: &str, home_dir: &Path) -> PathBuf {
    if let Some(dir) = &env.local_ci_state_dir {
        return PathBuf::from(dir);
    }

    let home = env
        .home
        .as_ref()
        .map_or_else(|| home_dir.to_path_buf(), PathBuf::from);
    if platform == "darwin" {
        return home.join("Library/Application Support/local-ci");
    }

    env.xdg_state_home.as_ref().map_or_else(
        || home.join(".local/state/local-ci"),
        |xdg_state| PathBuf::from(xdg_state).join("local-ci"),
    )
}

pub fn resolve_logs_dir(env: &StateDirEnv, platform: &str, home_dir: &Path) -> PathBuf {
    env.local_ci_log_dir.as_ref().map_or_else(
        || resolve_state_dir(env, platform, home_dir).join("logs"),
        PathBuf::from,
    )
}

pub fn runs_dir(working_dir: &Path) -> PathBuf {
    working_dir.join("runs")
}

pub fn ensure_log_dirs(working_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(runs_dir(working_dir))
}

pub fn get_next_log_num(working_dir: &Path, logs_dir: &Path, prefix: &str) -> u32 {
    let max = collect_run_nums(&runs_dir(working_dir), prefix)
        .into_iter()
        .chain(collect_run_nums(logs_dir, prefix))
        .max();
    max.map_or(1, |value| value + 1)
}

pub fn create_log_context(
    working_dir: &Path,
    logs_dir: &Path,
    prefix: &str,
    preferred_name: Option<&str>,
) -> io::Result<LogContext> {
    ensure_log_dirs(working_dir)?;

    let (num, name, run_dir) = if let Some(name) = preferred_name {
        let run_dir = runs_dir(working_dir).join(name);
        fs::create_dir_all(&run_dir)?;
        (0, name.to_owned(), run_dir)
    } else {
        allocate_run_dir(working_dir, logs_dir, prefix)?
    };

    let log_dir = logs_dir.join(&name);
    fs::create_dir_all(&log_dir)?;
    reset_per_run_log_artifacts(&log_dir)?;

    Ok(LogContext {
        num,
        name,
        run_dir,
        output_log_path: log_dir.join("output.log"),
        debug_log_path: log_dir.join("debug.log"),
        log_dir,
    })
}

pub fn finalize_log(log_path: &Path) -> PathBuf {
    log_path.to_path_buf()
}

fn allocate_run_dir(
    working_dir: &Path,
    logs_dir: &Path,
    prefix: &str,
) -> io::Result<(u32, String, PathBuf)> {
    let mut num = get_next_log_num(working_dir, logs_dir, prefix);
    loop {
        let name = format!("{prefix}-{num}");
        let run_dir = runs_dir(working_dir).join(&name);
        match fs::create_dir(&run_dir) {
            Ok(()) => return Ok((num, name, run_dir)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => num += 1,
            Err(err) => return Err(err),
        }
    }
}

fn reset_per_run_log_artifacts(log_dir: &Path) -> io::Result<()> {
    for entry in [
        "timeline.json",
        "outputs.json",
        "metadata.json",
        "output.log",
        "debug.log",
        "summary.json",
    ] {
        remove_file_if_exists(&log_dir.join(entry))?;
    }
    remove_dir_if_exists(&log_dir.join("steps"))?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn remove_dir_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn collect_run_nums(dir: &Path, prefix: &str) -> Vec<u32> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let is_dir = entry.file_type().ok()?.is_dir();
            if !is_dir {
                return None;
            }
            run_number_from_dir_name(prefix, &entry.file_name().to_string_lossy())
        })
        .collect()
}

fn run_number_from_dir_name(prefix: &str, name: &str) -> Option<u32> {
    let suffix = name.strip_prefix(&format!("{prefix}-"))?;
    let number = suffix.split('-').next()?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    number.parse().ok()
}

pub fn worktree_path_hash(worktree_path: &Path) -> String {
    let absolute = absolute_path(worktree_path);
    let mut hasher = Sha1::new();
    hasher.update(absolute.to_string_lossy().as_bytes());
    format!("{:x}", hasher.finalize())[..8].to_owned()
}

pub fn resolve_run_result_path(
    state_dir: &Path,
    repo: &str,
    branch: &str,
    worktree_path: &Path,
) -> PathBuf {
    state_dir.join(repo).join(format!(
        "{}.{}.json",
        sanitize_branch(branch),
        worktree_path_hash(worktree_path)
    ))
}

pub fn write_run_result(input: &RunResultInput, state_dir: Option<&Path>) -> Option<PathBuf> {
    let state_dir = state_dir.map_or_else(default_state_dir_for_process, Path::to_path_buf);
    let file_path =
        resolve_run_result_path(&state_dir, &input.repo, &input.branch, &input.worktree_path);

    write_run_result_at(input, &file_path).ok()?;
    Some(file_path)
}

fn write_run_result_at(input: &RunResultInput, file_path: &Path) -> io::Result<()> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let Some(file_name) = file_path.file_name() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "run result path must include a file name",
        ));
    };
    let mut tmp_file_name = file_name.to_os_string();
    tmp_file_name.push(format!(".{}.tmp", std::process::id()));
    let tmp_path = file_path.with_file_name(tmp_file_name);
    let mut data =
        serde_json::to_string_pretty(&build_run_result_json(input)).map_err(io::Error::other)?;
    data.push('\n');
    fs::write(&tmp_path, data)?;
    fs::rename(tmp_path, file_path)
}

fn default_state_dir_for_process() -> PathBuf {
    let env = crate::env::effective_process_env();
    let state_env = StateDirEnv::from_env(&env);
    let home = crate::env::effective_var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    resolve_state_dir(&state_env, std::env::consts::OS, &home)
}

fn sanitize_branch(branch: &str) -> String {
    branch
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("local-ci-rust-state-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolves_state_and_log_dirs_with_platform_defaults() {
        let home = PathBuf::from("/Users/tester");
        let env = StateDirEnv {
            local_ci_state_dir: None,
            local_ci_log_dir: None,
            xdg_state_home: None,
            home: None,
        };

        assert_eq!(
            resolve_state_dir(&env, "darwin", &home),
            PathBuf::from("/Users/tester/Library/Application Support/local-ci")
        );
        assert_eq!(
            resolve_state_dir(&env, "linux", &home),
            PathBuf::from("/Users/tester/.local/state/local-ci")
        );
        assert_eq!(
            resolve_logs_dir(&env, "linux", &home),
            PathBuf::from("/Users/tester/.local/state/local-ci/logs")
        );
    }

    #[test]
    fn supports_legacy_state_and_log_dir_environment_names() {
        let values = BTreeMap::from([
            ("AGENT_CI_STATE_DIR".to_owned(), "/legacy-state".to_owned()),
            ("AGENT_CI_LOG_DIR".to_owned(), "/legacy-logs".to_owned()),
        ]);

        let env = StateDirEnv::from_env(&values);

        assert_eq!(env.local_ci_state_dir, Some("/legacy-state".to_owned()));
        assert_eq!(env.local_ci_log_dir, Some("/legacy-logs".to_owned()));
    }

    #[test]
    fn resolves_state_and_log_dir_overrides() {
        let home = PathBuf::from("/home/tester");
        let env = StateDirEnv {
            local_ci_state_dir: Some("/state".to_owned()),
            local_ci_log_dir: Some("/logs".to_owned()),
            xdg_state_home: Some("/xdg-state".to_owned()),
            home: None,
        };

        assert_eq!(
            resolve_state_dir(&env, "linux", &home),
            PathBuf::from("/state")
        );
        assert_eq!(
            resolve_logs_dir(&env, "linux", &home),
            PathBuf::from("/logs")
        );
    }

    #[test]
    fn allocates_run_dirs_using_runs_and_stable_logs() {
        let root = temp_dir("log-context");
        let working_dir = root.join("work");
        let logs_dir = root.join("logs");
        fs::create_dir_all(runs_dir(&working_dir).join("local-ci-test-1-j1-m2-r3")).unwrap();
        fs::create_dir_all(logs_dir.join("local-ci-test-2")).unwrap();

        let ctx = create_log_context(&working_dir, &logs_dir, "local-ci-test", None).unwrap();

        assert_eq!(ctx.num, 3);
        assert_eq!(ctx.name, "local-ci-test-3");
        assert!(ctx.run_dir.exists());
        assert_eq!(ctx.log_dir, logs_dir.join("local-ci-test-3"));
    }

    #[test]
    fn resets_stale_per_run_log_artifacts_when_reusing_a_preferred_name() {
        let root = temp_dir("reset-log-context");
        let working_dir = root.join("work");
        let logs_dir = root.join("logs");
        let stale = logs_dir.join("runner-name");
        fs::create_dir_all(stale.join("steps")).unwrap();
        fs::write(stale.join("timeline.json"), "[]").unwrap();
        fs::write(stale.join("output.log"), "old").unwrap();
        fs::write(stale.join("steps/1.log"), "old").unwrap();

        let ctx = create_log_context(
            &working_dir,
            &logs_dir,
            "local-ci-test",
            Some("runner-name"),
        )
        .unwrap();

        assert_eq!(ctx.num, 0);
        assert!(!stale.join("timeline.json").exists());
        assert!(!stale.join("output.log").exists());
        assert!(!stale.join("steps").exists());
    }

    #[test]
    fn builds_run_result_json_with_existing_log_paths_only() {
        let root = temp_dir("run-result");
        let debug = root.join("debug.log");
        let step_log = root.join("step.log");
        fs::write(&debug, "debug").unwrap();
        fs::write(&step_log, "step").unwrap();
        let input = RunResultInput {
            repo: "owner/repo".to_owned(),
            branch: "feat/slash".to_owned(),
            worktree_path: root.clone(),
            head_sha: "abc123".to_owned(),
            started_at: "2026-01-01T00:00:00.000Z".to_owned(),
            finished_at: "2026-01-01T00:00:01.000Z".to_owned(),
            results: vec![JobResultInput {
                name: "test".to_owned(),
                workflow: "ci.yml".to_owned(),
                succeeded: false,
                duration_ms: 42,
                failing_step: Some("Run tests".to_owned()),
                debug_log_path: Some(debug.clone()),
                steps: vec![StepResultInput {
                    name: "Run tests".to_owned(),
                    status: StepResultStatus::Failed,
                    log_path: Some(step_log.clone()),
                }],
            }],
        };

        let value = serde_json::to_value(build_run_result_json(&input)).unwrap();

        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["status"], json!("failed"));
        assert_eq!(
            value["jobs"][0]["debugLogPath"],
            json!(debug.to_string_lossy())
        );
        assert_eq!(
            value["jobs"][0]["steps"][0]["logPath"],
            json!(step_log.to_string_lossy())
        );
    }

    #[test]
    fn writes_run_result_to_sanitized_branch_path() {
        let root = temp_dir("write-run-result");
        let worktree = root.join("repo");
        fs::create_dir_all(&worktree).unwrap();
        let input = RunResultInput {
            repo: "owner/repo".to_owned(),
            branch: "feat/slash".to_owned(),
            worktree_path: worktree.clone(),
            head_sha: "abc123".to_owned(),
            started_at: "2026-01-01T00:00:00.000Z".to_owned(),
            finished_at: "2026-01-01T00:00:01.000Z".to_owned(),
            results: vec![],
        };

        let path = write_run_result(&input, Some(&root)).unwrap();
        let content = fs::read_to_string(&path).unwrap();

        assert_eq!(path.parent().unwrap(), root.join("owner/repo"));
        assert!(
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("feat-slash.")
        );
        assert!(content.ends_with('\n'));
        assert_eq!(
            serde_json::from_str::<RunResultFile>(&content)
                .unwrap()
                .status,
            JobResultStatus::Passed
        );
    }
}
