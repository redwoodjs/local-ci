use super::*;

#[derive(Debug, Clone)]
pub(super) struct RustRunDirectories {
    pub(super) container_work_dir: PathBuf,
    pub(super) shims_dir: PathBuf,
    pub(super) signals_dir: PathBuf,
    pub(super) diag_dir: PathBuf,
    pub(super) tool_cache_dir: PathBuf,
    pub(super) pnpm_store_dir: PathBuf,
    pub(super) npm_cache_dir: PathBuf,
    pub(super) yarn_cache_dir: PathBuf,
    pub(super) bun_cache_dir: PathBuf,
    pub(super) playwright_cache_dir: PathBuf,
    pub(super) cypress_cache_dir: PathBuf,
    pub(super) host_runner_dir: PathBuf,
    pub(super) workspace_dir: PathBuf,
}

pub(super) fn default_working_dir(repo_root: &Path) -> PathBuf {
    if let Some(configured) = crate::env::effective_var_os("LOCAL_CI_WORKING_DIR") {
        return PathBuf::from(configured);
    }
    let project_slug = repo_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");
    if Path::new("/.dockerenv").exists() {
        return repo_root.join(".local-ci");
    }
    std::env::temp_dir().join("local-ci").join(project_slug)
}

pub(super) fn resolve_dtu_host(env: &BTreeMap<String, String>) -> String {
    let inside_docker = Path::new("/.dockerenv").exists();
    if !inside_docker {
        if let Some(configured) = env
            .get("LOCAL_CI_DTU_HOST")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            return configured.to_owned();
        }
        if let Some(configured) = env
            .get("LOCAL_CI_DOCKER_BRIDGE_GATEWAY")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            return configured.to_owned();
        }
        if std::env::consts::OS == "macos" {
            return "host.docker.internal".to_owned();
        }
        if let Some(host_ip) = discover_host_reachable_ip() {
            return host_ip;
        }
        return "host.docker.internal".to_owned();
    }

    let output = Command::new("sh")
        .arg("-lc")
        .arg("hostname -I 2>/dev/null | awk '{print $1}'")
        .output();
    output
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| env.get("LOCAL_CI_DOCKER_BRIDGE_GATEWAY").cloned())
        .unwrap_or_else(|| "172.17.0.1".to_owned())
}

pub(super) fn discover_host_reachable_ip() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        for iface in ["en0", "en1", "bridge100"] {
            if let Some(ip) = command_stdout("ipconfig", &["getifaddr", iface]).and_then(first_ipv4)
            {
                return Some(ip);
            }
        }
    }

    command_stdout("hostname", &["-I"]).and_then(first_ipv4)
}

pub(super) fn command_stdout(command: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(command).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(super) fn first_ipv4(output: String) -> Option<String> {
    output
        .split_whitespace()
        .find(|part| {
            let octets = part.split('.').collect::<Vec<_>>();
            octets.len() == 4
                && *part != "127.0.0.1"
                && !part.starts_with("169.254.")
                && octets.iter().all(|octet| octet.parse::<u8>().is_ok())
        })
        .map(str::to_owned)
}

pub(super) fn create_rust_run_directories(
    working_dir: &Path,
    run_dir: &Path,
    github_repo: &str,
) -> Result<RustRunDirectories, String> {
    let repo_slug = github_repo.replace('/', "-");
    let repo_name = github_repo.split('/').next_back().unwrap_or("repo");
    let container_work_dir = run_dir.join("work");
    let shims_dir = run_dir.join("shims");
    let signals_dir = run_dir.join("signals");
    let diag_dir = run_dir.join("diag");
    let tool_cache_dir = working_dir.join("cache/toolcache");
    let pnpm_store_dir = working_dir.join("cache/pnpm-store").join(&repo_slug);
    let npm_cache_dir = working_dir.join("cache/npm-cache").join(&repo_slug);
    let yarn_cache_dir = working_dir.join("cache/yarn-cache").join(&repo_slug);
    let bun_cache_dir = working_dir.join("cache/bun-cache").join(&repo_slug);
    let playwright_cache_dir = working_dir.join("cache/playwright").join(&repo_slug);
    let cypress_cache_dir = working_dir.join("cache/cypress").join(&repo_slug);
    let host_runner_dir = run_dir.join("runner");
    let workspace_dir = container_work_dir.join(repo_name).join(repo_name);

    let dirs = RustRunDirectories {
        container_work_dir,
        shims_dir,
        signals_dir,
        diag_dir,
        tool_cache_dir,
        pnpm_store_dir,
        npm_cache_dir,
        yarn_cache_dir,
        bun_cache_dir,
        playwright_cache_dir,
        cypress_cache_dir,
        host_runner_dir,
        workspace_dir,
    };

    for dir in [
        &dirs.container_work_dir,
        &dirs.shims_dir,
        &dirs.signals_dir,
        &dirs.diag_dir,
    ] {
        let _ = fs::remove_dir_all(dir);
    }

    for dir in [
        &dirs.container_work_dir,
        &dirs.shims_dir,
        &dirs.signals_dir,
        &dirs.diag_dir,
        &dirs.tool_cache_dir,
        &dirs.pnpm_store_dir,
        &dirs.npm_cache_dir,
        &dirs.yarn_cache_dir,
        &dirs.bun_cache_dir,
        &dirs.playwright_cache_dir,
        &dirs.cypress_cache_dir,
        &dirs.host_runner_dir,
        &dirs.workspace_dir,
    ] {
        fs::create_dir_all(dir).map_err(|err| err.to_string())?;
        chmod_best_effort(dir);
    }
    fs::write(dirs.signals_dir.join("step-output"), "").map_err(|err| err.to_string())?;
    chmod_best_effort(&dirs.signals_dir.join("step-output"));

    Ok(dirs)
}

pub(super) fn write_git_shim(shims_dir: &Path, fake_sha: &str) -> Result<(), String> {
    fs::create_dir_all(shims_dir).map_err(|err| err.to_string())?;
    let shim = shims_dir.join("git");
    let content = include_str!("../git_shim.sh").replace("__LOCAL_CI_FAKE_SHA__", fake_sha);
    fs::write(&shim, content).map_err(|err| err.to_string())?;
    chmod_best_effort(&shim);
    Ok(())
}

pub(super) fn init_fake_git_repo(dir: &Path, github_repo: &str) -> Result<(), String> {
    run_git_ok(dir, &["init"])?;
    run_git_ok(dir, &["config", "user.name", "local-ci"])?;
    run_git_ok(dir, &["config", "user.email", "local-ci@example.com"])?;
    let _ = Command::new("git")
        .args(["remote", "remove", "origin"])
        .current_dir(dir)
        .output();
    run_git_ok(
        dir,
        &[
            "remote",
            "add",
            "origin",
            &format!("http://127.0.0.1/{github_repo}"),
        ],
    )?;
    run_git_ok(dir, &["add", "."])?;
    let _ = Command::new("git")
        .args(["commit", "-m", "workspace"])
        .current_dir(dir)
        .output();
    run_git_ok(dir, &["branch", "-M", "main"])?;
    let _ = Command::new("git")
        .args(["update-ref", "refs/remotes/origin/main", "HEAD"])
        .current_dir(dir)
        .output();
    let _ = Command::new("git")
        .args(["checkout", "--detach", "HEAD"])
        .current_dir(dir)
        .output();
    Ok(())
}

pub(super) fn run_git_ok(dir: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|err| format!("failed to run git: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

pub(super) fn ensure_docker_vm_runner_externals(runner_image: &str) -> Result<(), String> {
    let vm_externals_dir = "/home/runner/externals";
    let script = r#"set -e
if [ -x /target/node20/bin/node ]; then
  exit 0
fi
if [ ! -d /home/runner/externals ]; then
  echo "runner image does not contain /home/runner/externals" >&2
  exit 1
fi
mkdir -p /target
cp -a /home/runner/externals/. /target/
chmod -R a+rX /target 2>/dev/null || true
"#;
    let output = Command::new("docker")
        .args([
            "run",
            "--rm",
            "-u",
            "root",
            "-v",
            &format!("{vm_externals_dir}:/target"),
            runner_image,
            "sh",
            "-c",
            script,
        ])
        .output()
        .map_err(|err| format!("failed to prepare Docker VM runner externals: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "failed to prepare Docker VM runner externals: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

pub(super) fn prepare_docker_vm_work_dir(host_work_dir: &Path) -> Result<String, String> {
    let vm_work_dir = "/home/runner/_work".to_owned();
    let host = host_work_dir.to_string_lossy().into_owned();
    let script = "set -e; rm -rf /to/* /to/.[!.]* /to/..?* 2>/dev/null || true; cp -a /from/. /to/";
    let output = Command::new("docker")
        .args([
            "run",
            "--rm",
            "-v",
            &format!("{host}:/from:ro"),
            "-v",
            &format!("{vm_work_dir}:/to"),
            "alpine:3.20",
            "sh",
            "-c",
            script,
        ])
        .output()
        .map_err(|err| format!("failed to prepare Docker VM work dir: {err}"))?;
    if output.status.success() {
        Ok(vm_work_dir)
    } else {
        Err(format!(
            "failed to prepare Docker VM work dir: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

pub(super) fn chmod_best_effort(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::symlink_metadata(path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(if metadata.is_dir() { 0o777 } else { 0o755 });
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

pub(super) fn chmod_tree_best_effort(path: &Path) {
    chmod_best_effort(path);
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let child = entry.path();
        if child.is_dir() {
            chmod_tree_best_effort(&child);
        } else {
            chmod_best_effort(&child);
        }
    }
}

pub(super) fn job_result_input(result: &JobResult) -> JobResultInput {
    JobResultInput {
        name: result.name.clone(),
        workflow: result.workflow.clone(),
        succeeded: result.succeeded,
        duration_ms: result.duration_ms,
        failing_step: result.failed_step.clone(),
        debug_log_path: result.debug_log_path.clone(),
        steps: result
            .steps
            .iter()
            .map(|step| StepResultInput {
                name: step.name.clone(),
                status: match step.status {
                    StepStatus::Passed => StateStepResultStatus::Passed,
                    StepStatus::Failed => StateStepResultStatus::Failed,
                    StepStatus::Skipped => StateStepResultStatus::Skipped,
                },
                log_path: step.log_path.clone(),
            })
            .collect(),
    }
}

pub(super) fn run_result_branch(plan: &RunPlan) -> String {
    match &plan.selection {
        RunSelection::AllRelevant { branch, .. } => branch.clone(),
        RunSelection::SingleWorkflow => {
            current_branch(&plan.repo_root).unwrap_or_else(|_| "main".to_owned())
        }
    }
}

pub(super) fn resolve_github_repo(repo_root: &Path) -> String {
    if let Ok(repo) =
        crate::env::effective_var("GITHUB_REPOSITORY").ok_or(std::env::VarError::NotPresent)
    {
        let repo = repo.trim();
        if !repo.is_empty() && repo.contains('/') {
            return repo.to_owned();
        }
    }

    if let Ok(url) = git(repo_root, None, &["remote", "get-url", "origin"])
        && let Some(repo) = github_repo_from_remote(url.trim())
    {
        return repo;
    }

    let repo_name = repo_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");
    format!("local/{repo_name}")
}

pub(super) fn github_repo_from_remote(url: &str) -> Option<String> {
    let without_suffix = url.strip_suffix(".git").unwrap_or(url);
    if let Some((_, path)) = without_suffix.split_once("github.com:") {
        return normalize_repo_path(path);
    }
    if let Some(index) = without_suffix.find("github.com/") {
        return normalize_repo_path(&without_suffix[index + "github.com/".len()..]);
    }
    if without_suffix.matches('/').count() >= 1 {
        return normalize_repo_path(
            without_suffix
                .rsplit_once('@')
                .map_or(without_suffix, |(_, path)| path),
        );
    }
    None
}

pub(super) fn normalize_repo_path(path: &str) -> Option<String> {
    let parts = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if parts.len() >= 2 {
        Some(format!(
            "{}/{}",
            parts[parts.len() - 2],
            parts[parts.len() - 1]
        ))
    } else {
        None
    }
}

pub(super) fn format_planned_target(target: &PlannedJobTarget) -> String {
    match target {
        PlannedJobTarget::Linux { runs_on } | PlannedJobTarget::MacOs { runs_on } => {
            runs_on.clone()
        }
        PlannedJobTarget::ReusableWorkflow { uses } => uses.clone(),
        PlannedJobTarget::Unknown => "unknown target".to_owned(),
    }
}

pub(super) const EVENT_SCHEMA_VERSION: u32 = 1;
pub(super) const DETACHED_ENV: &str = "LOCAL_CI_DETACHED";
pub(super) const PAUSED_EXIT_CODE: i32 = 77;
