use super::*;

pub fn plan_run(args: &RunArgs, current_dir: &Path) -> Result<RunPlan, RunDiscoveryError> {
    if args.run_all {
        return plan_all_workflows(args, current_dir);
    }

    let discovery = discover_workflow_run(args, current_dir)?;
    Ok(RunPlan {
        repo_root: discovery.repo_root.clone(),
        effective_sha: discovery.effective_sha.clone(),
        selection: RunSelection::SingleWorkflow,
        workflows: vec![plan_workflow_with_reusable_expansion(
            &discovery.workflow_path,
            &discovery.repo_root,
            1,
            args.no_matrix,
            &args.github_token,
        )?],
        pause_on_failure: args.pause_on_failure,
        no_matrix: args.no_matrix,
        max_jobs: args.max_jobs,
    })
}

pub fn plan_all_workflows(
    args: &RunArgs,
    current_dir: &Path,
) -> Result<RunPlan, RunDiscoveryError> {
    let discovery = discover_all_workflows(current_dir)?;
    let effective_sha = resolve_effective_sha(&discovery.repo_root, args.sha.as_deref())?;
    let mut workflows = Vec::new();

    for (index, path) in discovery.relevant.iter().enumerate() {
        workflows.push(plan_workflow_with_reusable_expansion(
            path,
            &discovery.repo_root,
            (index + 1) as u32,
            args.no_matrix,
            &args.github_token,
        )?);
    }

    Ok(RunPlan {
        repo_root: discovery.repo_root,
        effective_sha,
        selection: RunSelection::AllRelevant {
            branch: discovery.branch,
            changed_files: discovery.changed_files,
            skipped: discovery.skipped,
        },
        workflows,
        pause_on_failure: args.pause_on_failure,
        no_matrix: args.no_matrix,
        max_jobs: args.max_jobs,
    })
}

fn plan_workflow_with_reusable_expansion(
    workflow_path: &Path,
    repo_root: &Path,
    base_run_num: u32,
    no_matrix: bool,
    github_token: &crate::cli::GithubTokenFlag,
) -> Result<WorkflowRunPlan, RunDiscoveryError> {
    let cache_dir = std::env::temp_dir().join("local-ci-rust-remote-workflows");
    let token = resolve_github_token(github_token);
    let remote_cache = prefetch_remote_workflows(
        workflow_path,
        &cache_dir,
        token.as_deref(),
        &CommandRemoteWorkflowFetcher,
    )
    .map_err(|err| RunDiscoveryError::WorkflowParse(err.to_string()))?;
    let entries = expand_reusable_jobs(workflow_path, repo_root, Some(&remote_cache))
        .map_err(|err| RunDiscoveryError::WorkflowParse(err.to_string()))?;
    let root_workflow = parse_workflow_file(workflow_path)?;
    let diagnostics = root_workflow
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.message.clone())
        .collect::<Vec<_>>();
    let mut jobs = Vec::new();

    for (job_index, entry) in entries.into_iter().enumerate() {
        append_planned_jobs_for_entry(&mut jobs, &entry, base_run_num, job_index, no_matrix)?;
    }

    let schedule = try_schedule_job_waves(&jobs).map_err(RunDiscoveryError::WorkflowParse)?;
    Ok(WorkflowRunPlan {
        workflow_path: workflow_path.to_path_buf(),
        diagnostics,
        jobs,
        schedule,
    })
}

fn append_planned_jobs_for_entry(
    jobs: &mut Vec<PlannedJob>,
    entry: &ExpandedJobEntry,
    base_run_num: u32,
    job_index: usize,
    no_matrix: bool,
) -> Result<(), RunDiscoveryError> {
    let workflow = parse_workflow_file(&entry.workflow_path)?;
    let job = workflow.jobs.get(&entry.source_task_name).ok_or_else(|| {
        RunDiscoveryError::WorkflowParse(format!(
            "job '{}' not found in {}",
            entry.source_task_name,
            entry.workflow_path.display()
        ))
    })?;
    let env = merged_job_env(&workflow, job);
    let contexts = parse_matrix_def(job)
        .map(|matrix| {
            matrix_contexts(&matrix, no_matrix)
                .into_iter()
                .map(Some)
                .collect()
        })
        .unwrap_or_else(|| vec![None]);
    let mut inputs = entry.input_defaults.clone().unwrap_or_default();
    inputs.extend(entry.inputs.clone().unwrap_or_default());

    for context in contexts {
        jobs.push(PlannedJob {
            id: entry.id.clone(),
            source_job_id: entry.source_task_name.clone(),
            display_name: entry.caller_job_id.as_ref().map_or_else(
                || job.name.clone().unwrap_or_else(|| entry.id.clone()),
                |_| entry.id.clone(),
            ),
            runner_name: runner_name(base_run_num, job_index, context.as_ref()),
            target: planned_job_target(job),
            needs: entry.needs.clone(),
            if_condition: job.if_condition.clone(),
            outputs: job.outputs.clone(),
            workflow_call_output_defs: entry.workflow_call_output_defs.clone().unwrap_or_default(),
            caller_job_id: entry.caller_job_id.clone(),
            services: planned_services(job),
            container: planned_container(job),
            steps: planned_steps(&workflow, job, &env),
            step_count: job.steps.len(),
            env: env.clone(),
            inputs: inputs.clone(),
            matrix_context: context,
        });
    }

    Ok(())
}

struct CommandRemoteWorkflowFetcher;

impl RemoteWorkflowFetcher for CommandRemoteWorkflowFetcher {
    fn fetch(
        &self,
        reference: &RemoteWorkflowRef,
        github_token: Option<&str>,
    ) -> Result<String, RemoteFetchError> {
        if let Some(token) = github_token.filter(|token| !token.trim().is_empty()) {
            return fetch_remote_workflow_with_gh(reference, Some(token));
        }
        fetch_remote_workflow_raw(reference)
            .or_else(|_| fetch_remote_workflow_with_gh(reference, None))
    }
}

fn resolve_github_token(flag: &crate::cli::GithubTokenFlag) -> Option<String> {
    match flag {
        crate::cli::GithubTokenFlag::Value(value) => Some(value.clone()),
        crate::cli::GithubTokenFlag::Auto => crate::env::effective_var("LOCAL_CI_GITHUB_TOKEN")
            .ok_or(std::env::VarError::NotPresent)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(gh_auth_token),
        crate::cli::GithubTokenFlag::Absent => crate::env::effective_var("LOCAL_CI_GITHUB_TOKEN")
            .ok_or(std::env::VarError::NotPresent)
            .ok()
            .filter(|value| !value.trim().is_empty()),
    }
}

fn gh_auth_token() -> Option<String> {
    let output = Command::new("gh").args(["auth", "token"]).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn fetch_remote_workflow_raw(reference: &RemoteWorkflowRef) -> Result<String, RemoteFetchError> {
    let url = format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        reference.owner, reference.repo, reference.ref_name, reference.path
    );
    let output = Command::new("curl")
        .args(["-fsSL", &url])
        .output()
        .map_err(|err| RemoteFetchError {
            status: None,
            message: format!("failed to run curl: {err}"),
        })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(RemoteFetchError {
            status: output
                .status
                .code()
                .and_then(|code| u16::try_from(code).ok()),
            message: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

fn fetch_remote_workflow_with_gh(
    reference: &RemoteWorkflowRef,
    github_token: Option<&str>,
) -> Result<String, RemoteFetchError> {
    let endpoint = format!(
        "repos/{}/{}/contents/{}?ref={}",
        reference.owner, reference.repo, reference.path, reference.ref_name
    );
    let mut command = Command::new("gh");
    command.args(["api", &endpoint, "--jq", ".content"]);
    if let Some(token) = github_token {
        command.env("GH_TOKEN", token);
    }
    let output = command.output().map_err(|err| RemoteFetchError {
        status: None,
        message: format!("failed to run gh: {err}"),
    })?;
    if !output.status.success() {
        return Err(RemoteFetchError {
            status: None,
            message: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    let encoded = String::from_utf8_lossy(&output.stdout)
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    let decoded = Command::new("python3")
        .args([
            "-c",
            "import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write as _;
                stdin.write_all(encoded.as_bytes())?;
            }
            child.wait_with_output()
        })
        .map_err(|err| RemoteFetchError {
            status: None,
            message: format!("failed to decode workflow content: {err}"),
        })?;
    if decoded.status.success() {
        Ok(String::from_utf8_lossy(&decoded.stdout).into_owned())
    } else {
        Err(RemoteFetchError {
            status: None,
            message: String::from_utf8_lossy(&decoded.stderr).trim().to_owned(),
        })
    }
}

pub(super) fn current_macos_vm_host_capability() -> HostCapability {
    let capability = check_macos_vm_host(
        std::env::consts::OS,
        std::env::consts::ARCH,
        command_exists("tart"),
        command_exists("sshpass"),
    );
    host_capability_from_macos(&capability)
}

pub(super) fn host_capability_from_macos(capability: &MacosHostCapability) -> HostCapability {
    match capability {
        MacosHostCapability::Supported => HostCapability::Supported,
        MacosHostCapability::Unsupported { reason, hint } => HostCapability::Unsupported {
            reason: reason.clone(),
            hint: hint.clone(),
        },
    }
}

pub(super) fn command_exists(command: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {command} >/dev/null 2>&1")])
        .status()
        .is_ok_and(|status| status.success())
}

pub(super) fn read_step_outputs(log_dir: &Path) -> BTreeMap<String, String> {
    fs::read_to_string(log_dir.join("outputs.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .map(|object| {
            object
                .into_iter()
                .map(|(key, value)| (key, json_value_to_string(&value)))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn json_value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Null => String::new(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            serde_json::to_string(value).unwrap_or_default()
        }
    }
}
