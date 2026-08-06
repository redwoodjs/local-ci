use super::*;

pub(super) fn route_request(request: &Request, state: &Arc<DtuState>) -> Response {
    let segments = path_segments(&request.path);

    if request.method == "OPTIONS" {
        return resource_locations();
    }
    if request.method == "GET" && request.path.trim_end_matches('/') == "/_apis" {
        return Response::json(200, json!({ "value": [] }));
    }

    if is_control_request(request) && !control_token_authorized(request, state) {
        return Response::json(401, json!({ "message": "Unauthorized" }));
    }

    if request.path == "/_dtu/dump" && request.method == "GET" {
        if dtu_debug_enabled() {
            return dump_state(state);
        }
        return Response::json(404, json!({ "message": "Not Found (DTU Rust Mock)" }));
    }
    if request.path == "/_dtu/seed" && request.method == "POST" {
        return seed_job(request, state);
    }
    if request.path == "/_dtu/start-runner" && request.method == "POST" {
        return start_runner(request, state);
    }
    if request.method == "GET"
        && segments.len() >= 5
        && segments[0] == "_dtu"
        && segments[1] == "action-tarball"
    {
        return action_tarball(state, segments[2], segments[3], &segments[4..].join("/"));
    }

    if let Some(response) = route_github(request, state, &segments) {
        return response;
    }
    if let Some(response) = route_runner(request, state, &segments) {
        return response;
    }
    if let Some(response) = route_cache(request, state, &segments) {
        return response;
    }
    if let Some(response) = route_artifacts(request, state, &segments) {
        return response;
    }

    Response::json(404, json!({ "message": "Not Found (DTU Rust Mock)" }))
}

pub(super) fn path_segments(path: &str) -> Vec<&str> {
    path.trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect()
}

pub(super) fn request_json(request: &Request) -> Value {
    serde_json::from_slice(&request.body).unwrap_or(Value::Null)
}

pub(super) fn is_control_request(request: &Request) -> bool {
    let path = request.path.trim_end_matches('/');
    matches!(
        (request.method.as_str(), path),
        ("POST", "/_dtu/seed") | ("POST", "/_dtu/start-runner") | ("GET", "/_dtu/dump")
    )
}

fn control_tokens_match(actual: &str, expected: &str) -> bool {
    if actual.len() != expected.len() {
        return false;
    }
    actual
        .bytes()
        .zip(expected.bytes())
        .fold(0_u8, |difference, (actual, expected)| {
            difference | (actual ^ expected)
        })
        == 0
}

pub(super) fn control_token_authorized(request: &Request, state: &DtuState) -> bool {
    let header_token = request
        .headers
        .get("x-local-ci-dtu-token")
        .or_else(|| request.headers.get("x-agent-ci-dtu-token"))
        .map(String::as_str);
    let bearer_token = request
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "));
    header_token
        .or(bearer_token)
        .is_some_and(|token| control_tokens_match(token, &state.control_token))
}

pub(super) fn dtu_debug_enabled() -> bool {
    std::env::var("LOCAL_CI_DTU_DEBUG").is_ok_and(|value| value == "1")
}

pub(super) fn dump_state(state: &DtuState) -> Response {
    Response::json(
        200,
        json!({
            "jobs": state.jobs.lock().expect("jobs lock").clone(),
            "runnerJobs": state.runner_jobs.lock().expect("runner jobs lock").clone(),
            "runnerLogs": state.runner_logs.lock().expect("runner logs lock").clone(),
            "runnerTimelineDirs": state.runner_timeline_dirs.lock().expect("timeline dirs lock").clone(),
            "sessions": state.sessions.lock().expect("sessions lock").clone(),
            "sessionToRunner": state.session_to_runner.lock().expect("session runner lock").clone(),
            "caches": state.caches.lock().expect("caches lock").keys().cloned().collect::<Vec<_>>(),
            "artifacts": state.artifacts.lock().expect("artifacts lock").keys().cloned().collect::<Vec<_>>()
        }),
    )
}

pub(super) fn seed_job(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let Some(job_id) = payload
        .get("id")
        .map(value_to_string)
        .filter(|value| !value.is_empty())
    else {
        return Response::json(400, json!({ "error": "Missing job ID" }));
    };

    if let Some(repo_root) = payload.get("repoRoot").and_then(Value::as_str) {
        *state.repo_root.lock().expect("repo root lock") = Some(repo_root.to_owned());
    }

    if let Some(runner_name) = payload.get("runnerName").and_then(Value::as_str) {
        state
            .runner_jobs
            .lock()
            .expect("runner jobs lock")
            .insert(runner_name.to_owned(), payload);
    } else {
        state
            .jobs
            .lock()
            .expect("jobs lock")
            .insert(job_id.clone(), payload);
    }
    Response::json(201, json!({ "status": "ok", "jobId": job_id }))
}

pub(super) fn action_tarball(
    state: &DtuState,
    owner: &str,
    repo: &str,
    reference: &str,
) -> Response {
    let repo_path = format!("{owner}/{repo}");
    let safe_ref = reference.replace(['/', '\\', ':'], "_");
    let dest = state
        .cache_dir
        .join("action-tarballs")
        .join(owner)
        .join(repo)
        .join(format!("{safe_ref}.tar.gz"));
    if !dest.exists() {
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = dest.with_extension("tar.gz.tmp");
        let url = format!("https://api.github.com/repos/{repo_path}/tarball/{reference}");
        let status = std::process::Command::new("curl")
            .args(["-fsSL", "-A", "local-ci/1.0", "-o"])
            .arg(&tmp)
            .arg(&url)
            .status();
        match status {
            Ok(status) if status.success() => {
                let _ = fs::rename(&tmp, &dest);
            }
            Ok(status) => {
                let _ = fs::remove_file(&tmp);
                return Response::text(502, format!("failed to download action tarball: {status}"));
            }
            Err(err) => {
                let _ = fs::remove_file(&tmp);
                return Response::text(502, format!("failed to run curl: {err}"));
            }
        }
    }

    match fs::read(&dest) {
        Ok(bytes) => Response::streaming_bytes(200, "application/x-tar", bytes),
        Err(err) => Response::text(502, format!("failed to read action tarball: {err}")),
    }
}

pub(super) fn start_runner(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    if let (Some(runner_name), Some(log_dir)) = (
        payload.get("runnerName").and_then(Value::as_str),
        payload.get("logDir").and_then(Value::as_str),
    ) {
        let log_dir_path = PathBuf::from(log_dir);
        let timeline_dir = payload.get("timelineDir").and_then(Value::as_str);
        let timeline_dir_path = timeline_dir.map(PathBuf::from);
        if !path_is_under_root(&log_dir_path, &state.allowed_log_root)
            || timeline_dir_path
                .as_deref()
                .is_some_and(|path| !path_is_under_root(path, &state.allowed_log_root))
        {
            return Response::json(
                400,
                json!({ "error": "logDir and timelineDir must be under the run log directory" }),
            );
        }

        let _ = fs::create_dir_all(&log_dir_path);
        state
            .runner_logs
            .lock()
            .expect("runner logs lock")
            .insert(runner_name.to_owned(), log_dir.to_owned());
        if let Some(timeline_dir) = timeline_dir {
            state
                .runner_timeline_dirs
                .lock()
                .expect("timeline dirs lock")
                .insert(runner_name.to_owned(), timeline_dir.to_owned());
        }
        if let Some(patterns) = payload
            .get("virtualCachePatterns")
            .and_then(Value::as_array)
        {
            let mut virtual_patterns = state
                .virtual_cache_patterns
                .lock()
                .expect("virtual patterns lock");
            for pattern in patterns.iter().filter_map(Value::as_str) {
                virtual_patterns.insert(pattern.to_owned());
            }
        }
    }
    Response::json(200, json!({ "ok": true }))
}

pub(super) fn path_is_under_root(path: &Path, root: &Path) -> bool {
    if !path.is_absolute() || !root.is_absolute() {
        return false;
    }
    let normalized_path = normalize_path(path);
    let normalized_root = normalize_path(root);
    if normalized_path != normalized_root && !normalized_path.starts_with(&normalized_root) {
        return false;
    }

    // A lexical check alone accepts `log-root/link/out`, even when `link`
    // points outside the root. The leaf may not exist yet because
    // start_runner creates it after validation, so resolve its nearest
    // existing ancestor instead.
    let Ok(real_root) = fs::canonicalize(normalized_root) else {
        return false;
    };
    let mut existing_ancestor = normalized_path;
    while !existing_ancestor.exists() {
        let Some(parent) = existing_ancestor.parent() else {
            return false;
        };
        if parent == existing_ancestor {
            return false;
        }
        existing_ancestor = parent.to_path_buf();
    }
    let Ok(real_ancestor) = fs::canonicalize(existing_ancestor) else {
        return false;
    };
    real_ancestor == real_root || real_ancestor.starts_with(real_root)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(std::path::MAIN_SEPARATOR.to_string()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(value) => normalized.push(value),
        }
    }
    normalized
}
