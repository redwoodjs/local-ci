use super::*;

pub(super) fn append_log_lines(request: &Request, state: &DtuState, plan_id: &str, log_id: &str) {
    let payload = request_json(request);
    let lines = payload
        .get("value")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(feed_line_to_string).collect())
        .unwrap_or_default();
    write_step_output_lines(state, plan_id, log_id, lines);
}

pub(super) fn append_timeline_feed(
    request: &Request,
    state: &DtuState,
    plan_id: &str,
    record_id: &str,
) {
    let payload = request_json(request);
    let lines = if let Some(values) = payload.get("value").and_then(Value::as_array) {
        values.iter().filter_map(feed_line_to_string).collect()
    } else if let Some(values) = payload.as_array() {
        values.iter().filter_map(feed_line_to_string).collect()
    } else {
        Vec::new()
    };
    write_step_output_lines(state, plan_id, record_id, lines);
}

pub(super) fn feed_line_to_string(value: &Value) -> Option<String> {
    if let Some(line) = value.as_str() {
        return Some(line.to_owned());
    }
    value
        .get("message")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| Some(value.to_string()))
}

pub(super) fn write_step_output_lines(
    state: &DtuState,
    plan_id: &str,
    record_id: &str,
    lines: Vec<String>,
) {
    if lines.is_empty() {
        return;
    }
    let Some(log_dir) = state
        .plan_to_log_dir
        .lock()
        .expect("plan log lock")
        .get(plan_id)
        .cloned()
    else {
        return;
    };

    let mut content = String::new();
    let mut in_group = false;
    let mut output_entries = Vec::<(String, String)>::new();
    for raw_line in lines {
        let line = raw_line.trim_end();
        if line.is_empty() {
            if !in_group {
                content.push('\n');
            }
            continue;
        }
        let stripped = strip_runner_line_prefix(line);
        if let Some(kv) = stripped.strip_prefix("::local-ci-output::") {
            if let Some((key, value)) = kv.split_once('=')
                && !key.is_empty()
            {
                output_entries.push((key.to_owned(), value.to_owned()));
            }
            continue;
        }
        if stripped.starts_with("##[group]") {
            in_group = true;
            continue;
        }
        if stripped.starts_with("##[endgroup]") {
            in_group = false;
            continue;
        }
        if in_group
            || stripped.is_empty()
            || stripped.starts_with("##[")
            || stripped.starts_with("[command]")
            || is_runner_internal_line(stripped)
        {
            continue;
        }
        content.push_str(stripped);
        content.push('\n');
    }

    if !output_entries.is_empty() {
        persist_local_ci_outputs(&PathBuf::from(&log_dir), output_entries);
    }

    if content.is_empty() {
        return;
    }
    let step_name = state
        .record_to_step_name
        .lock()
        .expect("record step lock")
        .get(record_id)
        .cloned()
        .or_else(|| current_step_for_plan(state, &log_dir))
        .unwrap_or_else(|| sanitize_step_log_name(record_id));
    let steps_dir = PathBuf::from(log_dir).join("steps");
    let _ = fs::create_dir_all(&steps_dir);
    let path = steps_dir.join(format!("{step_name}.log"));
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, content.as_bytes()));
}

pub(super) fn persist_local_ci_outputs(log_dir: &Path, entries: Vec<(String, String)>) {
    let path = log_dir.join("outputs.json");
    let mut existing = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<BTreeMap<String, String>>(&raw).ok())
        .unwrap_or_default();
    for (key, value) in entries {
        existing.insert(key, value);
    }
    if let Ok(data) = serde_json::to_vec_pretty(&existing) {
        let _ = fs::write(path, data);
    }
}

pub(super) fn current_step_for_plan(state: &DtuState, log_dir: &str) -> Option<String> {
    let timeline_ids = state
        .timeline_to_log_dir
        .lock()
        .expect("timeline lock")
        .iter()
        .filter_map(|(timeline_id, mapped_log_dir)| {
            (mapped_log_dir == log_dir).then_some(timeline_id.clone())
        })
        .collect::<Vec<_>>();
    let current = state
        .current_in_progress_step
        .lock()
        .expect("current step lock");
    timeline_ids
        .iter()
        .find_map(|timeline_id| current.get(timeline_id).cloned())
}

pub(super) fn strip_runner_line_prefix(line: &str) -> &str {
    let stripped = line.trim_start_matches('\u{feff}');
    if stripped.len() > 22
        && stripped.as_bytes().get(4) == Some(&b'-')
        && stripped.as_bytes().get(7) == Some(&b'-')
        && stripped.as_bytes().get(10) == Some(&b'T')
        && let Some(index) = stripped.find("Z ")
    {
        return stripped[index + 2..].trim_start_matches('\u{feff}');
    }
    stripped
}

pub(super) fn is_runner_internal_line(line: &str) -> bool {
    (line.starts_with("[RUNNER ") || line.starts_with("[WORKER "))
        && (line.contains(" INFO ") || line.contains(" WARN ") || line.contains(" ERR "))
}

pub(super) fn update_step_log_mappings(
    state: &DtuState,
    timeline_id: &str,
    log_dir: &str,
    records: &[Value],
) {
    let steps_dir = PathBuf::from(log_dir).join("steps");
    let mut record_map = state.record_to_step_name.lock().expect("record step lock");
    let mut current_map = state
        .current_in_progress_step
        .lock()
        .expect("current step lock");
    for record in records {
        if record.get("type").and_then(Value::as_str) != Some("Task") {
            continue;
        }
        let Some(name) = record.get("name").and_then(Value::as_str) else {
            continue;
        };
        let sanitized = sanitize_step_log_name(name);
        let mut ids = Vec::<String>::new();
        if let Some(id) = record.get("id").and_then(Value::as_str) {
            ids.push(id.to_owned());
        }
        if let Some(id) = record
            .get("log")
            .and_then(|log| log.get("id"))
            .and_then(|id| {
                id.as_str()
                    .map(ToOwned::to_owned)
                    .or_else(|| id.as_u64().map(|id| id.to_string()))
            })
        {
            ids.push(id);
        }
        if is_user_step_record(record)
            && let Some(parent_id) = record.get("parentId").and_then(Value::as_str)
        {
            ids.push(parent_id.to_owned());
        }
        for id in ids {
            let old_path = steps_dir.join(format!("{id}.log"));
            let new_path = steps_dir.join(format!("{sanitized}.log"));
            if old_path.exists() && !new_path.exists() {
                let _ = fs::rename(&old_path, &new_path);
            }
            record_map.insert(id, sanitized.clone());
        }
        if record
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|state| state.eq_ignore_ascii_case("inProgress"))
        {
            current_map.insert(timeline_id.to_owned(), sanitized);
        }
    }
}

pub(super) fn is_user_step_record(record: &Value) -> bool {
    let name = record
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let ref_name = record
        .get("refName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    !matches!(name, "Set up job" | "Complete job")
        && !matches!(ref_name, "JobExtension_Init" | "JobExtension_Final")
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

pub(super) fn timeline_records(request: &Request, state: &DtuState, timeline_id: &str) -> Response {
    let payload = request_json(request);
    let records = payload
        .get("value")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(log_dir) = state
        .timeline_to_log_dir
        .lock()
        .expect("timeline lock")
        .get(timeline_id)
        .cloned()
    {
        let file = PathBuf::from(&log_dir).join("timeline.json");
        let _ = fs::write(
            file,
            serde_json::to_vec_pretty(&records).unwrap_or_default(),
        );
        update_step_log_mappings(state, timeline_id, &log_dir, &records);
    }
    Response::json(200, json!({ "count": records.len(), "value": records }))
}

pub(super) fn timeline_get(state: &DtuState, timeline_id: &str) -> Response {
    let records = state
        .timeline_to_log_dir
        .lock()
        .expect("timeline lock")
        .get(timeline_id)
        .and_then(|log_dir| fs::read_to_string(PathBuf::from(log_dir).join("timeline.json")).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!([]));
    Response::json(200, json!({ "id": timeline_id, "records": records }))
}
