use super::*;

pub(super) fn build_job_result_from_logs(
    plan: &JobExecutionPlan,
    succeeded: bool,
    duration_ms: u64,
) -> Result<JobResult, String> {
    let timeline_path = plan.log_dir.join("timeline.json");
    let steps = parse_timeline_steps(&timeline_path);
    let timeline_failed = steps.iter().any(|step| step.status == StepStatus::Failed)
        || parse_timeline_job_failed(&timeline_path);
    let succeeded = succeeded && !timeline_failed;
    let failed_step = steps
        .iter()
        .find(|step| step.status == StepStatus::Failed)
        .map(|step| step.name.clone())
        .or_else(|| (!succeeded).then(|| "unknown".to_owned()));

    Ok(JobResult {
        name: plan.job_id.clone(),
        workflow: plan.workflow.clone(),
        succeeded,
        paused: false,
        duration_ms,
        failed_step,
        debug_log_path: Some(plan.log_dir.join("debug.log")),
        steps,
    })
}

pub(super) fn parse_timeline_job_failed(path: &Path) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(records) = serde_json::from_str::<Value>(&content) else {
        return false;
    };
    records.as_array().into_iter().flatten().any(|record| {
        let record_type = record
            .get("type")
            .or_else(|| record.get("Type"))
            .and_then(Value::as_str);
        if record_type != Some("Job") {
            return false;
        }
        record
            .get("result")
            .or_else(|| record.get("Result"))
            .or_else(|| record.get("state"))
            .and_then(Value::as_str)
            .is_some_and(|result| {
                matches!(result.to_ascii_lowercase().as_str(), "failed" | "failure")
            })
    })
}

pub fn parse_timeline_steps(path: &Path) -> Vec<StepResult> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(records) = serde_json::from_str::<Value>(&content) else {
        return Vec::new();
    };
    let records = records.as_array().cloned().unwrap_or_default();
    let steps_dir = path.parent().map(|dir| dir.join("steps"));
    records
        .into_iter()
        .filter_map(|record| {
            let record_type = record
                .get("type")
                .or_else(|| record.get("Type"))
                .and_then(Value::as_str);
            if record_type != Some("Task") {
                return None;
            }
            let name = record
                .get("name")
                .or_else(|| record.get("Name"))
                .and_then(Value::as_str)?;
            let result = record
                .get("result")
                .or_else(|| record.get("Result"))
                .or_else(|| record.get("state"))
                .and_then(Value::as_str)
                .unwrap_or("succeeded");
            let status = match result.to_ascii_lowercase().as_str() {
                "failed" | "failure" => StepStatus::Failed,
                "skipped" => StepStatus::Skipped,
                _ => StepStatus::Passed,
            };
            let log_path = steps_dir.as_ref().and_then(|steps_dir| {
                step_log_candidates(&record, name)
                    .into_iter()
                    .map(|candidate| steps_dir.join(format!("{candidate}.log")))
                    .find(|candidate| candidate.exists())
            });
            Some(StepResult {
                name: name.to_owned(),
                status,
                log_path,
            })
        })
        .collect()
}

pub(super) fn step_log_candidates(record: &Value, name: &str) -> Vec<String> {
    let mut candidates = vec![sanitize_step_log_name(name)];
    if let Some(id) = record.get("id").and_then(Value::as_str) {
        candidates.push(id.to_owned());
    }
    if let Some(log_id) = record
        .get("log")
        .and_then(|log| log.get("id"))
        .and_then(|id| {
            id.as_str()
                .map(ToOwned::to_owned)
                .or_else(|| id.as_u64().map(|id| id.to_string()))
        })
    {
        candidates.push(log_id);
    }
    candidates
}

pub(super) fn sanitize_step_log_name(name: &str) -> String {
    let mut result = String::new();
    let mut previous_dash = false;
    for ch in name.chars() {
        let mapped = if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
            ch
        } else {
            '-'
        };
        if mapped == '-' {
            if previous_dash {
                continue;
            }
            previous_dash = true;
        } else {
            previous_dash = false;
        }
        result.push(mapped);
        if result.len() >= 80 {
            break;
        }
    }
    result.trim_matches('-').to_owned()
}

pub(super) fn write_job_summary(plan: &JobExecutionPlan, result: &JobResult) -> Result<(), String> {
    let summary_path = plan.log_dir.join("summary.json");
    let json = serde_json::to_string_pretty(result).map_err(|err| err.to_string())?;
    fs::write(summary_path, format!("{json}\n")).map_err(|err| err.to_string())
}
