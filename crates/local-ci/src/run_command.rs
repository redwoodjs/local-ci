use crate::RunArgs;
use crate::env::resolve_repo_root;
use crate::state::{
    JobResultInput, RunResultInput, StateDirEnv, StepResultInput,
    StepResultStatus as StateStepResultStatus, create_log_context, resolve_logs_dir,
    resolve_state_dir, write_run_result,
};
use local_ci_core::matrix::{matrix_contexts, parse_matrix_def, runner_name};
pub use local_ci_core::plan::{
    EffectiveSha, EffectiveShaSource, HostCapability, JobExecutionRoute, JobResultStatus,
    JobRunDecision, NeedContext, PlannedJob, PlannedJobContainer, PlannedJobTarget, PlannedService,
    PlannedStep, RunPlan, RunSelection, SkippedWorkflow, WorkflowRunPlan, decide_job_run,
    decide_job_run_with_jobs, execution_route_for_job, expression_context_for_job,
    expression_context_for_step, extract_static_step_outputs, format_runs_on, merged_job_env,
    needs_context_for_job, needs_context_for_job_with_jobs, plan_workflow_document,
    planned_container, planned_job_target, planned_services, planned_steps, resolve_job_outputs,
    schedule_job_waves, schedule_key, try_plan_workflow_document, try_schedule_job_waves,
};
use local_ci_core::reusable::{
    ExpandedJobEntry, RemoteFetchError, RemoteWorkflowFetcher, RemoteWorkflowRef,
    expand_reusable_jobs, prefetch_remote_workflows,
};
use local_ci_core::workflow::{
    WorkflowDocument, WorkflowParseError, extract_events, is_workflow_relevant, parse_workflow_file,
};
use local_ci_runtime::docker::{
    ContainerBindsOpts, ContainerCmdOpts, ContainerEnvOpts, DockerCliRuntime, DockerSocket,
    DockerSocketProbe, build_container_binds, build_container_cmd, build_container_env,
    resolve_docker_api_url, resolve_docker_extra_hosts, resolve_docker_socket,
};
use local_ci_runtime::dtu::{DtuHttpClient, start_ephemeral_dtu_with_log_root};
use local_ci_runtime::macos_vm::{
    CommandMacosVmRuntime, CommandRunnerBinaryIo, HostCapability as MacosHostCapability,
    MacosVmJobPlan, SshCreds, check_macos_vm_host, ensure_macos_runner_binary,
    execute_macos_vm_job, resolve_macos_runner_version, resolve_macos_vm_image,
};
use local_ci_runtime::runner::{
    DtuControlPlane, DtuRunnerRegistration, JobResult, PausedSignal, StepStatus,
    execute_registered_runner_job_with_pause_observer, parse_timeline_steps,
    wrap_pause_on_failure_steps,
};
use local_ci_runtime::runner_image::{
    detect_missing_tool_hint as detect_runner_image_missing_tool_hint,
    detect_toolcache_hint as detect_runner_image_toolcache_hint, discover_runner_image,
    ensure_runner_image,
};
use local_ci_runtime::workspace::sync_worktree_to_workspace;
use std::collections::BTreeMap;
use std::fs;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowDiscovery {
    pub workflow_path: PathBuf,
    pub repo_root: PathBuf,
    pub effective_sha: EffectiveSha,
    pub jobs: Vec<RunnableJob>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllWorkflowDiscovery {
    pub repo_root: PathBuf,
    pub branch: String,
    pub changed_files: Vec<String>,
    pub relevant: Vec<PathBuf>,
    pub skipped: Vec<SkippedWorkflow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnableJob {
    pub id: String,
    pub display_name: String,
    pub runs_on: Option<String>,
    pub uses: Option<String>,
    pub step_count: usize,
}

pub fn run_run_command(args: RunArgs, stdout: &mut impl Write, stderr: &mut impl Write) -> i32 {
    if should_launch_detached(&args) {
        return run_detached_launcher(stdout, stderr);
    }

    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    match plan_run(&args, &current_dir) {
        Ok(plan) => {
            let json_mode = json_mode_enabled(&args);
            let sentinel_mode = json_mode || is_detached_worker();
            if json_mode {
                emit_run_start_event(&plan, stdout);
            }

            if plan.workflows.is_empty() {
                if let RunSelection::AllRelevant { branch, .. } = &plan.selection {
                    if !json_mode {
                        let _ = writeln!(
                            stdout,
                            "[Local CI] No relevant workflows found for branch '{branch}'."
                        );
                    }
                    if sentinel_mode {
                        emit_run_finish_event("passed", stdout);
                    }
                    return 0;
                }
            }

            if !json_mode {
                write_plan_summary(&plan, stdout);
            }
            let exit_code = execute_run_plan(&plan, stdout, stderr, sentinel_mode);
            if sentinel_mode {
                emit_run_finish_event(if exit_code == 0 { "passed" } else { "failed" }, stdout);
            }
            exit_code
        }
        Err(err) => {
            let _ = writeln!(stderr, "[Local CI] Error: {err}");
            1
        }
    }
}

mod discovery;
mod events;
mod execute;
mod host;
mod macos_job;
mod plan;
mod wave;

use discovery::*;
use events::*;
use execute::*;
use host::*;
use local_ci_runtime::wave::default_max_concurrent_jobs;
use macos_job::*;
use plan::*;
use wave::*;

pub use discovery::{
    RunDiscoveryError, discover_all_workflows, discover_relevant_workflows, discover_workflow_run,
    get_changed_files, resolve_effective_sha, runnable_jobs,
};
pub use events::job_lifecycle_events;
pub use local_ci_runtime::runner::{dtu_job_seed_for_planned_job, runner_execution_plan_for_job};
pub use plan::{plan_all_workflows, plan_run};

#[cfg(test)]
mod tests;
