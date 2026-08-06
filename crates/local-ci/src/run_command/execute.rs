use super::*;
use std::sync::Arc;

pub(super) fn write_plan_summary(plan: &RunPlan, stdout: &mut impl Write) {
    match &plan.selection {
        RunSelection::SingleWorkflow => {
            let Some(workflow) = plan.workflows.first() else {
                return;
            };
            let job_count = workflow.jobs.len();
            let _ = writeln!(
                stdout,
                "[Local CI] Discovered {job_count} job(s) in {} at {}.",
                workflow.workflow_path.display(),
                plan.effective_sha.head_sha
            );
            for job in &workflow.jobs {
                let target = format_planned_target(&job.target);
                let _ = writeln!(stdout, "  - {} ({target})", job.id);
            }
        }
        RunSelection::AllRelevant { branch, .. } => {
            let _ = writeln!(
                stdout,
                "[Local CI] Discovered {} relevant workflow(s) for branch '{}'.",
                plan.workflows.len(),
                branch
            );
            for workflow in &plan.workflows {
                let _ = writeln!(stdout, "  - {}", workflow.workflow_path.display());
            }
        }
    }
}

pub(super) fn print_human_summary(
    results: &[JobResult],
    run_dir: Option<&Path>,
    repo_root: &Path,
    working_dir: &Path,
    env: &BTreeMap<String, String>,
    stdout: &mut impl Write,
) {
    let failures = results
        .iter()
        .filter(|result| !result.succeeded)
        .collect::<Vec<_>>();
    let passes = results
        .iter()
        .filter(|result| result.succeeded)
        .collect::<Vec<_>>();
    let total_ms = results.iter().map(|result| result.duration_ms).sum::<u64>();

    if !failures.is_empty() {
        let _ = writeln!(
            stdout,
            "\n━━━ FAILURES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        );
        let mut groups = Vec::<(String, Vec<&JobResult>)>::new();
        for failure in failures {
            let content = failure_content(failure);
            if let Some((_, failures)) =
                groups.iter_mut().find(|(existing, _)| *existing == content)
            {
                failures.push(failure);
            } else {
                groups.push((content, vec![failure]));
            }
        }
        for (content, failures) in groups {
            for failure in &failures {
                if let Some(step) = &failure.failed_step {
                    let _ = writeln!(
                        stdout,
                        "  ✗ {} > {} > \"{}\"",
                        failure.workflow, failure.name, step
                    );
                } else {
                    let _ = writeln!(stdout, "  ✗ {} > {}", failure.workflow, failure.name);
                }
            }
            if !content.is_empty() {
                let _ = writeln!(stdout, "\n{}", content.trim_end());
            }
            if let Some(hint) = failure_hint(&content, repo_root, working_dir, env) {
                let _ = writeln!(stdout, "\n{hint}");
            }
            let _ = writeln!(stdout);
        }
    }

    let _ = writeln!(
        stdout,
        "\n━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    );
    let status = if results.iter().any(|result| !result.succeeded) {
        format!(
            "✗ {} failed, {} passed",
            results.len() - passes.len(),
            passes.len()
        )
    } else {
        format!("✓ {} passed", passes.len())
    };
    let _ = writeln!(stdout, "  Status:    {status} ({} total)", results.len());
    let _ = writeln!(stdout, "  Duration:  {}", format_duration(total_ms));
    if let Some(run_dir) = run_dir {
        let _ = writeln!(stdout, "  Root:      {}", run_dir.display());
    }
    let _ = writeln!(stdout);
}

pub(super) fn failure_content(result: &JobResult) -> String {
    if let Some(failed_step) = &result.failed_step
        && let Some(path) = result
            .steps
            .iter()
            .find(|step| step.name == *failed_step)
            .and_then(|step| step.log_path.as_ref())
        && let Ok(content) = fs::read_to_string(path)
    {
        return content;
    }
    result
        .debug_log_path
        .as_ref()
        .and_then(|path| tail_log_file(path, 20))
        .unwrap_or_default()
}

pub(super) fn tail_log_file(path: &Path, line_count: usize) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let mut lines = content.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let start = lines.len().saturating_sub(line_count);
    Some(format!("{}\n", lines[start..].join("\n")))
}

pub(super) fn failure_hint(
    content: &str,
    repo_root: &Path,
    working_dir: &Path,
    env: &BTreeMap<String, String>,
) -> Option<String> {
    let tool_cache_dir = working_dir.join("cache/toolcache");
    detect_runner_image_toolcache_hint(content, tool_cache_dir.to_str()).or_else(|| {
        let resolved = discover_runner_image(
            repo_root,
            env.get("LOCAL_CI_RUNNER_IMAGE").map(String::as_str),
        );
        detect_runner_image_missing_tool_hint(content, &resolved)
    })
}

pub(super) fn format_duration(ms: u64) -> String {
    let seconds = (ms + 500) / 1000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    let remaining = seconds % 60;
    if remaining > 0 {
        format!("{minutes}m {remaining}s")
    } else {
        format!("{minutes}m")
    }
}

pub(super) fn execute_run_plan(
    plan: &RunPlan,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    json_mode: bool,
) -> i32 {
    match execute_run_plan_inner(plan, stdout, stderr, json_mode) {
        Ok(status) => status,
        Err(err) => {
            let _ = writeln!(stderr, "[Local CI] Error: {err}");
            1
        }
    }
}

fn execute_workflow_with_shared(
    shared: Arc<SharedExecutionContext>,
    macos_capability: &HostCapability,
    max_jobs: usize,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    json_mode: bool,
) -> Result<Vec<JobResult>, String> {
    let workflow = shared.workflow.clone();
    let mut completed_results = BTreeMap::<String, JobResultStatus>::new();
    let mut completed_outputs = BTreeMap::<String, BTreeMap<String, String>>::new();
    let mut job_results = Vec::<JobResult>::new();

    for wave in &workflow.schedule {
        let mut wave_jobs = Vec::new();

        for (index, scheduled) in wave.iter().enumerate() {
            let Some(job) = workflow
                .jobs
                .iter()
                .find(|job| schedule_key(job) == *scheduled)
            else {
                continue;
            };

            match decide_job_run_with_jobs(job, &workflow.jobs, &completed_results) {
                JobRunDecision::Run => {}
                JobRunDecision::Skip { .. } => {
                    completed_results.insert(schedule_key(job), JobResultStatus::Skipped);
                    continue;
                }
            }

            let route = execution_route_for_job(job, macos_capability);
            if let JobExecutionRoute::Skip { reason } = route {
                let _ = writeln!(
                    stderr,
                    "[Local CI] Skipping '{}': {reason}",
                    job.display_name
                );
                completed_results.insert(schedule_key(job), JobResultStatus::Skipped);
                continue;
            }

            wave_jobs.push(WaveJob {
                index,
                job: job.clone(),
                route,
                needs_context: needs_context_for_planned_job(
                    job,
                    &workflow.jobs,
                    &completed_results,
                    &completed_outputs,
                ),
            });
        }

        if wave_jobs.is_empty() {
            continue;
        }

        let outcomes = execute_wave_jobs(
            Arc::clone(&shared),
            wave_jobs,
            max_jobs,
            stdout,
            stderr,
            json_mode,
        )?;

        for outcome in outcomes {
            record_completed_outcome(
                &workflow,
                outcome,
                &mut completed_results,
                &mut completed_outputs,
                &mut job_results,
            );
        }
        resolve_workflow_call_outputs(&workflow, &mut completed_results, &mut completed_outputs);
    }

    Ok(job_results)
}

fn needs_context_for_planned_job(
    job: &PlannedJob,
    all_jobs: &[PlannedJob],
    completed_results: &BTreeMap<String, JobResultStatus>,
    completed_outputs: &BTreeMap<String, BTreeMap<String, String>>,
) -> BTreeMap<String, NeedContext> {
    let mut context =
        needs_context_for_job_with_jobs(job, all_jobs, completed_results, completed_outputs);
    for need in &job.needs {
        let Some((caller_job_id, _)) = need.split_once('/') else {
            continue;
        };
        if context.contains_key(caller_job_id) {
            continue;
        }
        if let Some(outputs) = completed_outputs.get(caller_job_id) {
            let result = completed_results
                .get(caller_job_id)
                .copied()
                .unwrap_or(JobResultStatus::Success)
                .as_github_result()
                .to_owned();
            context.insert(
                caller_job_id.to_owned(),
                NeedContext {
                    result,
                    outputs: outputs.clone(),
                },
            );
        }
    }
    context
}

fn record_completed_outcome(
    workflow: &WorkflowRunPlan,
    outcome: JobExecutionOutcome,
    completed_results: &mut BTreeMap<String, JobResultStatus>,
    completed_outputs: &mut BTreeMap<String, BTreeMap<String, String>>,
    job_results: &mut Vec<JobResult>,
) {
    let outcome_key = outcome.schedule_key.clone();
    completed_outputs.insert(outcome_key.clone(), outcome.outputs);
    completed_results.insert(outcome_key.clone(), outcome.status);
    if let Some(job) = workflow
        .jobs
        .iter()
        .find(|job| schedule_key(job) == outcome_key)
    {
        let outputs = completed_outputs
            .get(&outcome_key)
            .cloned()
            .unwrap_or_default();
        completed_outputs.entry(job.id.clone()).or_insert(outputs);
    }
    job_results.push(outcome.result);
}

fn resolve_workflow_call_outputs(
    workflow: &WorkflowRunPlan,
    completed_results: &mut BTreeMap<String, JobResultStatus>,
    completed_outputs: &mut BTreeMap<String, BTreeMap<String, String>>,
) {
    let caller_ids = workflow
        .jobs
        .iter()
        .filter_map(|job| job.caller_job_id.clone())
        .collect::<std::collections::BTreeSet<_>>();

    for caller_job_id in caller_ids {
        if completed_outputs.contains_key(&caller_job_id) {
            continue;
        }
        let sub_jobs = workflow
            .jobs
            .iter()
            .filter(|job| job.caller_job_id.as_deref() == Some(caller_job_id.as_str()))
            .collect::<Vec<_>>();
        if sub_jobs.is_empty()
            || !sub_jobs
                .iter()
                .all(|job| completed_results.contains_key(&schedule_key(job)))
        {
            continue;
        }
        let Some(output_defs) = sub_jobs
            .iter()
            .find(|job| !job.workflow_call_output_defs.is_empty())
            .map(|job| &job.workflow_call_output_defs)
        else {
            continue;
        };
        let mut resolved = BTreeMap::new();
        for (name, expression) in output_defs {
            resolved.insert(
                name.clone(),
                resolve_workflow_call_output(expression, &caller_job_id, completed_outputs),
            );
        }
        let status = if sub_jobs
            .iter()
            .all(|job| completed_results.get(&schedule_key(job)) == Some(&JobResultStatus::Success))
        {
            JobResultStatus::Success
        } else {
            JobResultStatus::Failure
        };
        completed_outputs.insert(caller_job_id.clone(), resolved);
        completed_results.insert(caller_job_id, status);
    }
}

fn resolve_workflow_call_output(
    expression: &str,
    caller_job_id: &str,
    completed_outputs: &BTreeMap<String, BTreeMap<String, String>>,
) -> String {
    let mut output = String::new();
    let mut rest = expression;
    while let Some(start) = rest.find("${{") {
        output.push_str(&rest[..start]);
        let after_start = &rest[start + 3..];
        let Some(end) = after_start.find("}}") else {
            output.push_str(&rest[start..]);
            return output;
        };
        let token = after_start[..end].trim();
        output.push_str(&resolve_workflow_call_output_token(
            token,
            caller_job_id,
            completed_outputs,
        ));
        rest = &after_start[end + 2..];
    }
    output.push_str(rest);
    output
}

fn resolve_workflow_call_output_token(
    token: &str,
    caller_job_id: &str,
    completed_outputs: &BTreeMap<String, BTreeMap<String, String>>,
) -> String {
    let Some(token) = token.strip_prefix("jobs.") else {
        return String::new();
    };
    let mut parts = token.split('.');
    let Some(job_id) = parts.next() else {
        return String::new();
    };
    if parts.next() != Some("outputs") {
        return String::new();
    }
    let Some(output_name) = parts.next() else {
        return String::new();
    };
    let composite_id = format!("{caller_job_id}/{job_id}");
    completed_outputs
        .get(&composite_id)
        .and_then(|outputs| outputs.get(output_name))
        .cloned()
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn execute_all_workflows_parallel_shared(
    plan: &RunPlan,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    json_mode: bool,
    process_env: &BTreeMap<String, String>,
    working_dir: &Path,
    logs_dir: &Path,
    github_repo: &str,
    dtu_url: &str,
    dtu_container_url: &str,
    dtu_control_token: &str,
    dtu_port: &str,
    docker_api_url: &str,
    repo_url: &str,
    dtu_host: &str,
    macos_capability: &HostCapability,
    max_jobs: usize,
) -> Result<(i32, Vec<JobResult>), String> {
    let requires_linux = plan.workflows.iter().any(|workflow| {
        workflow.jobs.iter().any(|job| {
            matches!(
                execution_route_for_job(job, macos_capability),
                JobExecutionRoute::Linux
            )
        })
    });

    let mut docker_runtime = DockerCliRuntime::default();
    let (image, docker_socket, extra_hosts) = if requires_linux {
        let resolved = discover_runner_image(
            &plan.repo_root,
            process_env.get("LOCAL_CI_RUNNER_IMAGE").map(String::as_str),
        );
        (
            Some(ensure_runner_image(&mut docker_runtime, &resolved)?),
            Some(
                resolve_docker_socket(&DockerSocketProbe::from_process())
                    .map_err(|err| err.to_string())?,
            ),
            resolve_docker_extra_hosts(process_env, dtu_host).unwrap_or_default(),
        )
    } else {
        (None, None, Vec::new())
    };

    let workflows = plan
        .workflows
        .iter()
        .cloned()
        .enumerate()
        .collect::<Vec<_>>();
    let plan_for_workers = plan.clone();
    let process_env_for_workers = process_env.clone();
    let working_dir = working_dir.to_path_buf();
    let logs_dir = logs_dir.to_path_buf();
    let github_repo = github_repo.to_owned();
    let dtu_url = dtu_url.to_owned();
    let dtu_container_url = dtu_container_url.to_owned();
    let dtu_control_token = dtu_control_token.to_owned();
    let dtu_port = dtu_port.to_owned();
    let docker_api_url = docker_api_url.to_owned();
    let repo_url = repo_url.to_owned();
    let dtu_host = dtu_host.to_owned();
    let macos_capability = macos_capability.clone();
    let job_limiter = Arc::new(SharedJobLimiter::new(max_jobs));

    let outcomes = local_ci_runtime::wave::run_concurrent_workers(
        workflows.len().max(1),
        workflows,
        move |_, workflow, _tx| {
            let shared = Arc::new(SharedExecutionContext {
                run_plan: plan_for_workers.clone(),
                workflow,
                working_dir: working_dir.clone(),
                logs_dir: logs_dir.clone(),
                process_env: process_env_for_workers.clone(),
                github_repo: github_repo.clone(),
                dtu_url: dtu_url.clone(),
                dtu_container_url: dtu_container_url.clone(),
                dtu_control_token: dtu_control_token.clone(),
                dtu_port: dtu_port.clone(),
                docker_api_url: docker_api_url.clone(),
                repo_url: repo_url.clone(),
                dtu_host: dtu_host.clone(),
                job_limiter: Some(Arc::clone(&job_limiter)),
                image: image.clone(),
                docker_socket: docker_socket.clone(),
                extra_hosts: extra_hosts.clone(),
            });
            let mut out = Vec::new();
            let mut err = Vec::new();
            let job_results = match execute_workflow_with_shared(
                shared,
                &macos_capability,
                max_jobs,
                &mut out,
                &mut err,
                json_mode,
            ) {
                Ok(job_results) => job_results,
                Err(error) => {
                    let _ = writeln!(err, "[Local CI] Error: {error}");
                    return Ok((1, out, err, Vec::new()));
                }
            };
            let status = if job_results.iter().any(|result| !result.succeeded) {
                1
            } else {
                0
            };
            Ok((status, out, err, job_results))
        },
        |_: ()| {},
    )?;

    let mut status = 0;
    let mut job_results = Vec::new();
    for (_, (workflow_status, out, err, mut workflow_results)) in outcomes {
        if workflow_status != 0 {
            status = 1;
        }
        stdout.write_all(&out).map_err(|err| err.to_string())?;
        stderr.write_all(&err).map_err(|err| err.to_string())?;
        job_results.append(&mut workflow_results);
    }

    Ok((status, job_results))
}

pub(super) fn execute_run_plan_inner(
    plan: &RunPlan,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    json_mode: bool,
) -> Result<i32, String> {
    let started_at = event_timestamp();
    let process_env = crate::env::effective_process_env();
    let home = crate::env::effective_var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let state_env = StateDirEnv::from_env(&process_env);
    let state_dir = resolve_state_dir(&state_env, std::env::consts::OS, &home);
    let logs_dir = resolve_logs_dir(&state_env, std::env::consts::OS, &home);
    let working_dir = default_working_dir(&plan.repo_root);
    fs::create_dir_all(&working_dir).map_err(|err| err.to_string())?;
    fs::create_dir_all(&logs_dir).map_err(|err| err.to_string())?;

    let dtu_host = resolve_dtu_host(&process_env);
    let mut dtu = Some(
        start_ephemeral_dtu_with_log_root(
            working_dir.join("cache/dtu"),
            &logs_dir,
            Some(&dtu_host),
        )
        .map_err(|err| format!("failed to start DTU: {err}"))?,
    );
    let dtu_ref = dtu.as_ref().expect("DTU just started");
    let dtu_url = dtu_ref.url.clone();
    let dtu_container_url = dtu_ref.container_url.clone();
    let dtu_control_token = dtu_ref.control_token.clone();
    let dtu_port = dtu_ref.port.to_string();
    let docker_api_url = resolve_docker_api_url(&dtu_url, &dtu_host);

    let github_repo = resolve_github_repo(&plan.repo_root);
    let repo_url = format!("{docker_api_url}/{github_repo}");
    let branch = run_result_branch(plan);
    let mut docker_runtime = DockerCliRuntime::default();
    let mut image: Option<String> = None;
    let mut docker_socket: Option<DockerSocket> = None;
    let mut extra_hosts: Option<Vec<String>> = None;
    let macos_capability = current_macos_vm_host_capability();
    let max_jobs = plan
        .max_jobs
        .map_or_else(default_max_concurrent_jobs, |value| {
            usize::try_from(value).unwrap_or(usize::MAX).max(1)
        });

    if matches!(plan.selection, RunSelection::AllRelevant { .. }) && plan.workflows.len() > 1 {
        let (status, job_results) = execute_all_workflows_parallel_shared(
            plan,
            stdout,
            stderr,
            json_mode,
            &process_env,
            &working_dir,
            &logs_dir,
            &github_repo,
            &dtu_url,
            &dtu_container_url,
            &dtu_control_token,
            &dtu_port,
            &docker_api_url,
            &repo_url,
            &dtu_host,
            &macos_capability,
            max_jobs,
        )?;

        if !json_mode {
            print_human_summary(
                &job_results,
                Some(&working_dir),
                &plan.repo_root,
                &working_dir,
                &process_env,
                stdout,
            );
        }

        let finished_at = event_timestamp();
        let _ = write_run_result(
            &RunResultInput {
                repo: github_repo,
                branch,
                worktree_path: plan.repo_root.clone(),
                head_sha: plan.effective_sha.head_sha.clone(),
                started_at,
                finished_at,
                results: job_results.iter().map(job_result_input).collect(),
            },
            Some(&state_dir),
        );

        if let Some(dtu) = dtu.take() {
            dtu.close();
        }
        return Ok(status);
    }

    let mut completed_results = BTreeMap::<String, JobResultStatus>::new();
    let mut completed_outputs = BTreeMap::<String, BTreeMap<String, String>>::new();
    let mut job_results = Vec::<JobResult>::new();
    let mut any_failed = false;

    for workflow in &plan.workflows {
        for wave in &workflow.schedule {
            let mut wave_jobs = Vec::new();

            for (index, scheduled) in wave.iter().enumerate() {
                let Some(job) = workflow
                    .jobs
                    .iter()
                    .find(|job| schedule_key(job) == *scheduled)
                else {
                    continue;
                };

                match decide_job_run_with_jobs(job, &workflow.jobs, &completed_results) {
                    JobRunDecision::Run => {}
                    JobRunDecision::Skip { .. } => {
                        completed_results.insert(schedule_key(job), JobResultStatus::Skipped);
                        continue;
                    }
                }

                let route = execution_route_for_job(job, &macos_capability);
                if let JobExecutionRoute::Skip { reason } = route {
                    let _ = writeln!(
                        stderr,
                        "[Local CI] Skipping '{}': {reason}",
                        job.display_name
                    );
                    completed_results.insert(schedule_key(job), JobResultStatus::Skipped);
                    continue;
                }

                wave_jobs.push(WaveJob {
                    index,
                    job: job.clone(),
                    route,
                    needs_context: needs_context_for_planned_job(
                        job,
                        &workflow.jobs,
                        &completed_results,
                        &completed_outputs,
                    ),
                });
            }

            if wave_jobs.is_empty() {
                continue;
            }

            if wave_jobs
                .iter()
                .any(|wave_job| matches!(wave_job.route, JobExecutionRoute::Linux))
            {
                if image.is_none() {
                    let resolved = discover_runner_image(
                        &plan.repo_root,
                        process_env.get("LOCAL_CI_RUNNER_IMAGE").map(String::as_str),
                    );
                    image = Some(ensure_runner_image(&mut docker_runtime, &resolved)?);
                }
                if docker_socket.is_none() {
                    docker_socket = Some(
                        resolve_docker_socket(&DockerSocketProbe::from_process())
                            .map_err(|err| err.to_string())?,
                    );
                }
                if extra_hosts.is_none() {
                    extra_hosts = Some(
                        resolve_docker_extra_hosts(&process_env, &dtu_host).unwrap_or_default(),
                    );
                }
            }

            let shared = Arc::new(SharedExecutionContext {
                run_plan: plan.clone(),
                workflow: workflow.clone(),
                working_dir: working_dir.clone(),
                logs_dir: logs_dir.clone(),
                process_env: process_env.clone(),
                github_repo: github_repo.clone(),
                dtu_url: dtu_url.clone(),
                dtu_container_url: dtu_container_url.clone(),
                dtu_control_token: dtu_control_token.clone(),
                dtu_port: dtu_port.clone(),
                docker_api_url: docker_api_url.clone(),
                repo_url: repo_url.clone(),
                dtu_host: dtu_host.clone(),
                job_limiter: None,
                image: image.clone(),
                docker_socket: docker_socket.clone(),
                extra_hosts: extra_hosts.clone().unwrap_or_default(),
            });

            let outcomes =
                execute_wave_jobs(shared, wave_jobs, max_jobs, stdout, stderr, json_mode)?;

            for outcome in outcomes {
                any_failed |= !outcome.result.succeeded;
                record_completed_outcome(
                    workflow,
                    outcome,
                    &mut completed_results,
                    &mut completed_outputs,
                    &mut job_results,
                );
            }
            resolve_workflow_call_outputs(workflow, &mut completed_results, &mut completed_outputs);
        }
    }

    if !json_mode {
        print_human_summary(
            &job_results,
            Some(&working_dir),
            &plan.repo_root,
            &working_dir,
            &process_env,
            stdout,
        );
    }

    let finished_at = event_timestamp();
    let _ = write_run_result(
        &RunResultInput {
            repo: github_repo,
            branch,
            worktree_path: plan.repo_root.clone(),
            head_sha: plan.effective_sha.head_sha.clone(),
            started_at,
            finished_at,
            results: job_results.iter().map(job_result_input).collect(),
        },
        Some(&state_dir),
    );

    if let Some(dtu) = dtu.take() {
        dtu.close();
    }
    Ok(if any_failed { 1 } else { 0 })
}
