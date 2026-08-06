use crate::state::{StateDirEnv, resolve_logs_dir, resolve_state_dir};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_RETAIN_DAYS: u64 = 7;
const DEFAULT_RETAIN_RUNS: usize = 20;
const DEFAULT_THROTTLE_MS: u128 = 60 * 60 * 1000;
const LOCK_BASENAME: &str = ".prune.lock";
const STAMP_BASENAME: &str = ".prune.stamp";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PruneOptions {
    pub logs_dir: Option<PathBuf>,
    pub state_dir: Option<PathBuf>,
    pub retain_days: Option<u64>,
    pub retain_runs: Option<usize>,
    pub force: bool,
    pub env: BTreeMap<String, String>,
    pub platform: String,
    pub home_dir: PathBuf,
    pub now_ms: Option<u128>,
}

impl PruneOptions {
    pub fn from_process(force: bool) -> Self {
        let env = crate::env::effective_process_env();
        let home_dir = env
            .get("HOME")
            .map(PathBuf::from)
            .or_else(|| crate::env::effective_var_os("HOME").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("."));

        Self {
            logs_dir: None,
            state_dir: None,
            retain_days: None,
            retain_runs: None,
            force,
            env,
            platform: std::env::consts::OS.to_owned(),
            home_dir,
            now_ms: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PruneResult {
    pub skipped: bool,
    pub reason: Option<PruneSkipReason>,
    pub removed: Vec<String>,
    pub kept: usize,
    pub protected: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PruneSkipReason {
    Disabled,
    Throttled,
    Locked,
    Missing,
    Error,
}

pub fn run_clean_command(options: PruneOptions, stdout: &mut impl Write) -> i32 {
    let result = prune_logs(&options);
    if result.skipped {
        let reason = result.reason.map_or("unknown", PruneSkipReason::as_str);
        let _ = writeln!(stdout, "[Local CI] Nothing to clean ({reason}).");
    } else {
        let _ = writeln!(
            stdout,
            "[Local CI] Removed {} old run dir(s); kept {}.",
            result.removed.len(),
            result.kept
        );
        for name in result.removed {
            let _ = writeln!(stdout, "  - {name}");
        }
    }
    0
}

pub fn prune_logs(options: &PruneOptions) -> PruneResult {
    match try_prune_logs(options) {
        Ok(result) => result,
        Err(PruneError::Skipped(reason)) => PruneResult {
            skipped: true,
            reason: Some(reason),
            removed: Vec::new(),
            kept: 0,
            protected: Vec::new(),
        },
        Err(PruneError::Io) => PruneResult {
            skipped: true,
            reason: Some(PruneSkipReason::Error),
            removed: Vec::new(),
            kept: 0,
            protected: Vec::new(),
        },
    }
}

impl PruneSkipReason {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Throttled => "throttled",
            Self::Locked => "locked",
            Self::Missing => "missing",
            Self::Error => "error",
        }
    }
}

#[derive(Debug)]
enum PruneError {
    Skipped(PruneSkipReason),
    Io,
}

impl From<io::Error> for PruneError {
    fn from(_: io::Error) -> Self {
        Self::Io
    }
}

#[derive(Debug, Clone)]
struct RunDirEntry {
    name: String,
    path: PathBuf,
    mtime_ms: u128,
}

fn try_prune_logs(options: &PruneOptions) -> Result<PruneResult, PruneError> {
    if !options.force
        && options
            .env
            .get("LOCAL_CI_LOG_PRUNE")
            .is_some_and(|value| value == "0")
    {
        return Err(PruneError::Skipped(PruneSkipReason::Disabled));
    }

    let state_env = StateDirEnv::from_env(&options.env);
    let logs_dir = options
        .logs_dir
        .clone()
        .unwrap_or_else(|| resolve_logs_dir(&state_env, &options.platform, &options.home_dir));
    let state_dir = options
        .state_dir
        .clone()
        .unwrap_or_else(|| resolve_state_dir(&state_env, &options.platform, &options.home_dir));
    let retain_days = options
        .retain_days
        .or_else(|| read_positive_int(options.env.get("LOCAL_CI_LOG_RETAIN_DAYS")))
        .unwrap_or(DEFAULT_RETAIN_DAYS);
    let retain_runs = options
        .retain_runs
        .or_else(|| {
            read_positive_int(options.env.get("LOCAL_CI_LOG_RETAIN_RUNS"))
                .map(|value| value as usize)
        })
        .unwrap_or(DEFAULT_RETAIN_RUNS);
    let now = options.now_ms.unwrap_or_else(now_ms);

    if !logs_dir.exists() {
        return Err(PruneError::Skipped(PruneSkipReason::Missing));
    }
    if !options.force && is_throttled(&logs_dir, now) {
        return Err(PruneError::Skipped(PruneSkipReason::Throttled));
    }

    let lock_path = logs_dir.join(LOCK_BASENAME);
    let lock_file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
    {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            return Err(PruneError::Skipped(PruneSkipReason::Locked));
        }
        Err(err) => return Err(err.into()),
    };

    let result = run_with_lock(&logs_dir, &state_dir, retain_days, retain_runs, now);
    drop(lock_file);
    let _ = fs::remove_file(lock_path);
    result
}

fn run_with_lock(
    logs_dir: &Path,
    state_dir: &Path,
    retain_days: u64,
    retain_runs: usize,
    now: u128,
) -> Result<PruneResult, PruneError> {
    let protected_names = collect_protected_run_names(state_dir, logs_dir);
    let mut entries = list_run_dirs(logs_dir);
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.mtime_ms));

    let cutoff = now.saturating_sub(u128::from(retain_days) * 24 * 60 * 60 * 1000);
    let mut removed = Vec::new();
    let mut kept = 0;

    for entry in entries {
        let is_protected = protected_names.contains(&entry.name);
        let too_old = entry.mtime_ms < cutoff;
        let over_count = kept >= retain_runs;

        if is_protected || (!too_old && !over_count) {
            kept += 1;
            continue;
        }

        if fs::remove_dir_all(&entry.path).is_ok() {
            removed.push(entry.name);
        }
    }

    write_stamp(logs_dir, now);
    Ok(PruneResult {
        skipped: false,
        reason: None,
        removed,
        kept,
        protected: protected_names.into_iter().collect(),
    })
}

fn read_positive_int(raw: Option<&String>) -> Option<u64> {
    let raw = raw?;
    let value = raw.parse::<u64>().ok()?;
    Some(value)
}

fn list_run_dirs(logs_dir: &Path) -> Vec<RunDirEntry> {
    let Ok(entries) = fs::read_dir(logs_dir) else {
        return Vec::new();
    };

    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            if entry.file_name().to_string_lossy().starts_with('.') {
                return None;
            }
            let file_type = entry.file_type().ok()?;
            if !file_type.is_dir() {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let mtime_ms = metadata.modified().ok().map(system_time_ms)?;
            Some(RunDirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path(),
                mtime_ms,
            })
        })
        .collect()
}

fn collect_protected_run_names(state_dir: &Path, logs_dir: &Path) -> BTreeSet<String> {
    let mut protected_names = BTreeSet::new();
    if !state_dir.exists() {
        return protected_names;
    }

    let resolved_logs_dir = absolute_path(logs_dir);
    walk_state_dir(state_dir, &resolved_logs_dir, &mut protected_names);
    protected_names
}

fn walk_state_dir(dir: &Path, resolved_logs_dir: &Path, protected_names: &mut BTreeSet<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() {
            if name.starts_with('.') || absolute_path(&path) == resolved_logs_dir {
                continue;
            }
            walk_state_dir(&path, resolved_logs_dir, protected_names);
            continue;
        }

        if path.extension().is_some_and(|ext| ext == "json") {
            collect_from_json_file(&path, resolved_logs_dir, protected_names);
        }
    }
}

fn collect_from_json_file(
    file_path: &Path,
    resolved_logs_dir: &Path,
    protected_names: &mut BTreeSet<String>,
) {
    let Ok(content) = fs::read_to_string(file_path) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<Value>(&content) else {
        return;
    };
    let Some(jobs) = json.get("jobs").and_then(Value::as_array) else {
        return;
    };

    for job in jobs {
        maybe_add(
            job.get("debugLogPath").and_then(Value::as_str),
            resolved_logs_dir,
            protected_names,
        );
        if let Some(steps) = job.get("steps").and_then(Value::as_array) {
            for step in steps {
                maybe_add(
                    step.get("logPath").and_then(Value::as_str),
                    resolved_logs_dir,
                    protected_names,
                );
            }
        }
    }
}

fn maybe_add(path: Option<&str>, resolved_logs_dir: &Path, protected_names: &mut BTreeSet<String>) {
    let Some(path) = path.filter(|path| !path.is_empty()) else {
        return;
    };
    let resolved = absolute_path(Path::new(path));
    let Ok(relative) = resolved.strip_prefix(resolved_logs_dir) else {
        return;
    };
    let Some(Component::Normal(first)) = relative.components().next() else {
        return;
    };
    protected_names.insert(first.to_string_lossy().into_owned());
}

fn is_throttled(logs_dir: &Path, now: u128) -> bool {
    let Ok(raw) = fs::read_to_string(logs_dir.join(STAMP_BASENAME)) else {
        return false;
    };
    let Ok(last) = raw.trim().parse::<u128>() else {
        return false;
    };
    now.saturating_sub(last) < DEFAULT_THROTTLE_MS
}

fn write_stamp(logs_dir: &Path, now: u128) {
    let _ = fs::write(logs_dir.join(STAMP_BASENAME), format!("{now}\n"));
}

fn system_time_ms(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

fn now_ms() -> u128 {
    system_time_ms(SystemTime::now())
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
    use std::thread;
    use std::time::Duration;

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("local-ci-rust-clean-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn options(root: &Path, now: u128) -> PruneOptions {
        PruneOptions {
            logs_dir: Some(root.join("logs")),
            state_dir: Some(root.join("state")),
            retain_days: Some(7),
            retain_runs: Some(20),
            force: false,
            env: BTreeMap::new(),
            platform: "linux".to_owned(),
            home_dir: root.to_path_buf(),
            now_ms: Some(now),
        }
    }

    fn create_run_dir(logs_dir: &Path, name: &str) -> PathBuf {
        let path = logs_dir.join(name);
        fs::create_dir_all(&path).unwrap();
        thread::sleep(Duration::from_millis(2));
        path
    }

    #[test]
    fn skips_when_disabled_without_force() {
        let root = temp_dir("disabled");
        fs::create_dir_all(root.join("logs")).unwrap();
        let mut opts = options(&root, 1_000);
        opts.env
            .insert("LOCAL_CI_LOG_PRUNE".to_owned(), "0".to_owned());

        let result = prune_logs(&opts);

        assert_eq!(result.reason, Some(PruneSkipReason::Disabled));
    }

    #[test]
    fn force_ignores_disable_and_throttle() {
        let root = temp_dir("force");
        let logs_dir = root.join("logs");
        fs::create_dir_all(&logs_dir).unwrap();
        fs::write(logs_dir.join(STAMP_BASENAME), "999\n").unwrap();
        create_run_dir(&logs_dir, "old");
        let mut opts = options(&root, 1_000);
        opts.force = true;
        opts.retain_days = Some(0);
        opts.retain_runs = Some(0);
        opts.env
            .insert("LOCAL_CI_LOG_PRUNE".to_owned(), "0".to_owned());

        let result = prune_logs(&opts);

        assert!(!result.skipped);
        assert_eq!(result.removed, vec!["old".to_owned()]);
    }

    #[test]
    fn skips_missing_logs_dir() {
        let root = temp_dir("missing");
        let result = prune_logs(&options(&root, 1_000));

        assert_eq!(result.reason, Some(PruneSkipReason::Missing));
    }

    #[test]
    fn skips_when_throttled() {
        let root = temp_dir("throttle");
        let logs_dir = root.join("logs");
        fs::create_dir_all(&logs_dir).unwrap();
        fs::write(logs_dir.join(STAMP_BASENAME), "900\n").unwrap();

        let result = prune_logs(&options(&root, 1_000));

        assert_eq!(result.reason, Some(PruneSkipReason::Throttled));
    }

    #[test]
    fn skips_when_locked() {
        let root = temp_dir("locked");
        let logs_dir = root.join("logs");
        fs::create_dir_all(&logs_dir).unwrap();
        fs::write(logs_dir.join(LOCK_BASENAME), "").unwrap();

        let result = prune_logs(&options(&root, 10_000_000));

        assert_eq!(result.reason, Some(PruneSkipReason::Locked));
    }

    #[test]
    fn keeps_newest_count_and_removes_over_count() {
        let root = temp_dir("retain-count");
        let logs_dir = root.join("logs");
        fs::create_dir_all(&logs_dir).unwrap();
        create_run_dir(&logs_dir, "run-1");
        create_run_dir(&logs_dir, "run-2");
        create_run_dir(&logs_dir, "run-3");
        let mut opts = options(&root, now_ms());
        opts.retain_runs = Some(2);
        opts.retain_days = Some(365);

        let result = prune_logs(&opts);

        assert_eq!(result.kept, 2);
        assert_eq!(result.removed, vec!["run-1".to_owned()]);
        assert!(!logs_dir.join("run-1").exists());
        assert!(logs_dir.join("run-2").exists());
        assert!(logs_dir.join("run-3").exists());
    }

    #[test]
    fn protects_log_dirs_referenced_by_run_result_json() {
        let root = temp_dir("protected");
        let logs_dir = root.join("logs");
        let state_dir = root.join("state/owner/repo");
        fs::create_dir_all(&state_dir).unwrap();
        create_run_dir(&logs_dir, "protected-run");
        create_run_dir(&logs_dir, "old-run");
        fs::write(
            state_dir.join("main.12345678.json"),
            serde_json::to_string(&json!({
                "jobs": [{
                    "debugLogPath": logs_dir.join("protected-run/debug.log"),
                    "steps": [{"logPath": logs_dir.join("protected-run/steps/1.log")}]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let mut opts = options(&root, now_ms());
        opts.retain_days = Some(0);
        opts.retain_runs = Some(0);

        let result = prune_logs(&opts);

        assert_eq!(result.protected, vec!["protected-run".to_owned()]);
        assert_eq!(result.kept, 1);
        assert_eq!(result.removed, vec!["old-run".to_owned()]);
        assert!(logs_dir.join("protected-run").exists());
        assert!(!logs_dir.join("old-run").exists());
    }

    #[test]
    fn clean_command_prints_removed_dirs() {
        let root = temp_dir("command");
        let logs_dir = root.join("logs");
        fs::create_dir_all(&logs_dir).unwrap();
        create_run_dir(&logs_dir, "old");
        let mut opts = options(&root, now_ms());
        opts.force = true;
        opts.retain_days = Some(0);
        opts.retain_runs = Some(0);
        let mut stdout = Vec::new();

        let exit_code = run_clean_command(opts, &mut stdout);

        assert_eq!(exit_code, 0);
        let output = String::from_utf8(stdout).unwrap();
        assert!(output.contains("[Local CI] Removed 1 old run dir(s); kept 0."));
        assert!(output.contains("  - old"));
    }
}
