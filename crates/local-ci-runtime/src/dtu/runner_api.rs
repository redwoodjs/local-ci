use super::*;

pub(super) fn route_runner(
    request: &Request,
    state: &DtuState,
    segments: &[&str],
) -> Option<Response> {
    if request.method == "GET"
        && matches!(
            request.path.as_str(),
            "/_apis/pipelines" | "/_apis/connectionData"
        )
    {
        return Some(service_discovery(request));
    }
    if request.method == "GET" && segments == ["_apis", "distributedtask", "pools"] {
        return Some(Response::json(
            200,
            json!({ "count": 1, "value": [{ "id": 1, "name": "Default", "isHosted": false, "autoProvision": true }] }),
        ));
    }
    if segments.len() == 5
        && segments[0..3] == ["_apis", "distributedtask", "pools"]
        && segments[4] == "agents"
    {
        if request.method == "GET" {
            return Some(Response::json(200, json!({ "count": 0, "value": [] })));
        }
        if request.method == "POST" {
            let payload = request_json(request);
            let agent_id = state.next_id();
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("local-ci-runner");
            return Some(Response::json(
                200,
                json!({
                    "id": agent_id,
                    "name": name,
                    "version": payload.get("version").and_then(Value::as_str).unwrap_or("2.331.0"),
                    "osDescription": payload.get("osDescription").and_then(Value::as_str).unwrap_or("Linux"),
                    "ephemeral": true,
                    "disableUpdate": true,
                    "enabled": true,
                    "status": "online",
                    "provisioningState": "Provisioned",
                    "authorization": { "clientId": format!("mock-client-{}", state.next_id()), "authorizationUrl": format!("{}/auth/authorize", base_url(request)) },
                    "accessPoint": format!("{}/_apis/distributedtask/pools/{}/agents/{agent_id}", base_url(request), segments[3])
                }),
            ));
        }
    }
    if segments.len() == 5
        && segments[0..3] == ["_apis", "distributedtask", "pools"]
        && segments[4] == "sessions"
        && request.method == "POST"
    {
        let payload = request_json(request);
        let session_id = mock_uuid(state.next_id());
        let owner_name = payload
            .pointer("/agent/name")
            .and_then(Value::as_str)
            .unwrap_or("local-ci-runner");
        let response = json!({
            "sessionId": session_id,
            "ownerName": owner_name,
            "agent": { "id": 1, "name": owner_name, "version": "2.331.0", "osDescription": "Linux", "enabled": true, "status": "online" },
            "encryptionKey": { "value": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "k": "encryptionKey" }
        });
        state
            .sessions
            .lock()
            .expect("sessions lock")
            .insert(session_id.clone(), response.clone());
        state
            .session_to_runner
            .lock()
            .expect("session runner lock")
            .insert(session_id, owner_name.to_owned());
        return Some(Response::json(200, response));
    }
    if segments.len() == 6
        && segments[0..3] == ["_apis", "distributedtask", "pools"]
        && segments[4] == "sessions"
        && request.method == "DELETE"
    {
        let session_id = segments[5];
        state
            .sessions
            .lock()
            .expect("sessions lock")
            .remove(session_id);
        state
            .session_to_runner
            .lock()
            .expect("session runner lock")
            .remove(session_id);
        return Some(Response::empty(204));
    }
    if segments.len() == 5
        && segments[0..3] == ["_apis", "distributedtask", "pools"]
        && segments[4] == "messages"
    {
        if request.method == "DELETE" {
            return Some(Response::empty(204));
        }
        if request.method == "GET" {
            return Some(poll_message(request, state));
        }
    }
    if segments.len() >= 3
        && segments[0..3] == ["_apis", "distributedtask", "jobrequests"]
        && request.method == "PATCH"
    {
        let mut payload = request_json(request);
        if payload.get("result").is_none() && payload.get("finishTime").is_none() {
            payload["lockedUntil"] = json!(iso_now_plus_minute());
        }
        return Some(Response::json(200, payload));
    }
    if request.path == "/_apis/distributedtask/jobrequests" && request.method == "PATCH" {
        return Some(Response::json(200, request_json(request)));
    }
    if request.method == "POST"
        && segments.len() == 7
        && segments[0..3] == ["_apis", "distributedtask", "hubs"]
        && segments[4] == "plans"
        && segments[6] == "logs"
    {
        let log_id = state.next_id();
        return Some(Response::json(
            201,
            json!({
                "id": log_id,
                "path": format!("logs/{log_id}"),
                "createdOn": iso_now(),
                "location": format!("{}/_apis/distributedtask/hubs/{}/plans/{}/logs/{log_id}", base_url(request), segments[3], segments[5])
            }),
        ));
    }
    if (request.method == "PATCH" || request.method == "POST")
        && segments.len() == 9
        && segments[0..3] == ["_apis", "distributedtask", "hubs"]
        && segments[4] == "plans"
        && segments[6] == "logs"
        && segments[8] == "lines"
    {
        append_log_lines(request, state, segments[5], segments[7]);
        return Some(Response::json(200, json!({ "count": 0, "value": [] })));
    }
    if (request.method == "PATCH" || request.method == "POST")
        && segments.len() == 11
        && segments[0..3] == ["_apis", "distributedtask", "hubs"]
        && segments[4] == "plans"
        && segments[6] == "timelines"
        && segments[8] == "records"
        && segments[10] == "feed"
    {
        append_timeline_feed(request, state, segments[5], segments[9]);
        return Some(Response::json(200, json!({ "count": 0, "value": [] })));
    }
    if (request.method == "PATCH" || request.method == "POST")
        && segments.len() == 5
        && segments[0..3] == ["_apis", "distributedtask", "timelines"]
        && segments[4] == "records"
    {
        return Some(timeline_records(request, state, segments[3]));
    }
    if request.method == "GET"
        && segments.len() == 4
        && segments[0..3] == ["_apis", "distributedtask", "timelines"]
    {
        return Some(timeline_get(state, segments[3]));
    }
    if request.method == "POST"
        && segments.len() == 7
        && segments[0..3] == ["_apis", "distributedtask", "hubs"]
        && segments[4] == "plans"
        && segments[6] == "outputs"
    {
        return Some(capture_outputs(request, state, segments[5]));
    }
    if request.method == "POST"
        && segments.len() == 7
        && segments[0..3] == ["_apis", "distributedtask", "hubs"]
        && segments[4] == "plans"
        && segments[6] == "actiondownloadinfo"
    {
        return Some(action_download_info(request));
    }
    None
}

pub(super) fn capture_outputs(request: &Request, state: &DtuState, plan_id: &str) -> Response {
    let payload = request_json(request);
    if let Some(log_dir) = state
        .plan_to_log_dir
        .lock()
        .expect("plan log lock")
        .get(plan_id)
        .cloned()
    {
        let path = PathBuf::from(log_dir).join("outputs.json");
        let mut existing = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Map<String, Value>>(&raw).ok())
            .unwrap_or_default();
        flatten_output_payload("", &payload, &mut existing);
        let _ = fs::write(
            path,
            serde_json::to_vec_pretty(&Value::Object(existing)).unwrap_or_default(),
        );
    }
    Response::json(200, json!({ "value": {} }))
}

pub(super) fn flatten_output_payload(
    prefix: &str,
    value: &Value,
    out: &mut serde_json::Map<String, Value>,
) {
    let Some(object) = value.as_object() else {
        return;
    };
    for (key, value) in object {
        if let Some(output_value) = value.get("value") {
            let flat_key = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            out.insert(flat_key, output_value.clone());
            out.insert(key.clone(), output_value.clone());
        } else if value.is_object() {
            let nested_prefix = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            flatten_output_payload(&nested_prefix, value, out);
        } else {
            let flat_key = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            out.insert(flat_key, value.clone());
            out.insert(key.clone(), value.clone());
        }
    }
}

pub(super) fn action_download_info(request: &Request) -> Response {
    let payload = request_json(request);
    let base = base_url(request);
    let mut actions = serde_json::Map::new();
    for action in payload
        .get("actions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(name_with_owner) = action.get("nameWithOwner").and_then(Value::as_str) else {
            continue;
        };
        if name_with_owner.starts_with("./") {
            continue;
        }
        let Some(reference) = action.get("ref").and_then(Value::as_str) else {
            continue;
        };
        let repo_path = name_with_owner
            .split('/')
            .take(2)
            .collect::<Vec<_>>()
            .join("/");
        let mut parts = repo_path.split('/');
        let Some(owner) = parts.next() else { continue };
        let Some(repo) = parts.next() else { continue };
        let key = format!("{name_with_owner}@{reference}");
        let local_url = format!("{base}/_dtu/action-tarball/{owner}/{repo}/{reference}");
        let url = std::env::var("LOCAL_CI_RUST_ACTION_TARBALL_BASE")
            .map(|base| format!("{base}/_dtu/action-tarball/{owner}/{repo}/{reference}"))
            .unwrap_or(local_url);
        let mut hasher = Sha1::new();
        hasher.update(key.as_bytes());
        actions.insert(
            key,
            json!({
                "nameWithOwner": name_with_owner,
                "resolvedNameWithOwner": name_with_owner,
                "ref": reference,
                "resolvedSha": format!("{:x}", hasher.finalize()),
                "tarballUrl": url,
                "zipballUrl": url,
                "authentication": null,
            }),
        );
    }
    Response::json(200, json!({ "actions": actions }))
}

pub(super) fn resource_locations() -> Response {
    Response::json(
        200,
        json!({
            "count": 10,
            "value": [
                { "id": "A8C47E17-4D56-4A56-92BB-DE7EA7DC65BE", "area": "distributedtask", "resourceName": "pools", "routeTemplate": "_apis/distributedtask/pools/{poolId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "E298EF32-5878-4CAB-993C-043836571F42", "area": "distributedtask", "resourceName": "agents", "routeTemplate": "_apis/distributedtask/pools/{poolId}/agents/{agentId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "C3A054F6-7A8A-49C0-944E-3A8E5D7ADFD7", "area": "distributedtask", "resourceName": "messages", "routeTemplate": "_apis/distributedtask/pools/{poolId}/messages", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "134E239E-2DF3-4794-A6F6-24F1F19EC8DC", "area": "distributedtask", "resourceName": "sessions", "routeTemplate": "_apis/distributedtask/pools/{poolId}/sessions/{sessionId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0" },
                { "id": "83597576-CC2C-453C-BEA6-2882AE6A1653", "area": "distributedtask", "resourceName": "timelines", "routeTemplate": "_apis/distributedtask/timelines/{timelineId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "27d7f831-88c1-4719-8ca1-6a061dad90eb", "area": "distributedtask", "resourceName": "actiondownloadinfo", "routeTemplate": "_apis/distributedtask/hubs/{hubName}/plans/{planId}/actiondownloadinfo", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "6.0", "releasedVersion": "6.0" },
                { "id": "858983e4-19bd-4c5e-864c-507b59b58b12", "area": "distributedtask", "resourceName": "feed", "routeTemplate": "_apis/distributedtask/hubs/{hubName}/plans/{planId}/timelines/{timelineId}/records/{recordId}/feed", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "46f5667d-263a-4684-91b1-dff7fdcf64e2", "area": "distributedtask", "resourceName": "logs", "routeTemplate": "_apis/distributedtask/hubs/{hubName}/plans/{planId}/logs/{logId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "8893BC5B-35B2-4BE7-83CB-99E683551DB4", "area": "distributedtask", "resourceName": "records", "routeTemplate": "_apis/distributedtask/timelines/{timelineId}/records/{recordId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "FC825784-C92A-4299-9221-998A02D1B54F", "area": "distributedtask", "resourceName": "jobrequests", "routeTemplate": "_apis/distributedtask/jobrequests/{jobId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" }
            ]
        }),
    )
}

pub(super) fn service_discovery(request: &Request) -> Response {
    let base = base_url(request);
    Response::json(
        200,
        json!({
            "value": [],
            "locationId": "11111111-1111-1111-1111-111111111111",
            "instanceId": "22222222-2222-2222-2222-222222222222",
            "locationServiceData": {
                "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
                "defaultAccessMappingMoniker": "PublicAccessMapping",
                "accessMappings": [
                    { "moniker": "PublicAccessMapping", "displayName": "Public Access", "accessPoint": base }
                ],
                "serviceDefinitions": [
                    { "serviceType": "distributedtask", "identifier": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "displayName": "distributedtask", "relativeToSetting": 3, "relativePath": "", "description": "Distributed Task Service", "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "status": 1, "locationMappings": [{ "accessMappingMoniker": "PublicAccessMapping", "location": base }] },
                    { "serviceType": "distributedtask", "identifier": "A8C47E17-4D56-4A56-92BB-DE7EA7DC65BE", "displayName": "Pools", "relativeToSetting": 3, "relativePath": "/_apis/distributedtask/pools", "description": "Pools Service", "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "status": 1, "locationMappings": [{ "accessMappingMoniker": "PublicAccessMapping", "location": format!("{base}/_apis/distributedtask/pools") }] },
                    { "serviceType": "distributedtask", "identifier": "134e239e-2df3-4794-a6f6-24f1f19ec8dc", "displayName": "TaskAgentSessions", "relativeToSetting": 3, "relativePath": "/_apis/distributedtask/pools/{poolId}/sessions", "description": "Task Agent Sessions", "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "status": 1, "locationMappings": [{ "accessMappingMoniker": "PublicAccessMapping", "location": base }] },
                    { "serviceType": "distributedtask", "identifier": "27d7f831-88c1-4719-8ca1-6a061dad90eb", "displayName": "ActionDownloadInfo", "relativeToSetting": 3, "relativePath": "/_apis/distributedtask/hubs/{hubName}/plans/{planId}/actiondownloadinfo", "description": "Action Download Info Service", "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "status": 1, "locationMappings": [{ "accessMappingMoniker": "PublicAccessMapping", "location": base }] },
                    { "serviceType": "distributedtask", "identifier": "858983e4-19bd-4c5e-864c-507b59b58b12", "displayName": "AppendTimelineRecordFeed", "relativeToSetting": 3, "relativePath": "/_apis/distributedtask/hubs/{hubName}/plans/{planId}/timelines/{timelineId}/records/{recordId}/feed", "description": "Timeline Feed Service", "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "status": 1, "locationMappings": [{ "accessMappingMoniker": "PublicAccessMapping", "location": base }] },
                    { "serviceType": "distributedtask", "identifier": "46f5667d-263a-4684-91b1-dff7fdcf64e2", "displayName": "Task Log", "relativeToSetting": 3, "relativePath": "/_apis/distributedtask/hubs/{hubName}/plans/{planId}/logs/{logId}", "description": "Task Log Service", "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "status": 1, "locationMappings": [{ "accessMappingMoniker": "PublicAccessMapping", "location": base }] }
                ]
            }
        }),
    )
}

pub(super) fn poll_message(request: &Request, state: &DtuState) -> Response {
    let Some(session_id) = request.query.get("sessionId") else {
        return Response::text(404, "Session not found");
    };
    if !state
        .sessions
        .lock()
        .expect("sessions lock")
        .contains_key(session_id)
    {
        return Response::text(404, "Session not found");
    }
    let runner_name = state
        .session_to_runner
        .lock()
        .expect("session runner lock")
        .get(session_id)
        .cloned();
    let runner_job = runner_name.as_ref().and_then(|name| {
        state
            .runner_jobs
            .lock()
            .expect("runner jobs lock")
            .remove(name)
    });
    let generic_job = if runner_job.is_none() {
        let first = state.jobs.lock().expect("jobs lock").keys().next().cloned();
        first.and_then(|id| {
            state
                .jobs
                .lock()
                .expect("jobs lock")
                .remove(&id)
                .map(|job| (id, job))
        })
    } else {
        None
    };
    let Some((job_id, job_data)) = runner_job
        .map(|job| {
            (
                runner_name.clone().unwrap_or_else(|| "runner".to_owned()),
                job,
            )
        })
        .or(generic_job)
    else {
        return Response::empty(204);
    };
    let plan_id = mock_uuid(state.next_id());
    if let Some(name) = runner_name {
        if let Some(log_dir) = state
            .runner_logs
            .lock()
            .expect("runner logs lock")
            .get(&name)
            .cloned()
        {
            state
                .plan_to_log_dir
                .lock()
                .expect("plan log lock")
                .insert(plan_id.clone(), log_dir);
        }
    }
    Response::json(
        200,
        create_job_response(&job_id, &job_data, request, &plan_id, state),
    )
}
