use super::*;
use local_ci_core::expr::expand_expressions;
use local_ci_core::plan::{
    NeedContext, PlannedJob, RunPlan, WorkflowRunPlan, expression_context_for_job,
    expression_context_for_step,
};

pub fn runner_execution_plan_for_job(
    workflow: &WorkflowRunPlan,
    job: &PlannedJob,
    image: impl Into<String>,
    log_dir: PathBuf,
    signals_dir: PathBuf,
    pause_on_failure: bool,
) -> JobExecutionPlan {
    JobExecutionPlan {
        workflow: workflow
            .workflow_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workflow.yml")
            .to_owned(),
        job_id: job.id.clone(),
        runner_name: job.runner_name.clone(),
        container_name: if pause_on_failure {
            job.runner_name.clone()
        } else {
            format!("{}-{}", job.runner_name, std::process::id())
        },
        image: image.into(),
        env: Vec::new(),
        binds: Vec::new(),
        extra_hosts: Vec::new(),
        command: Vec::new(),
        log_dir,
        signals_dir,
        services: job.services.iter().map(ServiceSpec::from).collect(),
        pause_on_failure,
    }
}

pub fn dtu_job_seed_for_planned_job(
    run_plan: &RunPlan,
    workflow: &WorkflowRunPlan,
    job: &PlannedJob,
    github_repo: impl Into<String>,
    needs_context: BTreeMap<String, NeedContext>,
) -> DtuJobSeed {
    let workflow_name = workflow
        .workflow_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("workflow")
        .to_owned();
    let expression_context = expression_context_for_job(job, &needs_context, &run_plan.repo_root);
    DtuJobSeed {
        id: format!("{}-{}", workflow_name, job.runner_name),
        runner_name: job.runner_name.clone(),
        name: job.display_name.clone(),
        workflow_name,
        repo_root: run_plan.repo_root.clone(),
        github_repo: github_repo.into(),
        head_sha: run_plan
            .effective_sha
            .sha_ref
            .clone()
            .unwrap_or_else(|| run_plan.effective_sha.head_sha.clone()),
        real_head_sha: run_plan.effective_sha.head_sha.clone(),
        runner_work_dir: None,
        runner_os: None,
        runner_arch: None,
        env: job.env.clone(),
        outputs: job.outputs.clone(),
        needs_context,
        container: job.container.as_ref().map(DtuJobContainer::from),
        services: job.services.iter().map(ServiceSpec::from).collect(),
        matrix_context: job.matrix_context.clone(),
        steps: job
            .steps
            .iter()
            .map(|step| {
                let step_expression_context =
                    expression_context_for_step(&expression_context, step);
                DtuJobStep {
                    name: expand_expressions(&step.name, &step_expression_context),
                    context_name: step.id.clone(),
                    run: step
                        .run
                        .as_ref()
                        .map(|run| expand_expressions(run, &step_expression_context)),
                    uses: step.uses.clone(),
                    shell: step.shell.clone(),
                    working_directory: step.working_directory.clone(),
                    condition: step.if_condition.clone(),
                    env: step_expression_context.env,
                    with: step.with.clone(),
                }
            })
            .collect(),
    }
}
