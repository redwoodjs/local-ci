use super::*;
use local_ci_core::expr::{ExpressionContext, expand_expressions};
use local_ci_runtime::wave::{ConcurrentWorkerEvent, run_concurrent_workers};
use std::sync::{Arc, Condvar, Mutex};

#[derive(Debug)]
pub(super) struct WaveJob {
    pub(super) index: usize,
    pub(super) job: PlannedJob,
    pub(super) route: JobExecutionRoute,
    pub(super) needs_context: BTreeMap<String, NeedContext>,
}

#[derive(Debug, Clone)]
pub(super) struct SharedExecutionContext {
    pub(super) run_plan: RunPlan,
    pub(super) workflow: WorkflowRunPlan,
    pub(super) working_dir: PathBuf,
    pub(super) logs_dir: PathBuf,
    pub(super) process_env: BTreeMap<String, String>,
    pub(super) github_repo: String,
    pub(super) dtu_url: String,
    pub(super) dtu_container_url: String,
    pub(super) dtu_control_token: String,
    pub(super) dtu_port: String,
    pub(super) docker_api_url: String,
    pub(super) repo_url: String,
    pub(super) dtu_host: String,
    pub(super) job_limiter: Option<Arc<SharedJobLimiter>>,
    pub(super) image: Option<String>,
    pub(super) docker_socket: Option<DockerSocket>,
    pub(super) extra_hosts: Vec<String>,
}

#[derive(Debug)]
pub(super) struct JobExecutionOutcome {
    pub(super) schedule_key: String,
    pub(super) result: JobResult,
    pub(super) status: JobResultStatus,
    pub(super) outputs: BTreeMap<String, String>,
}

#[derive(Debug)]
pub(super) struct SharedJobLimiter {
    state: Mutex<JobLimiterState>,
    available: Condvar,
}

#[derive(Debug)]
struct JobLimiterState {
    active: usize,
    max: usize,
}

#[derive(Debug)]
struct JobPermit<'a> {
    limiter: &'a SharedJobLimiter,
}

impl SharedJobLimiter {
    pub(super) fn new(max: usize) -> Self {
        Self {
            state: Mutex::new(JobLimiterState {
                active: 0,
                max: max.max(1),
            }),
            available: Condvar::new(),
        }
    }

    fn acquire(&self) -> JobPermit<'_> {
        let mut state = self.state.lock().expect("job limiter lock poisoned");
        while state.active >= state.max {
            state = self
                .available
                .wait(state)
                .expect("job limiter lock poisoned while waiting");
        }
        state.active += 1;
        JobPermit { limiter: self }
    }
}

impl Drop for JobPermit<'_> {
    fn drop(&mut self) {
        let mut state = self
            .limiter
            .state
            .lock()
            .expect("job limiter lock poisoned while releasing");
        state.active = state.active.saturating_sub(1);
        self.limiter.available.notify_one();
    }
}

enum WorkerEvent {
    Log(String),
    Paused {
        runner_name: String,
        job_display_name: String,
        workflow_file: String,
        signal: PausedSignal,
    },
}

type WaveWorkerEvent = ConcurrentWorkerEvent<JobExecutionOutcome, WorkerEvent>;
type WaveWorkerTx = std::sync::mpsc::Sender<WaveWorkerEvent>;

pub(super) fn execute_wave_jobs(
    shared: Arc<SharedExecutionContext>,
    wave_jobs: Vec<WaveJob>,
    max_jobs: usize,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    json_mode: bool,
) -> Result<Vec<JobExecutionOutcome>, String> {
    let jobs = wave_jobs
        .into_iter()
        .map(|wave_job| (wave_job.index, wave_job))
        .collect::<Vec<_>>();
    let outcomes = run_concurrent_workers(
        max_jobs,
        jobs,
        {
            let shared = Arc::clone(&shared);
            move |_index, wave_job, tx| match execute_wave_job(Arc::clone(&shared), wave_job, tx) {
                Ok(outcome) => Ok(outcome),
                Err(error) => {
                    let (job, err) = *error;
                    Ok(failed_outcome_for_job(&shared.workflow, &job, &err))
                }
            }
        },
        |event| match event {
            WorkerEvent::Log(message) => {
                let _ = write!(stderr, "{message}");
            }
            WorkerEvent::Paused {
                runner_name,
                job_display_name,
                workflow_file,
                signal,
            } => emit_pause_event(
                stdout,
                stderr,
                json_mode,
                &runner_name,
                &job_display_name,
                &workflow_file,
                signal,
            ),
        },
    )?;
    Ok(outcomes.into_iter().map(|(_, outcome)| outcome).collect())
}

fn execute_wave_job(
    shared: Arc<SharedExecutionContext>,
    wave_job: WaveJob,
    tx: &WaveWorkerTx,
) -> Result<JobExecutionOutcome, Box<(PlannedJob, String)>> {
    let job = wave_job.job.clone();
    let _permit = shared.job_limiter.as_ref().map(|limiter| limiter.acquire());
    let result = match wave_job.route {
        JobExecutionRoute::Linux => execute_linux_wave_job(Arc::clone(&shared), wave_job, tx),
        JobExecutionRoute::MacOs => execute_macos_wave_job(Arc::clone(&shared), wave_job, tx),
        JobExecutionRoute::Skip { reason } => Err(format!("unexpected skipped job: {reason}")),
    };
    result.map_err(|err| Box::new((job, err)))
}

fn execute_macos_wave_job(
    shared: Arc<SharedExecutionContext>,
    wave_job: WaveJob,
    tx: &WaveWorkerTx,
) -> Result<JobExecutionOutcome, String> {
    let mut stderr = Vec::new();
    let result = execute_macos_planned_job(MacosExecutionContext {
        run_plan: &shared.run_plan,
        workflow: &shared.workflow,
        job: &wave_job.job,
        working_dir: &shared.working_dir,
        logs_dir: &shared.logs_dir,
        process_env: &shared.process_env,
        github_repo: &shared.github_repo,
        dtu_url: &shared.dtu_url,
        dtu_control_token: &shared.dtu_control_token,
        dtu_port: &shared.dtu_port,
        needs_context: wave_job.needs_context,
        stderr: &mut stderr,
    })?;
    if !stderr.is_empty() {
        let _ = tx.send(ConcurrentWorkerEvent::Worker(WorkerEvent::Log(
            String::from_utf8_lossy(&stderr).into_owned(),
        )));
    }
    Ok(outcome_for_job(&wave_job.job, result, None))
}

fn execute_linux_wave_job(
    shared: Arc<SharedExecutionContext>,
    wave_job: WaveJob,
    tx: &WaveWorkerTx,
) -> Result<JobExecutionOutcome, String> {
    let job = &wave_job.job;
    let image = shared
        .image
        .clone()
        .ok_or_else(|| "runner image was not initialized".to_owned())?;
    let docker_socket = shared
        .docker_socket
        .clone()
        .ok_or_else(|| "docker socket was not initialized".to_owned())?;

    let log_context = create_log_context(
        &shared.working_dir,
        &shared.logs_dir,
        "local-ci",
        Some(&job.runner_name),
    )
    .map_err(|err| err.to_string())?;
    let dirs = create_rust_run_directories(
        &shared.working_dir,
        &log_context.run_dir,
        &shared.github_repo,
    )?;
    write_git_shim(&dirs.shims_dir, &shared.run_plan.effective_sha.head_sha)?;
    sync_worktree_to_workspace(&shared.run_plan.repo_root, &dirs.workspace_dir)?;
    init_fake_git_repo(&dirs.workspace_dir, &shared.github_repo)?;
    chmod_tree_best_effort(&dirs.container_work_dir);
    chmod_tree_best_effort(&dirs.diag_dir);

    let runner_work_dir_override = if job.container.is_some() {
        ensure_docker_vm_runner_externals(&image)?;
        Some(prepare_docker_vm_work_dir(&dirs.container_work_dir)?)
    } else {
        None
    };
    let runner_work_dir = runner_work_dir_override
        .as_deref()
        .map(str::to_owned)
        .unwrap_or_else(|| dirs.container_work_dir.to_string_lossy().into_owned());

    let mut execution_plan = runner_execution_plan_for_job(
        &shared.workflow,
        job,
        image,
        log_context.log_dir.clone(),
        dirs.signals_dir.clone(),
        shared.run_plan.pause_on_failure,
    );
    if job.container.is_some() {
        execution_plan.services.clear();
    }
    execution_plan.env = build_container_env(&ContainerEnvOpts {
        container_name: job.runner_name.clone(),
        registration_token: "mock-registration-token".to_owned(),
        repo_url: shared.repo_url.clone(),
        docker_api_url: shared.docker_api_url.clone(),
        github_repo: shared.github_repo.clone(),
        head_sha: Some(shared.run_plan.effective_sha.head_sha.clone()),
        dtu_host: shared.dtu_host.clone(),
        use_direct_container: false,
    });
    execution_plan.binds = build_container_binds(&ContainerBindsOpts {
        host_work_dir: runner_work_dir.clone(),
        shims_dir: dirs.shims_dir.to_string_lossy().into_owned(),
        signals_dir: shared
            .run_plan
            .pause_on_failure
            .then(|| dirs.signals_dir.to_string_lossy().into_owned()),
        diag_dir: dirs.diag_dir.to_string_lossy().into_owned(),
        tool_cache_dir: dirs.tool_cache_dir.to_string_lossy().into_owned(),
        pnpm_store_dir: Some(dirs.pnpm_store_dir.to_string_lossy().into_owned()),
        npm_cache_dir: Some(dirs.npm_cache_dir.to_string_lossy().into_owned()),
        yarn_cache_dir: Some(dirs.yarn_cache_dir.to_string_lossy().into_owned()),
        bun_cache_dir: Some(dirs.bun_cache_dir.to_string_lossy().into_owned()),
        playwright_cache_dir: dirs.playwright_cache_dir.to_string_lossy().into_owned(),
        cypress_cache_dir: Some(dirs.cypress_cache_dir.to_string_lossy().into_owned()),
        host_runner_dir: dirs.host_runner_dir.to_string_lossy().into_owned(),
        use_direct_container: false,
        github_repo: shared.github_repo.clone(),
        docker_socket_path: (!docker_socket.bind_mount_path.is_empty())
            .then_some(docker_socket.bind_mount_path.clone()),
    });
    execution_plan.extra_hosts = shared.extra_hosts.clone();
    execution_plan.command = build_container_cmd(&ContainerCmdOpts {
        dtu_port: shared.dtu_port.clone(),
        dtu_host: shared.dtu_host.clone(),
        use_direct_container: false,
        container_name: job.runner_name.clone(),
    });

    let mut seed = dtu_job_seed_for_planned_job(
        &shared.run_plan,
        &shared.workflow,
        job,
        shared.github_repo.clone(),
        wave_job.needs_context,
    );
    if shared.run_plan.pause_on_failure && job.container.is_none() {
        wrap_pause_on_failure_steps(&mut seed.steps);
    }
    if let Some(runner_work_dir) = &runner_work_dir_override {
        seed.runner_work_dir = Some(PathBuf::from(runner_work_dir));
    }
    add_dtu_host_to_job_container_options(&mut seed, &shared.dtu_host);

    let workflow_file = workflow_file_name(&shared.workflow);
    let _ = tx.send(ConcurrentWorkerEvent::Worker(WorkerEvent::Log(format!(
        "[Local CI] Starting runner {} ({} > {})\n  Logs: {}\n  DTU: {}\n",
        job.runner_name,
        workflow_file,
        job.display_name,
        execution_plan.log_dir.display(),
        shared.dtu_container_url,
    ))));

    let mut dtu_client =
        DtuHttpClient::with_control_token(&shared.dtu_url, &shared.dtu_control_token);
    let mut docker_runtime = DockerCliRuntime::default();
    let runner_name = job.runner_name.clone();
    let job_display_name = job.display_name.clone();
    let mut on_pause = |signal: PausedSignal| {
        let _ = tx.send(ConcurrentWorkerEvent::Worker(WorkerEvent::Paused {
            runner_name: runner_name.clone(),
            job_display_name: job_display_name.clone(),
            workflow_file: workflow_file.clone(),
            signal,
        }));
    };
    let result = execute_registered_runner_job_with_pause_observer(
        &mut dtu_client,
        &mut docker_runtime,
        &execution_plan,
        &seed,
        &mut on_pause,
    )?;
    Ok(outcome_for_job(job, result, Some(&execution_plan.log_dir)))
}

fn add_dtu_host_to_job_container_options(
    seed: &mut local_ci_runtime::runner::DtuJobSeed,
    dtu_host: &str,
) {
    let Some(container) = seed.container.as_mut() else {
        return;
    };
    if dtu_host.parse::<std::net::IpAddr>().is_ok() {
        return;
    }
    let add_host = format!("--add-host {dtu_host}:host-gateway");
    if container
        .options
        .as_deref()
        .is_some_and(|options| options.contains(&add_host))
    {
        return;
    }
    container.options = Some(
        container
            .options
            .as_deref()
            .map(str::trim)
            .filter(|options| !options.is_empty())
            .map_or(add_host.clone(), |options| format!("{options} {add_host}")),
    );
}

fn outcome_for_job(
    job: &PlannedJob,
    result: JobResult,
    log_dir: Option<&Path>,
) -> JobExecutionOutcome {
    let status = if result.succeeded {
        JobResultStatus::Success
    } else {
        JobResultStatus::Failure
    };
    let output_dir = log_dir.or_else(|| result.debug_log_path.as_deref().and_then(Path::parent));
    let mut step_outputs = output_dir.map(read_step_outputs).unwrap_or_default();
    let static_context = ExpressionContext {
        inputs: job.inputs.clone(),
        matrix: job.matrix_context.clone().unwrap_or_default(),
        ..ExpressionContext::default()
    };
    step_outputs.extend(
        extract_static_step_outputs(job)
            .into_iter()
            .map(|(key, value)| (key, expand_expressions(&value, &static_context))),
    );
    let outputs = resolve_job_outputs(&job.outputs, &step_outputs);
    JobExecutionOutcome {
        schedule_key: schedule_key(job),
        result,
        status,
        outputs,
    }
}

fn failed_outcome_for_job(
    workflow: &WorkflowRunPlan,
    job: &PlannedJob,
    err: &str,
) -> JobExecutionOutcome {
    JobExecutionOutcome {
        schedule_key: schedule_key(job),
        result: JobResult {
            name: job.display_name.clone(),
            workflow: workflow_file_name(workflow),
            succeeded: false,
            paused: false,
            duration_ms: 0,
            failed_step: Some(format!("failed to execute job: {err}")),
            debug_log_path: None,
            steps: Vec::new(),
        },
        status: JobResultStatus::Failure,
        outputs: BTreeMap::new(),
    }
}

fn workflow_file_name(workflow: &WorkflowRunPlan) -> String {
    workflow
        .workflow_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workflow.yml")
        .to_owned()
}
