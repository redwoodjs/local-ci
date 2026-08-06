use super::*;

pub(super) fn create_job_response(
    job_id: &str,
    job_data: &Value,
    request: &Request,
    plan_id: &str,
    state: &DtuState,
) -> Value {
    let timeline_id = mock_uuid(state.next_id());
    if let Some(log_dir) = state
        .plan_to_log_dir
        .lock()
        .expect("plan log lock")
        .get(plan_id)
        .cloned()
    {
        state
            .timeline_to_log_dir
            .lock()
            .expect("timeline lock")
            .insert(timeline_id.clone(), log_dir);
    }

    let base = base_url(request);
    let repo_full_name = string_field(job_data, &["githubRepo"])
        .or_else(|| {
            job_data
                .pointer("/repository/full_name")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let owner_name = job_data
        .pointer("/repository/owner/login")
        .and_then(Value::as_str)
        .unwrap_or_else(|| repo_full_name.split('/').next().unwrap_or("redwoodjs"));
    let repo_name = job_data
        .pointer("/repository/name")
        .and_then(Value::as_str)
        .unwrap_or_else(|| repo_full_name.split('/').nth(1).unwrap_or("repo"));
    let real_head_sha = string_field(job_data, &["realHeadSha"])
        .or_else(|| string_field(job_data, &["headSha"]))
        .unwrap_or_else(|| "HEAD".to_owned());
    let workflow_name =
        string_field(job_data, &["workflowName"]).unwrap_or_else(|| "local-workflow".to_owned());
    let job_name = string_field(job_data, &["name", "id"]).unwrap_or_else(|| job_id.to_owned());
    let workspace_root = string_field(job_data, &["runnerWorkDir"])
        .unwrap_or_else(|| "/home/runner/_work".to_owned());
    let workspace_path = format!("{workspace_root}/{repo_name}/{repo_name}");
    let runner_os = string_field(job_data, &["runnerOs"]).unwrap_or_else(|| "Linux".to_owned());
    let runner_arch = string_field(job_data, &["runnerArch"]).unwrap_or_else(|| "X64".to_owned());
    let (runner_temp, runner_tool_cache) = if runner_os.eq_ignore_ascii_case("macos") {
        (
            "/Users/admin/local-ci-runner/_work/_temp",
            "/Users/admin/hostedtoolcache",
        )
    } else {
        ("/tmp/runner", "/opt/hostedtoolcache")
    };
    let generated_job_id = mock_uuid(state.next_id());
    let mock_token = create_mock_jwt(plan_id, &generated_job_id);
    let mut job_env = string_map_from_value(job_data.get("env"));
    job_env
        .entry("ACTIONS_CACHE_URL".to_owned())
        .or_insert_with(|| format!("{base}/"));
    job_env
        .entry("ACTIONS_RESULTS_URL".to_owned())
        .or_insert_with(|| format!("{base}/"));
    let context_env = job_env.clone();

    let mut variables = json!({
        "CI": { "Value": "true", "IsSecret": false },
        "GITHUB_CI": { "Value": "true", "IsSecret": false },
        "GITHUB_ACTIONS": { "Value": "true", "IsSecret": false },
        "RUNNER_OS": { "Value": runner_os, "IsSecret": false },
        "RUNNER_ARCH": { "Value": runner_arch, "IsSecret": false },
        "RUNNER_NAME": { "Value": "oa-local-runner", "IsSecret": false },
        "RUNNER_TEMP": { "Value": runner_temp, "IsSecret": false },
        "RUNNER_TOOL_CACHE": { "Value": runner_tool_cache, "IsSecret": false },
        "GITHUB_RUN_ID": { "Value": "1", "IsSecret": false },
        "GITHUB_RUN_NUMBER": { "Value": "1", "IsSecret": false },
        "GITHUB_JOB": { "Value": job_name, "IsSecret": false },
        "GITHUB_EVENT_NAME": { "Value": "push", "IsSecret": false },
        "GITHUB_API_URL": { "Value": base, "IsSecret": false },
        "ACTIONS_CACHE_URL": { "Value": format!("{base}/"), "IsSecret": false },
        "ACTIONS_RESULTS_URL": { "Value": format!("{base}/"), "IsSecret": false },
        "GITHUB_SERVER_URL": { "Value": "https://github.com", "IsSecret": false },
        "GITHUB_REF_NAME": { "Value": "main", "IsSecret": false },
        "GITHUB_WORKFLOW": { "Value": workflow_name, "IsSecret": false },
        "GITHUB_WORKSPACE": { "Value": workspace_path, "IsSecret": false },
        "system.github.token": { "Value": "fake-token", "IsSecret": true },
        "system.github.job": { "Value": "local-job", "IsSecret": false },
        "system.github.repository": { "Value": repo_full_name, "IsSecret": false },
        "github.repository": { "Value": repo_full_name, "IsSecret": false },
        "github.actor": { "Value": owner_name, "IsSecret": false },
        "github.sha": { "Value": real_head_sha, "IsSecret": false },
        "github.ref": { "Value": "refs/heads/main", "IsSecret": false },
        "repository": { "Value": repo_full_name, "IsSecret": false },
        "GITHUB_REPOSITORY": { "Value": repo_full_name, "IsSecret": false },
        "GITHUB_ACTOR": { "Value": owner_name, "IsSecret": false },
        "GITHUB_SHA": { "Value": real_head_sha, "IsSecret": false },
        "build.repository.name": { "Value": repo_full_name, "IsSecret": false },
        "build.repository.uri": { "Value": format!("https://github.com/{repo_full_name}"), "IsSecret": false }
    });
    if let Some(object) = variables.as_object_mut() {
        for (key, value) in &context_env {
            object.insert(key.clone(), json!({ "Value": value, "IsSecret": false }));
        }
    }

    let github_context = json!({
        "repository": repo_full_name,
        "actor": owner_name,
        "sha": real_head_sha,
        "ref": "refs/heads/main",
        "event_name": "push",
        "server_url": "https://github.com",
        "api_url": base,
        "graphql_url": format!("{base}/_graphql"),
        "workspace": workspace_path,
        "action": "__run",
        "token": "fake-token",
        "job": "local-job",
        "event": {
            "repository": {
                "full_name": repo_full_name,
                "name": repo_name,
                "owner": { "login": owner_name },
                "default_branch": "main"
            },
            "before": "0000000000000000000000000000000000000000",
            "after": real_head_sha
        }
    });

    let raw_matrix_context = job_data.get("matrix");
    let matrix_context = matrix_context_value(raw_matrix_context);
    let strategy_context = strategy_context_value(raw_matrix_context);
    let environment_variables = if job_env.is_empty() {
        Value::Array(Vec::new())
    } else {
        json!([to_template_token_mapping(&json!(job_env))])
    };
    let env_context = if context_env.is_empty() {
        None
    } else {
        Some(to_context_data(&json!(context_env)))
    };

    let empty_object = json!({});
    let needs_value = job_data.get("needs").unwrap_or(&empty_object);
    let outputs_value = job_data.get("outputs").unwrap_or(&empty_object);

    let mut context_data = serde_json::Map::new();
    context_data.insert("github".to_owned(), to_context_data(&github_context));
    context_data.insert("steps".to_owned(), json!({ "t": 2, "d": [] }));
    context_data.insert("needs".to_owned(), to_context_data(needs_value));
    context_data.insert("strategy".to_owned(), to_context_data(&strategy_context));
    context_data.insert("matrix".to_owned(), to_context_data(&matrix_context));
    context_data.insert("secrets".to_owned(), json!({ "t": 2, "d": [] }));
    context_data.insert("vars".to_owned(), json!({ "t": 2, "d": [] }));
    context_data.insert("inputs".to_owned(), json!({ "t": 2, "d": [] }));
    if let Some(env_context) = env_context {
        context_data.insert("env".to_owned(), env_context);
    }

    let mut body = json!({
        "MessageType": "PipelineAgentJobRequest",
        "Plan": { "PlanId": plan_id, "PlanType": "Action", "ScopeId": mock_uuid(state.next_id()) },
        "Timeline": { "Id": timeline_id, "ChangeId": 1 },
        "JobId": generated_job_id,
        "RequestId": job_id.parse::<u64>().unwrap_or(1),
        "JobDisplayName": job_name,
        "JobName": job_name,
        "Steps": map_job_steps(job_data.get("steps"), &base),
        "Variables": variables,
        "ContextData": Value::Object(context_data),
        "Resources": {
            "Repositories": [{
                "Alias": "self",
                "Id": "repo-1",
                "Type": "git",
                "Version": string_field(job_data, &["headSha"]).unwrap_or_else(|| "HEAD".to_owned()),
                "Url": format!("https://github.com/{repo_full_name}"),
                "Properties": {
                    "id": "repo-1",
                    "name": repo_name,
                    "fullName": repo_full_name,
                    "repoFullName": repo_full_name,
                    "owner": owner_name,
                    "defaultBranch": "main",
                    "cloneUrl": format!("https://github.com/{repo_full_name}.git")
                }
            }],
            "Endpoints": [{
                "Name": "SystemVssConnection",
                "Url": base,
                "Authorization": { "Parameters": { "AccessToken": mock_token }, "Scheme": "OAuth" }
            }]
        },
        "Workspace": { "Path": workspace_path },
        "SystemVssConnection": {
            "Url": base,
            "Authorization": { "Parameters": { "AccessToken": mock_token }, "Scheme": "OAuth" }
        },
        "Actions": [],
        "MaskHints": [],
        "EnvironmentVariables": environment_variables,
        "JobOutputs": to_template_token_mapping(outputs_value)
    });
    if let Some(container) = job_data.get("container").and_then(job_container_token) {
        body["JobContainer"] = container;
    }
    if let Some(services) = job_data
        .get("services")
        .and_then(Value::as_array)
        .filter(|services| !services.is_empty())
        .map(|services| job_service_containers_token(services))
    {
        body["JobServiceContainers"] = services;
    }
    json!({
        "MessageId": 1,
        "MessageType": "PipelineAgentJobRequest",
        "Body": body.to_string(),
        "body": body.to_string(),
        "baseUrl": base
    })
}

pub(super) fn mock_uuid(id: u64) -> String {
    format!(
        "00000000-0000-4000-8000-{tail:012x}",
        tail = id & 0x0000_ffff_ffff_ffff
    )
}

pub(super) fn create_mock_jwt(plan_id: &str, job_id: &str) -> String {
    let payload = format!("{{\"orchid\":\"123\",\"scp\":\"Actions.Results:{plan_id}:{job_id}\"}}");
    format!(
        "{}.{}.mock-signature",
        base64_url(r#"{"alg":"HS256","typ":"JWT"}"#.as_bytes()),
        base64_url(payload.as_bytes())
    )
}

pub(super) fn base64_url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        }
    }
    out
}

pub(super) fn map_job_steps(steps: Option<&Value>, base_url: &str) -> Value {
    Value::Array(
        steps
            .and_then(Value::as_array)
            .map(|steps| {
                steps
                    .iter()
                    .enumerate()
                    .map(|(index, step)| map_job_step(step, index, base_url))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
    )
}

pub(super) fn map_job_step(step: &Value, index: usize, base_url: &str) -> Value {
    let name = string_field(step, &["Name", "name"]).unwrap_or_else(|| format!("step-{index}"));
    let display_name =
        string_field(step, &["DisplayName", "Name", "name"]).unwrap_or_else(|| name.clone());
    let inputs = step
        .get("Inputs")
        .cloned()
        .or_else(|| step.get("inputs").cloned())
        .or_else(|| {
            step.get("run")
                .and_then(Value::as_str)
                .map(|run| json!({ "script": run }))
        })
        .unwrap_or_else(|| json!({}));
    let condition =
        string_field(step, &["condition", "Condition"]).unwrap_or_else(|| "success()".to_owned());
    let mut mapped = json!({
        "id": string_field(step, &["Id", "id"]).unwrap_or_else(|| mock_uuid(index as u64 + 1)),
        "name": name,
        "displayName": display_name,
        "type": string_field(step, &["Type", "type"]).unwrap_or_else(|| "Action".to_owned()).to_ascii_lowercase(),
        "reference": map_step_reference(
            step.get("Reference").or_else(|| step.get("reference")),
            step.get("uses").and_then(Value::as_str),
        ),
        "inputs": to_template_token_mapping(&inputs),
        "contextData": json!({ "t": 2, "d": [] }),
        "condition": condition,
    });
    if let Some(context_name) = string_field(step, &["ContextName", "contextName"]) {
        mapped["contextName"] = Value::String(context_name);
    }
    let mut step_env = step.get("Env").cloned().unwrap_or_else(|| json!({}));
    if !step_env.is_object() {
        step_env = json!({});
    }
    if let Some(env) = step_env.as_object_mut() {
        env.entry("ACTIONS_CACHE_URL".to_owned())
            .or_insert_with(|| Value::String(format!("{base_url}/")));
        env.entry("ACTIONS_RESULTS_URL".to_owned())
            .or_insert_with(|| Value::String(format!("{base_url}/")));
    }
    mapped["environment"] = to_template_token_mapping(&step_env);
    mapped
}

pub(super) fn map_step_reference(reference: Option<&Value>, uses: Option<&str>) -> Value {
    if reference.is_none()
        && let Some(uses) = uses
    {
        return map_uses_reference(uses);
    }

    let reference_type = reference
        .and_then(|value| value.get("Type").or_else(|| value.get("type")))
        .and_then(Value::as_str)
        .unwrap_or("Script")
        .to_ascii_lowercase();
    let type_id = match reference_type.as_str() {
        "repository" => 1,
        "container" => 2,
        _ => 3,
    };
    if type_id == 1 {
        json!({
            "type": type_id,
            "name": reference.and_then(|value| value.get("Name")).and_then(Value::as_str).unwrap_or(""),
            "ref": reference.and_then(|value| value.get("Ref")).and_then(Value::as_str).unwrap_or(""),
            "repositoryType": reference.and_then(|value| value.get("RepositoryType")).and_then(Value::as_str).unwrap_or("GitHub"),
            "path": reference.and_then(|value| value.get("Path")).and_then(Value::as_str).unwrap_or(""),
        })
    } else {
        json!({ "type": type_id })
    }
}

pub(super) fn map_uses_reference(uses: &str) -> Value {
    if uses.starts_with("./") {
        return json!({
            "type": 1,
            "name": "",
            "ref": "",
            "repositoryType": "self",
            "path": uses,
        });
    }

    let Some((raw_name, reference)) = uses.rsplit_once('@') else {
        return json!({ "type": 3 });
    };
    let mut parts = raw_name.split('/').collect::<Vec<_>>();
    if parts.len() < 2 {
        return json!({ "type": 3 });
    }
    let name = format!("{}/{}", parts[0], parts[1]);
    let path = if parts.len() > 2 {
        parts.drain(2..).collect::<Vec<_>>().join("/")
    } else {
        String::new()
    };
    json!({
        "type": 1,
        "name": name,
        "ref": reference,
        "repositoryType": "GitHub",
        "path": path,
    })
}

pub(super) fn job_service_containers_token(services: &[Value]) -> Value {
    json!({
        "type": 2,
        "map": services
            .iter()
            .filter_map(|service| {
                let id = service.get("id").and_then(Value::as_str)?;
                let container = job_container_token(service)?;
                Some(json!({ "Key": id, "Value": container }))
            })
            .collect::<Vec<_>>()
    })
}

pub(super) fn job_container_token(container: &Value) -> Option<Value> {
    let image = container.get("image").and_then(Value::as_str)?;
    let mut entries = vec![json!({ "Key": "image", "Value": image })];
    if let Some(options) = container.get("options").and_then(Value::as_str) {
        if !options.trim().is_empty() {
            entries.push(json!({ "Key": "options", "Value": options }));
        }
    }
    if let Some(env) = container.get("env").filter(|env| env.is_object()) {
        entries.push(json!({ "Key": "env", "Value": to_template_token_mapping(env) }));
    }
    if let Some(ports) = template_sequence_token(container.get("ports")) {
        entries.push(json!({ "Key": "ports", "Value": ports }));
    }
    if let Some(volumes) = template_sequence_token(container.get("volumes")) {
        entries.push(json!({ "Key": "volumes", "Value": volumes }));
    }
    Some(json!({ "type": 2, "map": entries }))
}

pub(super) fn template_sequence_token(value: Option<&Value>) -> Option<Value> {
    let items = value?.as_array()?;
    if items.is_empty() {
        return None;
    }
    let strings = items.iter().map(value_to_string).collect::<Vec<_>>();
    Some(template_sequence_from_strings(&strings))
}

pub(super) fn template_sequence_from_strings(items: &[String]) -> Value {
    json!({
        "type": 1,
        "seq": items.iter().map(|item| Value::String(item.clone())).collect::<Vec<_>>()
    })
}

pub(super) fn string_map_from_value(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value_to_string(value)))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn matrix_context_value(value: Option<&Value>) -> Value {
    let object = value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter(|(key, _)| !key.starts_with("__job_"))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<serde_json::Map<_, _>>()
        })
        .unwrap_or_default();
    Value::Object(object)
}

pub(super) fn strategy_context_value(matrix: Option<&Value>) -> Value {
    let job_index = matrix
        .and_then(|matrix| matrix.get("__job_index"))
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let job_total = matrix
        .and_then(|matrix| matrix.get("__job_total"))
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1);
    json!({ "job-index": job_index, "job-total": job_total })
}

pub(super) fn to_context_data(value: &Value) -> Value {
    match value {
        Value::String(value) => json!({ "t": 0, "s": value }),
        Value::Bool(value) => json!({ "t": 3, "b": value }),
        Value::Number(value) => json!({ "t": 4, "n": value }),
        Value::Array(items) => {
            json!({ "t": 1, "a": items.iter().map(to_context_data).collect::<Vec<_>>() })
        }
        Value::Object(map) => json!({
            "t": 2,
            "d": map.iter().map(|(key, value)| json!({ "k": key, "v": to_context_data(value) })).collect::<Vec<_>>()
        }),
        Value::Null => json!({ "t": 0, "s": "" }),
    }
}

pub(super) fn to_template_token_mapping(value: &Value) -> Value {
    let entries = value
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| json!({ "Key": key, "Value": to_template_token_value(&value_to_string(value)) }))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if entries.is_empty() {
        json!({ "type": 2 })
    } else {
        json!({ "type": 2, "map": entries })
    }
}

pub(super) fn to_template_token_value(value: &str) -> Value {
    let trimmed = value.trim();
    if let Some(expr) = trimmed
        .strip_prefix("${{")
        .and_then(|value| value.strip_suffix("}}"))
    {
        return json!({ "type": 3, "expr": expr.trim() });
    }
    Value::String(value.to_owned())
}

pub(super) fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    })
}
