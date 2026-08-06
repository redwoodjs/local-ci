use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceSpec {
    pub id: String,
    pub image: String,
    pub env: Vec<String>,
    pub ports: BTreeMap<String, String>,
    pub options: Option<String>,
    pub health_cmd: Option<String>,
}

impl From<&local_ci_core::plan::PlannedService> for ServiceSpec {
    fn from(service: &local_ci_core::plan::PlannedService) -> Self {
        Self {
            id: service.id.clone(),
            image: service.image.clone(),
            env: service.env.clone(),
            ports: service.ports.clone(),
            options: service.options.clone(),
            health_cmd: service.health_cmd.clone(),
        }
    }
}

impl ServiceSpec {
    pub(super) fn to_payload(&self) -> Value {
        let env = self
            .env
            .iter()
            .filter_map(|entry| entry.split_once('='))
            .map(|(key, value)| (key.to_owned(), Value::String(value.to_owned())))
            .collect::<serde_json::Map<_, _>>();
        let ports = self
            .ports
            .iter()
            .map(|(host, container)| {
                if host.is_empty() {
                    Value::String(container.clone())
                } else {
                    Value::String(format!("{host}:{container}"))
                }
            })
            .collect::<Vec<_>>();
        json!({
            "id": self.id,
            "image": self.image,
            "env": env,
            "ports": ports,
            "volumes": Vec::<String>::new(),
            "options": self.options,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedService {
    pub id: String,
    pub container_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerExit {
    pub code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobResult {
    pub name: String,
    pub workflow: String,
    pub succeeded: bool,
    pub paused: bool,
    pub duration_ms: u64,
    pub failed_step: Option<String>,
    pub debug_log_path: Option<PathBuf>,
    pub steps: Vec<StepResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepResult {
    pub name: String,
    pub status: StepStatus,
    pub log_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PausedSignal {
    pub step: Option<String>,
    pub attempt: Option<u32>,
    pub step_index: Option<u32>,
}

impl PausedSignal {
    pub fn from_content(content: &str) -> Self {
        let mut lines = content.lines();
        let step = lines
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let attempt = lines.next().and_then(|value| value.trim().parse().ok());
        let step_index = lines.next().and_then(|value| value.trim().parse().ok());
        Self {
            step,
            attempt,
            step_index,
        }
    }
}

pub fn read_paused_signal(signals_dir: &Path) -> Option<PausedSignal> {
    fs::read_to_string(signals_dir.join("paused"))
        .ok()
        .map(|content| PausedSignal::from_content(&content))
}

pub trait DtuControlPlane {
    fn register_runner(&mut self, registration: &DtuRunnerRegistration) -> Result<(), String>;
    fn seed_job(&mut self, seed: &DtuJobSeed) -> Result<(), String>;
}

pub trait ContainerRuntime {
    fn create_network(&mut self, network: &str) -> Result<(), String>;
    fn remove_network(&mut self, network: &str) -> Result<(), String>;
    fn start_service(
        &mut self,
        service: &ServiceSpec,
        network: &str,
    ) -> Result<StartedService, String>;
    fn wait_service_healthy(&mut self, service: &StartedService) -> Result<(), String>;
    fn remove_service(&mut self, service: &StartedService) -> Result<(), String>;
    fn start_runner(&mut self, plan: &JobExecutionPlan, network: &str) -> Result<(), String>;
    fn stream_runner_logs(
        &mut self,
        runner_name: &str,
        signals_dir: Option<&Path>,
        sink: &mut dyn Write,
        on_pause: &mut dyn FnMut(PausedSignal),
    ) -> Result<(), String>;
    fn wait_runner(&mut self, runner_name: &str) -> Result<ContainerExit, String>;
    fn remove_runner(&mut self, runner_name: &str) -> Result<(), String>;
}

pub fn execute_registered_runner_job(
    dtu: &mut impl DtuControlPlane,
    runtime: &mut impl ContainerRuntime,
    plan: &JobExecutionPlan,
    seed: &DtuJobSeed,
) -> Result<JobResult, String> {
    execute_registered_runner_job_with_pause_observer(dtu, runtime, plan, seed, &mut |_| {})
}

pub fn execute_registered_runner_job_with_pause_observer(
    dtu: &mut impl DtuControlPlane,
    runtime: &mut impl ContainerRuntime,
    plan: &JobExecutionPlan,
    seed: &DtuJobSeed,
    on_pause: &mut dyn FnMut(PausedSignal),
) -> Result<JobResult, String> {
    let mut attempt = 1_u32;
    loop {
        dtu.register_runner(&DtuRunnerRegistration {
            runner_name: plan.runner_name.clone(),
            log_dir: plan.log_dir.clone(),
            timeline_dir: plan.log_dir.clone(),
            virtual_cache_patterns: default_virtual_cache_patterns(),
        })?;
        let mut attempt_seed = seed.clone();
        if attempt > 1 {
            attempt_seed.id = format!("{}-retry-{attempt}", seed.id);
        }
        dtu.seed_job(&attempt_seed)?;
        let result = execute_job_with_pause_observer(runtime, plan, on_pause)?;
        if restart_requested(&plan.signals_dir) {
            let _ = fs::remove_file(plan.signals_dir.join("restart"));
            attempt += 1;
            continue;
        }
        return Ok(result);
    }
}

pub(super) fn default_virtual_cache_patterns() -> Vec<String> {
    vec!["pnpm".to_owned(), "npm".to_owned(), "yarn".to_owned()]
}

pub fn execute_job(
    runtime: &mut impl ContainerRuntime,
    plan: &JobExecutionPlan,
) -> Result<JobResult, String> {
    execute_job_with_pause_observer(runtime, plan, &mut |_| {})
}

pub fn execute_job_with_pause_observer(
    runtime: &mut impl ContainerRuntime,
    plan: &JobExecutionPlan,
    on_pause: &mut dyn FnMut(PausedSignal),
) -> Result<JobResult, String> {
    let started = Instant::now();
    fs::create_dir_all(&plan.log_dir).map_err(|err| err.to_string())?;
    fs::create_dir_all(&plan.signals_dir).map_err(|err| err.to_string())?;
    let network = format!("local-ci-{}", plan.container_name);
    let mut started_services = Vec::new();
    let mut network_created = false;
    let mut runner_started = false;

    let result = (|| -> Result<JobResult, String> {
        runtime.create_network(&network)?;
        network_created = true;

        for service in &plan.services {
            let started = runtime.start_service(service, &network)?;
            started_services.push(started);
            let started_ref = started_services.last().expect("service just pushed");
            runtime.wait_service_healthy(started_ref)?;
        }

        runtime.start_runner(plan, &network)?;
        runner_started = true;
        let output_log_path = plan.log_dir.join("output.log");
        let mut output_log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&output_log_path)
            .map_err(|err| err.to_string())?;
        runtime.stream_runner_logs(
            &plan.container_name,
            plan.pause_on_failure.then_some(plan.signals_dir.as_path()),
            &mut output_log,
            on_pause,
        )?;
        let exit = runtime.wait_runner(&plan.container_name)?;

        build_job_result_from_logs(plan, exit.code == 0, started.elapsed().as_millis() as u64)
    })();

    let preserve_resources = plan.signals_dir.join("paused").exists();
    let mut cleanup_errors = Vec::new();
    if !preserve_resources {
        if runner_started && let Err(err) = runtime.remove_runner(&plan.container_name) {
            cleanup_errors.push(err);
        }
        for service in started_services.iter().rev() {
            if let Err(err) = runtime.remove_service(service) {
                cleanup_errors.push(err);
            }
        }
        if network_created && let Err(err) = runtime.remove_network(&network) {
            cleanup_errors.push(err);
        }
        if !restart_requested(&plan.signals_dir) {
            let _ = fs::remove_dir_all(&plan.signals_dir);
        }
    }

    match (result, cleanup_errors.is_empty()) {
        (Ok(result), true) => {
            write_job_summary(plan, &result)?;
            Ok(result)
        }
        (Ok(_), false) => Err(format!(
            "runner cleanup failed: {}",
            cleanup_errors.join("; ")
        )),
        (Err(err), true) => Err(err),
        (Err(err), false) => Err(format!(
            "{err}; cleanup also failed: {}",
            cleanup_errors.join("; ")
        )),
    }
}

pub(super) fn restart_requested(signals_dir: &Path) -> bool {
    signals_dir.join("restart").exists()
}
