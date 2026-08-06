use crate::expr::{
    ExpressionContext, RunnerContext, evaluate_job_if, expand_expressions,
    uses_status_check_function,
};
use crate::matrix::{MatrixContext, expand_workflow_jobs};
use crate::workflow::{RunsOn, WorkflowDocument, WorkflowJob, WorkflowStep};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunPlan {
    pub repo_root: PathBuf,
    pub effective_sha: EffectiveSha,
    pub selection: RunSelection,
    pub workflows: Vec<WorkflowRunPlan>,
    pub pause_on_failure: bool,
    pub no_matrix: bool,
    pub max_jobs: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunSelection {
    SingleWorkflow,
    AllRelevant {
        branch: String,
        changed_files: Vec<String>,
        skipped: Vec<SkippedWorkflow>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedWorkflow {
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRunPlan {
    pub workflow_path: PathBuf,
    pub diagnostics: Vec<String>,
    pub jobs: Vec<PlannedJob>,
    pub schedule: Vec<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedJob {
    pub id: String,
    pub source_job_id: String,
    pub display_name: String,
    pub runner_name: String,
    pub target: PlannedJobTarget,
    pub needs: Vec<String>,
    pub if_condition: Option<String>,
    pub env: BTreeMap<String, String>,
    pub inputs: BTreeMap<String, String>,
    pub outputs: BTreeMap<String, String>,
    pub workflow_call_output_defs: BTreeMap<String, String>,
    pub caller_job_id: Option<String>,
    pub services: Vec<PlannedService>,
    pub container: Option<PlannedJobContainer>,
    pub steps: Vec<PlannedStep>,
    pub step_count: usize,
    pub matrix_context: Option<MatrixContext>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedStep {
    pub id: Option<String>,
    pub name: String,
    pub index: usize,
    pub run: Option<String>,
    pub uses: Option<String>,
    pub if_condition: Option<String>,
    pub shell: Option<String>,
    pub working_directory: Option<String>,
    pub env: BTreeMap<String, String>,
    pub with: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedService {
    pub id: String,
    pub image: String,
    pub env: Vec<String>,
    pub ports: BTreeMap<String, String>,
    pub options: Option<String>,
    pub health_cmd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedJobContainer {
    pub image: String,
    pub env: BTreeMap<String, String>,
    pub ports: Vec<String>,
    pub volumes: Vec<String>,
    pub options: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlannedJobTarget {
    Linux { runs_on: String },
    MacOs { runs_on: String },
    ReusableWorkflow { uses: String },
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobResultStatus {
    Success,
    Failure,
    Skipped,
    Cancelled,
}

impl JobResultStatus {
    pub const fn as_github_result(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failure => "failure",
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobRunDecision {
    Run,
    Skip { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobExecutionRoute {
    Linux,
    MacOs,
    Skip { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostCapability {
    Supported,
    Unsupported {
        reason: String,
        hint: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveSha {
    pub head_sha: String,
    pub sha_ref: Option<String>,
    pub source: EffectiveShaSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectiveShaSource {
    Explicit,
    DirtyTree,
    Head,
}

pub fn plan_workflow_document(
    workflow: &WorkflowDocument,
    base_run_num: u32,
    no_matrix: bool,
) -> WorkflowRunPlan {
    try_plan_workflow_document(workflow, base_run_num, no_matrix)
        .expect("workflow job dependencies should be acyclic")
}

pub fn try_plan_workflow_document(
    workflow: &WorkflowDocument,
    base_run_num: u32,
    no_matrix: bool,
) -> Result<WorkflowRunPlan, String> {
    let diagnostics = workflow
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.message.clone())
        .collect();
    let jobs = expand_workflow_jobs(workflow, no_matrix, base_run_num)
        .into_iter()
        .filter_map(|expanded| {
            let job = workflow.jobs.get(&expanded.job_id)?;
            let env = merged_job_env(workflow, job);
            Some(PlannedJob {
                id: job.id.clone(),
                source_job_id: job.id.clone(),
                display_name: job.name.clone().unwrap_or_else(|| job.id.clone()),
                runner_name: expanded.runner_name,
                target: planned_job_target(job),
                needs: job.needs.clone(),
                if_condition: job.if_condition.clone(),
                outputs: job.outputs.clone(),
                workflow_call_output_defs: BTreeMap::new(),
                caller_job_id: None,
                services: planned_services(job),
                container: planned_container(job),
                steps: planned_steps(workflow, job, &env),
                step_count: job.steps.len(),
                env,
                inputs: BTreeMap::new(),
                matrix_context: expanded.matrix_context,
            })
        })
        .collect::<Vec<_>>();

    let schedule = try_schedule_job_waves(&jobs)?;

    Ok(WorkflowRunPlan {
        workflow_path: workflow.path.clone(),
        diagnostics,
        jobs,
        schedule,
    })
}

pub fn merged_job_env(workflow: &WorkflowDocument, job: &WorkflowJob) -> BTreeMap<String, String> {
    let mut env = workflow.env.clone();
    env.extend(job.env.clone());
    env
}

pub fn planned_container(job: &WorkflowJob) -> Option<PlannedJobContainer> {
    job.container.as_ref().map(|container| PlannedJobContainer {
        image: container.image.clone(),
        env: container.env.clone(),
        ports: container.ports.clone(),
        volumes: container.volumes.clone(),
        options: container.options.clone(),
    })
}

pub fn planned_services(job: &WorkflowJob) -> Vec<PlannedService> {
    job.services
        .values()
        .map(|service| PlannedService {
            id: service.id.clone(),
            image: service.image.clone(),
            env: service
                .env
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect(),
            ports: service.ports.clone(),
            options: service.options.clone(),
            health_cmd: None,
        })
        .collect()
}

pub fn planned_steps(
    workflow: &WorkflowDocument,
    job: &WorkflowJob,
    job_env: &BTreeMap<String, String>,
) -> Vec<PlannedStep> {
    job.steps
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let mut env = job_env.clone();
            env.extend(step.env.clone());
            PlannedStep {
                id: step.id.clone(),
                name: planned_step_name(step, index),
                index: index + 1,
                run: step.run.clone(),
                uses: step.uses.clone(),
                if_condition: step.if_condition.clone(),
                shell: effective_run_default(workflow, job, step, "shell"),
                working_directory: effective_run_default(workflow, job, step, "working-directory"),
                env,
                with: step.with.clone(),
            }
        })
        .collect()
}

pub fn effective_run_default(
    workflow: &WorkflowDocument,
    job: &WorkflowJob,
    step: &WorkflowStep,
    key: &str,
) -> Option<String> {
    let step_value = match key {
        "shell" => step.shell.clone(),
        "working-directory" => step.working_directory.clone(),
        _ => None,
    };

    step_value
        .or_else(|| run_default_from_value(&job.raw, key))
        .or_else(|| run_default_from_value(&workflow.raw, key))
}

pub fn run_default_from_value(source: &serde_yaml::Value, key: &str) -> Option<String> {
    let defaults = mapping_value(source, "defaults")?;
    let run = mapping_value(defaults, "run")?;
    mapping_value(run, key)
        .and_then(serde_yaml::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub fn mapping_value<'a>(
    source: &'a serde_yaml::Value,
    key: &str,
) -> Option<&'a serde_yaml::Value> {
    source
        .as_mapping()?
        .get(serde_yaml::Value::String(key.to_owned()))
}

pub fn planned_step_name(step: &WorkflowStep, index: usize) -> String {
    step.name
        .clone()
        .or_else(|| step.id.clone())
        .or_else(|| step.uses.clone())
        .or_else(|| {
            step.run
                .as_ref()
                .and_then(|run| run.lines().next().map(str::to_owned))
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("Step {}", index + 1))
}

pub fn planned_job_target(job: &WorkflowJob) -> PlannedJobTarget {
    if let Some(uses) = &job.uses {
        return PlannedJobTarget::ReusableWorkflow { uses: uses.clone() };
    }

    let Some(runs_on) = job.runs_on.as_ref().map(format_runs_on) else {
        return PlannedJobTarget::Unknown;
    };

    if runs_on.to_ascii_lowercase().contains("macos") {
        PlannedJobTarget::MacOs { runs_on }
    } else {
        PlannedJobTarget::Linux { runs_on }
    }
}

pub fn format_runs_on(runs_on: &RunsOn) -> String {
    match runs_on {
        RunsOn::Single(value) => value.clone(),
        RunsOn::Labels(values) => values.join(", "),
        RunsOn::Other(value) => value.clone(),
    }
}

pub fn expression_context_for_job(
    job: &PlannedJob,
    needs_context: &BTreeMap<String, NeedContext>,
    repo_root: &Path,
) -> ExpressionContext {
    let needs = needs_context
        .iter()
        .map(|(job_id, need)| {
            let mut values = need.outputs.clone();
            values.insert("__result".to_owned(), need.result.clone());
            (job_id.clone(), values)
        })
        .collect::<BTreeMap<_, _>>();
    let runner = match &job.target {
        PlannedJobTarget::MacOs { .. } => RunnerContext {
            os: "macOS".to_owned(),
            arch: "ARM64".to_owned(),
        },
        _ => RunnerContext::default(),
    };
    ExpressionContext {
        repo_path: Some(repo_root.to_path_buf()),
        matrix: job.matrix_context.clone().unwrap_or_default(),
        needs,
        runner,
        env: job.env.clone(),
        inputs: job.inputs.clone(),
        ..ExpressionContext::default()
    }
}

pub fn schedule_job_waves(jobs: &[PlannedJob]) -> Vec<Vec<String>> {
    try_schedule_job_waves(jobs).expect("job dependencies should be acyclic")
}

pub fn try_schedule_job_waves(jobs: &[PlannedJob]) -> Result<Vec<Vec<String>>, String> {
    let mut expanded_keys_by_job_id = BTreeMap::<String, Vec<String>>::new();
    for job in jobs {
        expanded_keys_by_job_id
            .entry(job.id.clone())
            .or_default()
            .push(schedule_key(job));
    }

    let mut remaining = jobs
        .iter()
        .map(|job| {
            let dependencies = job
                .needs
                .iter()
                .flat_map(|need| {
                    expanded_keys_by_job_id
                        .get(need)
                        .cloned()
                        .unwrap_or_else(|| vec![need.clone()])
                })
                .collect::<Vec<_>>();
            (schedule_key(job), dependencies)
        })
        .collect::<BTreeMap<_, _>>();
    let mut completed = std::collections::BTreeSet::new();
    let mut waves = Vec::new();

    while !remaining.is_empty() {
        let wave = remaining
            .iter()
            .filter(|(_, needs)| needs.iter().all(|need| completed.contains(need)))
            .map(|(job_id, _)| job_id.clone())
            .collect::<Vec<_>>();

        if wave.is_empty() {
            let cyclic = remaining.keys().cloned().collect::<Vec<_>>().join(", ");
            return Err(format!("cyclic job dependencies: {cyclic}"));
        }

        for job_id in &wave {
            remaining.remove(job_id);
            completed.insert(job_id.clone());
        }
        waves.push(wave);
    }

    Ok(waves)
}

pub fn schedule_key(job: &PlannedJob) -> String {
    if job.matrix_context.is_some() {
        job.runner_name.clone()
    } else {
        job.id.clone()
    }
}

pub fn execution_route_for_job(
    job: &PlannedJob,
    macos_capability: &HostCapability,
) -> JobExecutionRoute {
    match &job.target {
        PlannedJobTarget::Linux { .. } => JobExecutionRoute::Linux,
        PlannedJobTarget::MacOs { runs_on } => match macos_capability {
            HostCapability::Supported => JobExecutionRoute::MacOs,
            HostCapability::Unsupported { reason, hint } => JobExecutionRoute::Skip {
                reason: hint.as_ref().map_or_else(
                    || format!("{runs_on}: {reason}"),
                    |hint| format!("{runs_on}: {reason} {hint}"),
                ),
            },
        },
        PlannedJobTarget::ReusableWorkflow { uses } => JobExecutionRoute::Skip {
            reason: format!("reusable workflow job '{uses}' is expanded before execution"),
        },
        PlannedJobTarget::Unknown => JobExecutionRoute::Skip {
            reason: "unknown or unsupported runner target".to_owned(),
        },
    }
}

pub fn decide_job_run(
    job: &PlannedJob,
    completed_results: &BTreeMap<String, JobResultStatus>,
) -> JobRunDecision {
    decide_job_run_with_jobs(job, std::slice::from_ref(job), completed_results)
}

pub fn decide_job_run_with_jobs(
    job: &PlannedJob,
    all_jobs: &[PlannedJob],
    completed_results: &BTreeMap<String, JobResultStatus>,
) -> JobRunDecision {
    let needs_results = aggregated_needs_results(job, all_jobs, completed_results);
    let default_success = needs_results
        .values()
        .all(|result| *result == JobResultStatus::Success);

    let Some(condition) = job.if_condition.as_deref() else {
        return if default_success {
            JobRunDecision::Run
        } else {
            JobRunDecision::Skip {
                reason: "one or more needed jobs did not succeed".to_owned(),
            }
        };
    };

    let condition = normalize_job_if(condition);
    let status_function_present = contains_status_check_function(condition);
    let job_results = needs_results
        .iter()
        .map(|(job_id, result)| (job_id.clone(), result.as_github_result().to_owned()))
        .collect::<BTreeMap<_, _>>();
    let needs_context = needs_results
        .iter()
        .map(|(job_id, result)| {
            let mut context = BTreeMap::new();
            context.insert("__result".to_owned(), result.as_github_result().to_owned());
            (job_id.clone(), context)
        })
        .collect::<BTreeMap<_, _>>();

    let condition_allows = evaluate_job_if(condition, &job_results, &needs_context);
    let should_run = if status_function_present {
        condition_allows
    } else {
        default_success && condition_allows
    };

    if should_run {
        JobRunDecision::Run
    } else {
        JobRunDecision::Skip {
            reason: format!("job condition evaluated to false: {condition}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeedContext {
    pub result: String,
    pub outputs: BTreeMap<String, String>,
}

pub fn expression_context_for_step(
    base: &ExpressionContext,
    step: &PlannedStep,
) -> ExpressionContext {
    let mut raw_env_context = base.clone();
    raw_env_context.env = step.env.clone();
    let env = step
        .env
        .iter()
        .map(|(key, value)| (key.clone(), expand_expressions(value, &raw_env_context)))
        .collect::<BTreeMap<_, _>>();

    let mut context = base.clone();
    context.env = env;
    context
}

pub fn needs_context_for_job(
    job: &PlannedJob,
    completed_results: &BTreeMap<String, JobResultStatus>,
    completed_outputs: &BTreeMap<String, BTreeMap<String, String>>,
) -> BTreeMap<String, NeedContext> {
    needs_context_for_job_with_jobs(
        job,
        std::slice::from_ref(job),
        completed_results,
        completed_outputs,
    )
}

pub fn needs_context_for_job_with_jobs(
    job: &PlannedJob,
    all_jobs: &[PlannedJob],
    completed_results: &BTreeMap<String, JobResultStatus>,
    completed_outputs: &BTreeMap<String, BTreeMap<String, String>>,
) -> BTreeMap<String, NeedContext> {
    job.needs
        .iter()
        .map(|need| {
            let result = aggregate_need_result(need, all_jobs, completed_results)
                .as_github_result()
                .to_owned();
            let outputs = aggregate_need_outputs(need, all_jobs, completed_outputs);
            (need.clone(), NeedContext { result, outputs })
        })
        .collect()
}

pub fn aggregated_needs_results(
    job: &PlannedJob,
    all_jobs: &[PlannedJob],
    completed_results: &BTreeMap<String, JobResultStatus>,
) -> BTreeMap<String, JobResultStatus> {
    job.needs
        .iter()
        .map(|need| {
            (
                need.clone(),
                aggregate_need_result(need, all_jobs, completed_results),
            )
        })
        .collect()
}

pub fn aggregate_need_result(
    need: &str,
    all_jobs: &[PlannedJob],
    completed_results: &BTreeMap<String, JobResultStatus>,
) -> JobResultStatus {
    let leg_results = all_jobs
        .iter()
        .filter(|job| job.id == need)
        .map(schedule_key)
        .map(|key| {
            completed_results
                .get(&key)
                .copied()
                .unwrap_or(JobResultStatus::Skipped)
        })
        .collect::<Vec<_>>();

    if leg_results.is_empty() {
        completed_results
            .get(need)
            .copied()
            .unwrap_or(JobResultStatus::Skipped)
    } else {
        aggregate_matrix_status(&leg_results)
    }
}

pub fn aggregate_matrix_status(legs: &[JobResultStatus]) -> JobResultStatus {
    if legs.is_empty() {
        return JobResultStatus::Skipped;
    }
    if legs.contains(&JobResultStatus::Failure) {
        return JobResultStatus::Failure;
    }
    if legs.contains(&JobResultStatus::Cancelled) {
        return JobResultStatus::Cancelled;
    }
    if legs.contains(&JobResultStatus::Skipped) {
        return JobResultStatus::Skipped;
    }
    JobResultStatus::Success
}

fn aggregate_need_outputs(
    need: &str,
    all_jobs: &[PlannedJob],
    completed_outputs: &BTreeMap<String, BTreeMap<String, String>>,
) -> BTreeMap<String, String> {
    let mut outputs = BTreeMap::new();
    let mut found_leg = false;
    for key in all_jobs
        .iter()
        .filter(|job| job.id == need)
        .map(schedule_key)
    {
        found_leg = true;
        if let Some(leg_outputs) = completed_outputs.get(&key) {
            outputs.extend(leg_outputs.clone());
        }
    }
    if !found_leg {
        outputs.extend(completed_outputs.get(need).cloned().unwrap_or_default());
    }
    outputs
}

pub fn extract_static_step_outputs(job: &PlannedJob) -> BTreeMap<String, String> {
    let mut outputs = BTreeMap::new();
    for run in job.steps.iter().filter_map(|step| step.run.as_deref()) {
        for line in run.lines() {
            if let Some((key, value)) = parse_github_output_echo(line) {
                outputs.insert(key, value);
            }
        }
    }
    outputs
}

pub fn parse_github_output_echo(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if !trimmed.contains("GITHUB_OUTPUT") {
        return None;
    }
    let (left, _) = trimmed.split_once(">>")?;
    let mut value = left.trim();
    value = value.strip_prefix("echo")?.trim();
    if let Some(rest) = value.strip_prefix("-e") {
        value = rest.trim();
    }
    value = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
        .trim();
    let (key, output_value) = value.split_once('=')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    Some((key.to_owned(), output_value.to_owned()))
}

pub fn resolve_job_outputs(
    output_defs: &BTreeMap<String, String>,
    step_outputs: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    output_defs
        .iter()
        .map(|(name, template)| {
            (
                name.clone(),
                resolve_step_output_template(template, step_outputs),
            )
        })
        .collect()
}

pub fn resolve_step_output_template(
    template: &str,
    step_outputs: &BTreeMap<String, String>,
) -> String {
    let mut remaining = template;
    let mut out = String::new();
    while let Some(start) = remaining.find("${{") {
        out.push_str(&remaining[..start]);
        let after_start = &remaining[start + 3..];
        let Some(end) = after_start.find("}}") else {
            out.push_str(&remaining[start..]);
            return out;
        };
        let expr = after_start[..end].trim();
        out.push_str(&resolve_step_output_expr(expr, step_outputs));
        remaining = &after_start[end + 2..];
    }
    out.push_str(remaining);
    out
}

pub fn resolve_step_output_expr(expr: &str, step_outputs: &BTreeMap<String, String>) -> String {
    let parts = expr.split('.').collect::<Vec<_>>();
    if parts.len() == 4 && parts[0] == "steps" && parts[2] == "outputs" {
        return step_outputs.get(parts[3]).cloned().unwrap_or_default();
    }
    String::new()
}

pub fn normalize_job_if(condition: &str) -> &str {
    let trimmed = condition.trim();
    trimmed
        .strip_prefix("${{")
        .and_then(|value| value.strip_suffix("}}"))
        .map(str::trim)
        .unwrap_or(trimmed)
}

pub fn contains_status_check_function(condition: &str) -> bool {
    uses_status_check_function(condition)
}

#[cfg(test)]
mod tests;
