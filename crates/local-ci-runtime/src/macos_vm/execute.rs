use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MacosVmJobResult {
    pub vm_name: String,
    pub ip: String,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacosVmJobPlan {
    pub vm_name: String,
    pub image: String,
    pub repo_root: PathBuf,
    pub local_runner_dir: PathBuf,
    pub remote_workspace: String,
    pub remote_runner_dir: String,
    pub remote_log_dir: String,
    pub local_log_dir: PathBuf,
    pub creds: SshCreds,
    pub dtu_url: String,
    pub runner_token: String,
    pub runner_labels: Vec<String>,
    pub job_script: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VmCommandResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub trait MacosVmRuntime {
    fn image_exists(&mut self, image: &str) -> Result<bool, String>;
    fn pull_image(&mut self, image: &str) -> Result<(), String>;
    fn clone_vm(&mut self, image: &str, name: &str) -> Result<(), String>;
    fn start_vm(&mut self, name: &str) -> Result<(), String>;
    fn get_ip(&mut self, name: &str) -> Result<Option<String>, String>;
    fn ssh_exec(
        &mut self,
        ip: &str,
        creds: &SshCreds,
        script: &str,
    ) -> Result<VmCommandResult, String>;
    fn rsync_to(
        &mut self,
        ip: &str,
        creds: &SshCreds,
        local_src: &Path,
        remote_dst: &str,
        exclude: &[String],
        delete: bool,
    ) -> Result<(), String>;
    fn rsync_from(
        &mut self,
        ip: &str,
        creds: &SshCreds,
        remote_src: &str,
        local_dst: &Path,
    ) -> Result<(), String>;
    fn stop_vm(&mut self, name: &str) -> Result<(), String>;
    fn delete_vm(&mut self, name: &str) -> Result<(), String>;
}

#[derive(Debug, Default)]
pub struct CommandMacosVmRuntime {
    children: BTreeMap<String, Child>,
}

impl CommandMacosVmRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    fn run_status(spec: CommandSpec) -> Result<(), String> {
        let output = Command::new(&spec.program)
            .args(&spec.args)
            .output()
            .map_err(|err| format!("failed to run {}: {err}", spec.program))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "{} failed: {}{}",
                spec.program,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }

    fn run_output(spec: CommandSpec) -> Result<VmCommandResult, String> {
        let output = Command::new(&spec.program)
            .args(&spec.args)
            .output()
            .map_err(|err| format!("failed to run {}: {err}", spec.program))?;
        Ok(VmCommandResult {
            code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

impl MacosVmRuntime for CommandMacosVmRuntime {
    fn image_exists(&mut self, image: &str) -> Result<bool, String> {
        let result = Self::run_output(tart_list_args())?;
        if result.code != 0 {
            return Ok(false);
        }
        let escaped = image.replace('/', "\\/");
        Ok(result.stdout.contains(&format!("\"Name\" : \"{escaped}\""))
            || result.stdout.contains(&format!("\"Name\":\"{escaped}\""))
            || result.stdout.contains(&format!("\"Name\" : \"{image}\""))
            || result.stdout.contains(&format!("\"Name\":\"{image}\"")))
    }

    fn pull_image(&mut self, image: &str) -> Result<(), String> {
        Self::run_status(tart_pull_args(image))
    }

    fn clone_vm(&mut self, image: &str, name: &str) -> Result<(), String> {
        let _ = Self::run_status(tart_delete_args(name));
        Self::run_status(tart_clone_args(image, name))
    }

    fn start_vm(&mut self, name: &str) -> Result<(), String> {
        let spec = tart_run_args(name, false);
        let child = Command::new(&spec.program)
            .args(&spec.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("failed to start tart VM {name}: {err}"))?;
        self.children.insert(name.to_owned(), child);
        Ok(())
    }

    fn get_ip(&mut self, name: &str) -> Result<Option<String>, String> {
        let result = Self::run_output(tart_ip_args(name))?;
        if result.code != 0 {
            return Ok(None);
        }
        Ok(result
            .stdout
            .lines()
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned))
    }

    fn ssh_exec(
        &mut self,
        ip: &str,
        creds: &SshCreds,
        script: &str,
    ) -> Result<VmCommandResult, String> {
        Self::run_output(ssh_args(
            ip,
            creds,
            &["bash".to_owned(), "-lc".to_owned(), script.to_owned()],
        ))
    }

    fn rsync_to(
        &mut self,
        ip: &str,
        creds: &SshCreds,
        local_src: &Path,
        remote_dst: &str,
        exclude: &[String],
        delete: bool,
    ) -> Result<(), String> {
        let src = format!("{}/", local_src.display());
        let dst = format!("{}@{ip}:{}/", creds.user, remote_dst.trim_end_matches('/'));
        Self::run_status(rsync_args(&src, &dst, creds, exclude, delete))
    }

    fn rsync_from(
        &mut self,
        ip: &str,
        creds: &SshCreds,
        remote_src: &str,
        local_dst: &Path,
    ) -> Result<(), String> {
        fs::create_dir_all(local_dst).map_err(|err| err.to_string())?;
        let src = format!("{}@{ip}:{}/", creds.user, remote_src.trim_end_matches('/'));
        let dst = format!("{}/", local_dst.display());
        Self::run_status(rsync_args(&src, &dst, creds, &[], false))
    }

    fn stop_vm(&mut self, name: &str) -> Result<(), String> {
        if let Some(mut child) = self.children.remove(name) {
            let _ = child.kill();
        }
        match Self::run_status(tart_stop_args(name)) {
            Ok(()) => Ok(()),
            Err(err) if err.contains("is not running") => Ok(()),
            Err(err) => Err(err),
        }
    }

    fn delete_vm(&mut self, name: &str) -> Result<(), String> {
        Self::run_status(tart_delete_args(name))
    }
}

pub fn wait_for_ip(
    runtime: &mut impl MacosVmRuntime,
    vm_name: &str,
    max_attempts: usize,
) -> Result<String, String> {
    for _ in 0..max_attempts {
        if let Some(ip) = runtime.get_ip(vm_name)? {
            return Ok(ip);
        }
    }
    Err(format!("Timed out waiting for VM {vm_name} to get an IP"))
}

pub fn wait_for_ssh(
    runtime: &mut impl MacosVmRuntime,
    ip: &str,
    creds: &SshCreds,
    max_attempts: usize,
) -> Result<(), String> {
    for _ in 0..max_attempts {
        let result = runtime.ssh_exec(ip, creds, "true");
        if matches!(result, Ok(VmCommandResult { code: 0, .. })) {
            return Ok(());
        }
    }
    Err(format!("Timed out waiting for SSH on {ip}"))
}

pub fn apply_dns_override(
    runtime: &mut impl MacosVmRuntime,
    ip: &str,
    creds: &SshCreds,
    dns: &[String],
) -> Result<(), String> {
    let script = format!(
        "set -euo pipefail\necho \"{}\" | sudo -S networksetup -setdnsservers Ethernet {}\ndig +short +time=5 +tries=1 github.com >/dev/null\n",
        creds.password,
        dns.join(" ")
    );
    let result = runtime.ssh_exec(ip, creds, &script)?;
    if result.code != 0 {
        return Err(format!(
            "DNS override failed on {ip}: {}",
            if result.stderr.trim().is_empty() {
                result.stdout.trim()
            } else {
                result.stderr.trim()
            }
        ));
    }
    Ok(())
}

pub fn sync_repo_to_vm(
    runtime: &mut impl MacosVmRuntime,
    plan: &MacosVmJobPlan,
    ip: &str,
) -> Result<(), String> {
    let exclude = vec![
        ".git".to_owned(),
        "node_modules".to_owned(),
        "target".to_owned(),
    ];
    runtime.rsync_to(
        ip,
        &plan.creds,
        &plan.repo_root,
        &plan.remote_workspace,
        &exclude,
        true,
    )
}

pub fn build_macos_runner_script(plan: &MacosVmJobPlan) -> String {
    format!(
        r#"set -euo pipefail
mkdir -p {runner_dir} {log_dir}
cd {runner_dir}
# Credentials are pre-written by Local CI to avoid config.sh network/bootstrap overhead.
{job_script}
"#,
        runner_dir = shell_escape(&plan.remote_runner_dir),
        log_dir = shell_escape(&plan.remote_log_dir),
        job_script = plan.job_script,
    )
}

pub fn execute_macos_vm_job(
    runtime: &mut impl MacosVmRuntime,
    plan: &MacosVmJobPlan,
) -> Result<MacosVmJobResult, String> {
    fs::create_dir_all(&plan.local_log_dir).map_err(|err| err.to_string())?;
    let _permit = acquire_macos_vm_permit();
    let mut cleanup_errors = Vec::new();
    let result = (|| {
        if !runtime.image_exists(&plan.image)? {
            runtime.pull_image(&plan.image)?;
        }
        runtime.clone_vm(&plan.image, &plan.vm_name)?;
        runtime.start_vm(&plan.vm_name)?;
        let ip = wait_for_ip(runtime, &plan.vm_name, 90)?;
        wait_for_ssh(runtime, &ip, &plan.creds, 80)?;
        apply_dns_override(
            runtime,
            &ip,
            &plan.creds,
            &["1.1.1.1".to_owned(), "8.8.8.8".to_owned()],
        )?;
        let mkdir_result = runtime.ssh_exec(
            &ip,
            &plan.creds,
            &format!(
                "set -e\nmkdir -p {} {} {}",
                shell_escape(&plan.remote_workspace),
                shell_escape(&plan.remote_runner_dir),
                shell_escape(&plan.remote_log_dir),
            ),
        )?;
        if mkdir_result.code != 0 {
            return Err(format!(
                "failed to prepare macOS VM directories: {}{}",
                mkdir_result.stdout, mkdir_result.stderr
            ));
        }
        sync_repo_to_vm(runtime, plan, &ip)?;
        runtime.rsync_to(
            &ip,
            &plan.creds,
            &plan.local_runner_dir,
            &plan.remote_runner_dir,
            &[],
            true,
        )?;
        let script = build_macos_runner_script(plan);
        let command = runtime.ssh_exec(&ip, &plan.creds, &script)?;
        runtime.rsync_from(&ip, &plan.creds, &plan.remote_log_dir, &plan.local_log_dir)?;
        Ok(MacosVmJobResult {
            vm_name: plan.vm_name.clone(),
            ip,
            code: command.code,
            stdout: command.stdout,
            stderr: command.stderr,
        })
    })();

    if let Err(err) = runtime.stop_vm(&plan.vm_name) {
        cleanup_errors.push(err);
    }
    if let Err(err) = runtime.delete_vm(&plan.vm_name) {
        cleanup_errors.push(err);
    }

    match (result, cleanup_errors.is_empty()) {
        (Ok(result), true) => Ok(result),
        (Ok(_), false) => Err(format!(
            "macOS VM cleanup failed: {}",
            cleanup_errors.join("; ")
        )),
        (Err(err), true) => Err(err),
        (Err(err), false) => Err(format!(
            "{err}; cleanup also failed: {}",
            cleanup_errors.join("; ")
        )),
    }
}

struct MacosVmPermit;

impl Drop for MacosVmPermit {
    fn drop(&mut self) {
        let (lock, cvar) = macos_vm_semaphore();
        let mut state = lock.lock().expect("macOS VM semaphore lock");
        state.active = state.active.saturating_sub(1);
        cvar.notify_one();
    }
}

struct MacosVmSemaphoreState {
    limit: usize,
    active: usize,
}

fn acquire_macos_vm_permit() -> MacosVmPermit {
    let limit = macos_vm_concurrency_limit(
        std::env::var("LOCAL_CI_MACOS_VM_CONCURRENCY")
            .ok()
            .as_deref(),
    );
    let (lock, cvar) = macos_vm_semaphore();
    let mut state = lock.lock().expect("macOS VM semaphore lock");
    state.limit = limit;
    while state.active >= state.limit {
        state = cvar.wait(state).expect("macOS VM semaphore wait");
    }
    state.active += 1;
    MacosVmPermit
}

fn macos_vm_semaphore() -> &'static (Mutex<MacosVmSemaphoreState>, Condvar) {
    static SEMAPHORE: OnceLock<(Mutex<MacosVmSemaphoreState>, Condvar)> = OnceLock::new();
    SEMAPHORE.get_or_init(|| {
        (
            Mutex::new(MacosVmSemaphoreState {
                limit: macos_vm_concurrency_limit(
                    std::env::var("LOCAL_CI_MACOS_VM_CONCURRENCY")
                        .ok()
                        .as_deref(),
                ),
                active: 0,
            }),
            Condvar::new(),
        )
    })
}

pub fn macos_vm_concurrency_limit(env_value: Option<&str>) -> usize {
    env_value
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(2)
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
