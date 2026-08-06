use super::*;

pub(super) struct MacosExecutionContext<'a, W: Write> {
    pub(super) run_plan: &'a RunPlan,
    pub(super) workflow: &'a WorkflowRunPlan,
    pub(super) job: &'a PlannedJob,
    pub(super) working_dir: &'a Path,
    pub(super) logs_dir: &'a Path,
    pub(super) process_env: &'a BTreeMap<String, String>,
    pub(super) github_repo: &'a str,
    pub(super) dtu_url: &'a str,
    pub(super) dtu_control_token: &'a str,
    pub(super) dtu_port: &'a str,
    pub(super) needs_context: BTreeMap<String, NeedContext>,
    pub(super) stderr: &'a mut W,
}

pub(super) fn execute_macos_planned_job(
    ctx: MacosExecutionContext<'_, impl Write>,
) -> Result<JobResult, String> {
    let run_plan = ctx.run_plan;
    let workflow = ctx.workflow;
    let job = ctx.job;
    let working_dir = ctx.working_dir;
    let logs_dir = ctx.logs_dir;
    let process_env = ctx.process_env;
    let github_repo = ctx.github_repo;
    let dtu_url = ctx.dtu_url;
    let dtu_control_token = ctx.dtu_control_token;
    let dtu_port = ctx.dtu_port;
    let needs_context = ctx.needs_context;
    let stderr = ctx.stderr;
    let log_context = create_log_context(
        working_dir,
        logs_dir,
        "local-ci-macos",
        Some(&job.runner_name),
    )
    .map_err(|err| err.to_string())?;
    let labels = macos_labels_for_job(job);
    let image_resolution = resolve_macos_vm_image(
        &labels,
        process_env
            .get("LOCAL_CI_MACOS_VM_IMAGE")
            .map(String::as_str),
    );
    if !image_resolution.exact {
        let _ = writeln!(
            stderr,
            "[Local CI] warning: could not map runs-on {:?} to a known macOS image; falling back to {}",
            labels, image_resolution.image
        );
    }

    let remote_runner_dir = process_env
        .get("LOCAL_CI_MACOS_VM_RUNNER_DIR")
        .cloned()
        .unwrap_or_else(|| "/Users/admin/local-ci-runner".to_owned());
    let remote_work_dir = format!("{remote_runner_dir}/_work");
    let repo_name = github_repo.split('/').next_back().unwrap_or("repo");
    let remote_workspace = format!("{remote_work_dir}/{repo_name}/{repo_name}");
    let remote_log_dir = format!("/Users/admin/local-ci-logs/{}", job.runner_name);
    let dtu_vm_url = format!("http://127.0.0.1:{dtu_port}/{github_repo}");
    let creds = SshCreds {
        user: process_env
            .get("LOCAL_CI_MACOS_VM_USER")
            .cloned()
            .unwrap_or_else(|| "admin".to_owned()),
        password: process_env
            .get("LOCAL_CI_MACOS_VM_PASSWORD")
            .cloned()
            .unwrap_or_else(|| "admin".to_owned()),
        reverse_tunnel: Some(format!("{dtu_port}:127.0.0.1:{dtu_port}")),
    };

    let version = resolve_macos_runner_version(
        process_env
            .get("LOCAL_CI_MACOS_RUNNER_VERSION")
            .map(String::as_str),
    );
    let mut binary_io = CommandRunnerBinaryIo;
    let cached_runner = ensure_macos_runner_binary(
        &mut binary_io,
        &working_dir.join("cache/macos-runner"),
        &version,
    )?;
    let local_runner_dir = log_context.run_dir.join("macos-runner");
    prepare_local_macos_runner_dir(
        &cached_runner.dir,
        &local_runner_dir,
        &job.runner_name,
        &dtu_vm_url,
    )?;

    let mut seed =
        dtu_job_seed_for_planned_job(run_plan, workflow, job, github_repo, needs_context);
    seed.runner_work_dir = Some(PathBuf::from(&remote_work_dir));
    seed.runner_os = Some("macOS".to_owned());
    seed.runner_arch = Some("ARM64".to_owned());
    let mut dtu_client = DtuHttpClient::with_control_token(dtu_url, dtu_control_token);
    dtu_client.register_runner(&DtuRunnerRegistration {
        runner_name: job.runner_name.clone(),
        log_dir: log_context.log_dir.clone(),
        timeline_dir: log_context.log_dir.clone(),
        virtual_cache_patterns: Vec::new(),
    })?;
    dtu_client.seed_job(&seed)?;

    let _ = writeln!(
        stderr,
        "[Local CI] Starting macOS VM runner {} ({} > {})",
        job.runner_name,
        workflow
            .workflow_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workflow.yml"),
        job.display_name
    );
    let _ = writeln!(stderr, "  Logs: {}", log_context.log_dir.display());

    let vm_plan = MacosVmJobPlan {
        vm_name: job.runner_name.clone(),
        image: image_resolution.image,
        repo_root: run_plan.repo_root.clone(),
        local_runner_dir,
        remote_workspace,
        remote_runner_dir: remote_runner_dir.clone(),
        remote_log_dir,
        local_log_dir: log_context.log_dir.clone(),
        creds,
        dtu_url: dtu_vm_url,
        runner_token: "mock-registration-token".to_owned(),
        runner_labels: labels,
        job_script: format!("cd {remote_runner_dir} && ./run.sh --once"),
    };
    let started = Instant::now();
    let vm_result = execute_macos_vm_job(&mut CommandMacosVmRuntime::new(), &vm_plan)?;
    let duration_ms = started.elapsed().as_millis() as u64;
    let _ = fs::write(
        &log_context.debug_log_path,
        format!("{}{}", vm_result.stdout, vm_result.stderr),
    );
    let steps = parse_timeline_steps(&log_context.log_dir.join("timeline.json"));
    let timeline_failed = steps.iter().any(|step| step.status == StepStatus::Failed);
    let succeeded = vm_result.code == 0 && !timeline_failed && !steps.is_empty();
    let failed_step = steps
        .iter()
        .find(|step| step.status == StepStatus::Failed)
        .map(|step| step.name.clone())
        .or_else(|| (!succeeded).then(|| "unknown".to_owned()));

    Ok(JobResult {
        name: job.id.clone(),
        workflow: workflow
            .workflow_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workflow.yml")
            .to_owned(),
        succeeded,
        paused: false,
        duration_ms,
        failed_step,
        debug_log_path: Some(log_context.debug_log_path),
        steps,
    })
}

pub(super) fn prepare_local_macos_runner_dir(
    cached_runner_dir: &Path,
    local_runner_dir: &Path,
    runner_name: &str,
    repo_url: &str,
) -> Result<(), String> {
    let _ = fs::remove_dir_all(local_runner_dir);
    copy_dir_recursive(cached_runner_dir, local_runner_dir)?;
    write_macos_runner_credentials(local_runner_dir, runner_name, repo_url)
}

pub(super) fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|err| err.to_string())?;
    for entry in fs::read_dir(source).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &destination_path)?;
        } else if file_type.is_symlink() {
            copy_symlink_or_target(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|err| err.to_string())?;
            chmod_best_effort(&destination_path);
        }
    }
    chmod_best_effort(destination);
    Ok(())
}

pub(super) fn copy_symlink_or_target(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            fs::read_link(source).map_err(|err| err.to_string())?,
            destination,
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::copy(source, destination).map_err(|err| err.to_string())?;
        chmod_best_effort(destination);
        Ok(())
    }
}

pub(super) fn write_macos_runner_credentials(
    runner_dir: &Path,
    runner_name: &str,
    repo_url: &str,
) -> Result<(), String> {
    let server_url = url_origin(repo_url).unwrap_or_else(|| repo_url.to_owned());
    let runner = serde_json::json!({
        "agentId": 1,
        "agentName": runner_name,
        "poolId": 1,
        "poolName": "Default",
        "serverUrl": server_url,
        "gitHubUrl": repo_url,
        "workFolder": "_work",
        "ephemeral": true,
    });
    let credentials = serde_json::json!({
        "scheme": "OAuth",
        "data": {
            "clientId": "00000000-0000-0000-0000-000000000000",
            "authorizationUrl": format!("{repo_url}/_apis/oauth2/token"),
            "oAuthEndpointUrl": format!("{repo_url}/_apis/oauth2/token"),
            "requireFipsCryptography": "False",
        }
    });
    let rsa_params = serde_json::json!({
        "d": "CQpCI+sO2GD1N/JsHHI9zEhMlu5Fcc8mU4O2bO6iscOsagFjvEnTesJgydC/Go1HuOBlx+GT9EG2h7+juS0z2o5n8Mvt5BBxlK+tqoDOs8VfQ9CSUl3hqYRPeNdBfnA1w8ovLW0wqfPO08FWTLI0urYsnwjZ5BQrBM+D7zYeA0aCsKdo75bKmaEKnmqrtIEhb7hE45XQa32Yt0RPCPi8QcQAY2HLHbdWdZYDj6k/UuDvz9H/xlDzwYq6Yikk2RSMArFzaufxCGS9tBZNEACDPYgnZnEMXRcvsnZ9FYbq81KOSifCmq7Yocq+j3rY5zJCD+PIDY9QJwPxB4PGasRKAQ==",
        "dp": "A0sY1oOz1+3uUMiy+I5xGuHGHOrEQPYspd1xGClBYYsa/Za0UDWS7V0Tn1cbRWfWtNe5vTpxcvwQd6UZBwrtHF6R2zyXFhE++PLPhCe0tH4C5FY9i9jUw9Vo8t44i/s5JUHU2B1mEptXFUA0GcVrLKS8toZSgqELSS2Q/YLRxoE=",
        "dq": "GrLC9dPJ5n3VYw51ghCH7tybUN9/Oe4T8d9v4dLQ34RQEWHwRd4g3U3zkvuhpXFPloUTMmkxS7MF5pS1evrtzkay4QUTDv+28s0xRuAsw5qNTzuFygg8t93MvpvTVZ2TNApW6C7NFvkL9NbxAnU8+I61/3ow7i6a7oYJJ0hWAxE=",
        "exponent": "AQAB",
        "inverseQ": "8DVz9FSvEdt5W4B9OjgakZHwGfnhn2VLDUxrsR5ilC5tPC/IgA8C2xEfKQM1t+K/N3pAYHBYQ6EPgtW4kquBS/Sy102xbRI7GSCnUbRtTpWYPOaCn6EaxBNzwWzbp5vCbCGvFqlSu4+OBYRVe+iCj+gAnkmT/TKPhHHbTjJHvw==",
        "modulus": "x0eoW2DD7xsW5YiorMN8pNHVvZk4ED1SHlA/bmVnRz5FjEDnQloMn0nBgIUHxoNArksknrp/FOVJv5sJHJTiRZkOp+ZmH7d3W3gmw63IxK2C5pV+6xfav9jR2+Wt/6FMYMgG2utBdF95oif1f2XREFovHoXkWms2l0CPLLHVPO44Hh9EEmBmjOeMJEZkulHJ44z9y8e+GZ2nYqO0ZiRWQcRObZ0vlRaGg6PPOl4ltay0BfNksMB3NDtlhkdVkAEFQxEaZZDK9NtkvNljXCioP3TyTAbqNUGsYCA5D+IHGZT9An99J9vUqTFP6TKjqUvy9WNiIzaUksCySA0a4SVBkQ==",
        "p": "8fgAdmWy+sTzAN19fYkWMQqeC7t1BCQMo5z5knfVLg8TtwP9ZGqDtoe+r0bGv3UgVsvvDdP/QwRvRVP+5G9l999Y6b4VbSdUbrfPfOgjpPDmRTQzHDve5jh5xBENQoRXYm7PMgHGmjwuFsE/tKtSGTrvt2Z3qcYAo0IOqLLhYmE=",
        "q": "0tXx4+P7gUWePf92UJLkzhNBClvdnmDbIt52Lui7YCARczbN/asCDJxcMy6Bh3qmIx/bNuOUrfzHkYZHfnRw8AGEK80qmiLLPI6jrUBOGRajmzemGQx0W8FWalEQfGdNIv9R2nsegDRoMq255Zo/qX60xQ6abpp0c6UNhVYSjTE=",
    });
    fs::write(
        runner_dir.join(".runner"),
        serde_json::to_vec_pretty(&runner).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    fs::write(
        runner_dir.join(".credentials"),
        serde_json::to_vec_pretty(&credentials).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    fs::write(
        runner_dir.join(".credentials_rsaparams"),
        serde_json::to_vec(&rsa_params).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(super) fn url_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split('/').next()?;
    Some(format!("{scheme}://{authority}"))
}

pub(super) fn macos_labels_for_job(job: &PlannedJob) -> Vec<String> {
    match &job.target {
        PlannedJobTarget::MacOs { runs_on } => runs_on
            .split(',')
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}
