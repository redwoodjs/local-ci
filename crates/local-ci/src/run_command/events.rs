use super::*;

pub(super) fn json_mode_enabled(args: &RunArgs) -> bool {
    args.json || crate::env::effective_var("LOCAL_CI_JSON").is_some_and(|value| value == "1")
}

pub(super) fn agent_mode_enabled(args: &RunArgs) -> bool {
    args.quiet || crate::env::effective_var("AI_AGENT").is_some_and(|value| value == "1")
}

pub(super) fn is_detached_worker() -> bool {
    crate::env::effective_var_os(DETACHED_ENV)
        .is_some_and(|value| PathBuf::from(value).is_absolute())
}

pub(super) fn is_force_detached_requested() -> bool {
    crate::env::effective_var_os(DETACHED_ENV)
        .is_some_and(|value| !PathBuf::from(value).is_absolute())
}

pub(super) fn should_launch_detached(args: &RunArgs) -> bool {
    if is_detached_worker() || !args.pause_on_failure || agent_mode_enabled(args) {
        return false;
    }
    is_force_detached_requested() || !std::io::stdout().is_terminal()
}

pub(super) fn run_detached_launcher(stdout: &mut impl Write, stderr: &mut impl Write) -> i32 {
    let log_path = match detached_worker_log_path() {
        Ok(path) => path,
        Err(err) => {
            let _ = writeln!(
                stderr,
                "[Local CI] Error: failed to create launcher log: {err}"
            );
            return 1;
        }
    };
    let log_file = match fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(file) => file,
        Err(err) => {
            let _ = writeln!(
                stderr,
                "[Local CI] Error: failed to open launcher log: {err}"
            );
            return 1;
        }
    };
    let stderr_file = match log_file.try_clone() {
        Ok(file) => file,
        Err(err) => {
            let _ = writeln!(
                stderr,
                "[Local CI] Error: failed to clone launcher log: {err}"
            );
            return 1;
        }
    };
    let current_exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(err) => {
            let _ = writeln!(
                stderr,
                "[Local CI] Error: failed to resolve current executable: {err}"
            );
            return 1;
        }
    };

    let mut command = Command::new(current_exe);
    command
        .args(std::env::args_os().skip(1))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr_file))
        .env(DETACHED_ENV, &log_path);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            let _ = writeln!(
                stderr,
                "[Local CI] Error: failed to launch detached worker: {err}"
            );
            return 1;
        }
    };

    tail_detached_worker(&log_path, &mut child, stdout)
}

pub(super) fn detached_worker_log_path() -> Result<PathBuf, String> {
    let env = crate::env::effective_process_env();
    let home = crate::env::effective_var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let state_dir = resolve_state_dir(&StateDirEnv::from_env(&env), std::env::consts::OS, &home);
    let launcher_dir = state_dir.join("launchers");
    fs::create_dir_all(&launcher_dir).map_err(|err| err.to_string())?;
    Ok(launcher_dir.join(format!(
        "worker-{}-{}.log",
        now_millis(),
        std::process::id()
    )))
}

pub(super) fn tail_detached_worker(
    log_path: &Path,
    child: &mut std::process::Child,
    stdout: &mut impl Write,
) -> i32 {
    let mut offset = 0_u64;
    let mut buffer = String::new();
    let mut drained_after_exit = false;

    loop {
        if let Ok((new_offset, chunk)) = read_log_chunk(log_path, offset) {
            offset = new_offset;
            buffer.push_str(&chunk);
        }

        while let Some(index) = buffer.find('\n') {
            let line = buffer[..index].to_owned();
            buffer = buffer[index + 1..].to_owned();
            if let Some(event) = parse_log_event(&line) {
                match event.get("event").and_then(serde_json::Value::as_str) {
                    Some("run.paused") => {
                        let _ = writeln!(stdout, "{line}");
                        write_pause_hint(stdout, &event, log_path);
                        return PAUSED_EXIT_CODE;
                    }
                    Some("run.finish") => {
                        let _ = writeln!(stdout, "{line}");
                        return if event.get("status").and_then(serde_json::Value::as_str)
                            == Some("passed")
                        {
                            0
                        } else {
                            1
                        };
                    }
                    Some(_) => continue,
                    None => {}
                }
            }
            let _ = writeln!(stdout, "{line}");
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                if drained_after_exit {
                    if !buffer.is_empty() {
                        let _ = write!(stdout, "{buffer}");
                    }
                    return status.code().unwrap_or(1);
                }
                drained_after_exit = true;
            }
            Ok(None) => {}
            Err(_) => return 1,
        }

        thread::sleep(Duration::from_millis(100));
    }
}

pub(super) fn read_log_chunk(path: &Path, offset: u64) -> Result<(u64, String), String> {
    use std::io::{Read, Seek};
    let mut file = fs::File::open(path).map_err(|err| err.to_string())?;
    let len = file.metadata().map_err(|err| err.to_string())?.len();
    if len <= offset {
        return Ok((offset, String::new()));
    }
    file.seek(std::io::SeekFrom::Start(offset))
        .map_err(|err| err.to_string())?;
    let mut bytes = Vec::with_capacity((len - offset) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    Ok((len, String::from_utf8_lossy(&bytes).into_owned()))
}

pub(super) fn parse_log_event(line: &str) -> Option<serde_json::Value> {
    if !line.starts_with('{') {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
    let event = value.get("event").and_then(serde_json::Value::as_str)?;
    matches!(
        event,
        "run.start"
            | "run.finish"
            | "run.paused"
            | "job.start"
            | "job.finish"
            | "step.start"
            | "step.finish"
            | "diagnostic"
    )
    .then_some(value)
}

pub(super) fn write_pause_hint(
    stdout: &mut impl Write,
    event: &serde_json::Value,
    log_path: &Path,
) {
    let runner = event
        .get("runner")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("<unknown>");
    let retry_cmd = event
        .get("retry_cmd")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("local-ci retry --name {runner}"));
    let _ = writeln!(
        stdout,
        "[Local CI] Job paused. Worker continues in background.\n           Resume with: {retry_cmd}\n           Or abort with: local-ci abort --name {runner}\n           Live log: {}",
        log_path.display()
    );
}

pub(super) fn emit_run_start_event(plan: &RunPlan, stdout: &mut impl Write) {
    let mut event = serde_json::json!({
        "event": "run.start",
        "ts": event_timestamp(),
        "schemaVersion": EVENT_SCHEMA_VERSION,
        "runId": format!("run-{}", now_millis()),
    });
    if let RunSelection::AllRelevant { branch, .. } = &plan.selection {
        event["branch"] = serde_json::Value::String(branch.clone());
    }
    emit_json_event(stdout, event);
}

pub(super) fn emit_run_finish_event(status: &str, stdout: &mut impl Write) {
    emit_json_event(
        stdout,
        serde_json::json!({
            "event": "run.finish",
            "ts": event_timestamp(),
            "status": status,
        }),
    );
}

pub(super) fn emit_pause_event(
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    json_mode: bool,
    runner_name: &str,
    job_display_name: &str,
    workflow: &str,
    signal: PausedSignal,
) {
    let step = signal.step.unwrap_or_else(|| "unknown".to_owned());
    let attempt = signal.attempt.unwrap_or(1);
    if json_mode {
        emit_json_event(
            stdout,
            serde_json::json!({
                "event": "run.paused",
                "ts": event_timestamp(),
                "runner": runner_name,
                "step": step.clone(),
                "attempt": attempt,
                "workflow": workflow,
                "retry_cmd": format!("local-ci retry --name {runner_name}"),
            }),
        );
    }
    let _ = writeln!(
        stderr,
        "\n[Local CI] Step failed: \"{step}\" ({workflow} > {job_display_name})"
    );
    if attempt > 1 {
        let _ = writeln!(stderr, "  Attempt: {attempt}");
    }
    let _ = writeln!(stderr, "  To retry:  local-ci retry --name {runner_name}");
}

pub fn job_lifecycle_events(
    workflow: &str,
    job: &PlannedJob,
    result: &JobResult,
) -> Vec<serde_json::Value> {
    let ts = event_timestamp();
    let mut events = vec![serde_json::json!({
        "event": "job.start",
        "ts": ts,
        "job": job.id.clone(),
        "runner": job.runner_name.clone(),
        "workflow": workflow,
    })];

    for (index, step) in result.steps.iter().enumerate() {
        let step_index = index + 1;
        events.push(serde_json::json!({
            "event": "step.start",
            "ts": ts,
            "job": job.id.clone(),
            "runner": job.runner_name.clone(),
            "step": step.name.clone(),
            "index": step_index,
        }));
        events.push(serde_json::json!({
            "event": "step.finish",
            "ts": ts,
            "job": job.id.clone(),
            "runner": job.runner_name.clone(),
            "step": step.name.clone(),
            "index": step_index,
            "status": json_step_status(step.status),
        }));
    }

    events.push(serde_json::json!({
        "event": "job.finish",
        "ts": ts,
        "job": job.id.clone(),
        "runner": job.runner_name.clone(),
        "workflow": workflow,
        "status": if result.succeeded { "passed" } else { "failed" },
        "durationMs": result.duration_ms,
    }));
    events
}

pub(super) fn json_step_status(status: StepStatus) -> &'static str {
    match status {
        StepStatus::Passed => "passed",
        StepStatus::Failed => "failed",
        StepStatus::Skipped => "skipped",
    }
}

pub(super) fn emit_json_event(stdout: &mut impl Write, event: serde_json::Value) {
    if let Ok(line) = serde_json::to_string(&event) {
        let _ = writeln!(stdout, "{line}");
    }
}

pub(super) fn event_timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let (year, month, day, hour, minute, second) = unix_seconds_to_utc(duration.as_secs());
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z",
        millis = duration.subsec_millis()
    )
}

pub(super) fn unix_seconds_to_utc(seconds: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = (seconds_of_day / 3_600) as u32;
    let minute = ((seconds_of_day % 3_600) / 60) as u32;
    let second = (seconds_of_day % 60) as u32;
    (year, month, day, hour, minute, second)
}

pub(super) fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year as i32, month as u32, day as u32)
}

pub(super) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}
