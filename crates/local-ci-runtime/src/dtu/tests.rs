use super::*;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("local-ci-rust-dtu-{name}-{nonce}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn git(repo: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(repo)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

fn compare_fixture_repo() -> PathBuf {
    let repo = temp_dir("compare-repo");
    git(&repo, &["init"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "user.name", "Test"]);
    fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-m", "one"]);
    fs::write(repo.join("a.txt"), "two\n").unwrap();
    git(&repo, &["commit", "-am", "two"]);
    repo
}

fn request(server: &EphemeralDtu, method: &str, path: &str, body: Option<&[u8]>) -> (u16, Vec<u8>) {
    request_with_auth(server, method, path, body, true)
}

fn request_with_auth(
    server: &EphemeralDtu,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    include_auth: bool,
) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    let body = body.unwrap_or_default();
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: {}\r\n",
        server.port,
        body.len()
    )
    .unwrap();
    if include_auth {
        write!(stream, "X-Agent-CI-DTU-Token: {}\r\n", server.control_token).unwrap();
    }
    write!(stream, "Connection: close\r\n\r\n").unwrap();
    stream.write_all(body).unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    parse_response(&response)
}

fn json_request(server: &EphemeralDtu, method: &str, path: &str, body: Value) -> (u16, Value) {
    let bytes = serde_json::to_vec(&body).unwrap();
    let (status, body) = request(server, method, path, Some(&bytes));
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

fn parse_response(response: &[u8]) -> (u16, Vec<u8>) {
    let split = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&response[..split]);
    let status = head
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, response[split + 4..].to_vec())
}

#[test]
fn starts_ephemeral_server_and_closes_cleanly() {
    let server = start_ephemeral_dtu(temp_dir("start"), Some("container.local")).unwrap();

    assert!(server.url.starts_with("http://127.0.0.1:"));
    assert!(server.container_url.starts_with("http://container.local:"));
    assert_eq!(server.control_token.len(), 64);
    assert!(
        server
            .control_token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    );
    let (status, _) = request_with_auth(&server, "GET", "/_dtu/dump", None, false);
    assert_eq!(status, 401);
    let (status, _) = request_with_auth(
        &server,
        "POST",
        "/_dtu/seed",
        Some(br#"{"id":"blocked"}"#),
        false,
    );
    assert_eq!(status, 401);
    let (status, _) = request_with_auth(
        &server,
        "POST",
        "/_dtu/start-runner",
        Some(br#"{"runnerName":"blocked","logDir":"/tmp/blocked"}"#),
        false,
    );
    assert_eq!(status, 401);
    let (status, _) = request_with_auth(
        &server,
        "POST",
        "/_dtu/seed/",
        Some(br#"{"id":"trailing-blocked"}"#),
        false,
    );
    assert_eq!(status, 401);
    let (status, _) = request(&server, "GET", "/_dtu/dump", None);
    assert_eq!(status, 404);

    server.close();
}

#[test]
fn http_client_registers_runner_and_seeds_targeted_job() {
    let log_root = temp_dir("client-logs-root");
    let server = start_ephemeral_dtu_with_log_root(temp_dir("client"), &log_root, None).unwrap();
    let mut client = DtuHttpClient::with_control_token(&server.url, &server.control_token);
    let log_dir = log_root.join("client-logs");

    client
        .register_runner(&DtuRunnerRegistration {
            runner_name: "runner-a".to_owned(),
            log_dir: log_dir.clone(),
            timeline_dir: log_dir.clone(),
            virtual_cache_patterns: vec!["pnpm".to_owned()],
        })
        .unwrap();
    client
        .seed_job(&DtuJobSeed {
            id: "job-1".to_owned(),
            runner_name: "runner-a".to_owned(),
            name: "test".to_owned(),
            workflow_name: "ci".to_owned(),
            repo_root: temp_dir("client-repo"),
            github_repo: "owner/repo".to_owned(),
            head_sha: "HEAD".to_owned(),
            real_head_sha: "abc123".to_owned(),
            runner_work_dir: None,
            runner_os: None,
            runner_arch: None,
            env: BTreeMap::new(),
            outputs: BTreeMap::new(),
            needs_context: BTreeMap::new(),
            container: None,
            services: Vec::new(),
            matrix_context: None,
            steps: vec![crate::runner::DtuJobStep {
                name: "Run".to_owned(),
                context_name: None,
                run: Some("echo hi".to_owned()),
                uses: None,
                condition: None,
                shell: None,
                working_directory: None,
                env: BTreeMap::new(),
                with: BTreeMap::new(),
            }],
        })
        .unwrap();

    assert_eq!(
        server.state.runner_jobs.lock().unwrap()["runner-a"]["id"],
        "job-1"
    );
    assert_eq!(
        server.state.runner_logs.lock().unwrap()["runner-a"].as_str(),
        log_dir.to_string_lossy().as_ref()
    );
    server.close();
}

#[test]
fn rejects_runner_log_dirs_outside_allowed_root() {
    let server = start_ephemeral_dtu_with_log_root(
        temp_dir("client-reject-cache"),
        temp_dir("client-reject-logs"),
        None,
    )
    .unwrap();
    let outside = temp_dir("outside-logs");

    let (status, body) = json_request(
        &server,
        "POST",
        "/_dtu/start-runner",
        json!({ "runnerName": "runner-a", "logDir": outside }),
    );

    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("logDir"));
    assert!(
        !server
            .state
            .runner_logs
            .lock()
            .unwrap()
            .contains_key("runner-a")
    );
    server.close();
}

#[test]
fn runner_registration_rejects_invalid_timeline_without_partial_state() {
    let log_root = temp_dir("atomic-logs");
    let server =
        start_ephemeral_dtu_with_log_root(temp_dir("atomic-cache"), &log_root, None).unwrap();
    let log_dir = log_root.join("runner-a");
    let outside = temp_dir("atomic-outside");

    let (status, _) = json_request(
        &server,
        "POST",
        "/_dtu/start-runner",
        json!({ "runnerName": "runner-a", "logDir": log_dir, "timelineDir": outside }),
    );

    assert_eq!(status, 400);
    assert!(
        !server
            .state
            .runner_logs
            .lock()
            .unwrap()
            .contains_key("runner-a")
    );
    assert!(
        !server
            .state
            .runner_timeline_dirs
            .lock()
            .unwrap()
            .contains_key("runner-a")
    );
    assert!(!log_root.join("runner-a").exists());
    server.close();
}

#[cfg(unix)]
#[test]
fn runner_registration_rejects_symlinked_log_paths() {
    use std::os::unix::fs::symlink;

    let log_root = temp_dir("symlink-logs");
    let server =
        start_ephemeral_dtu_with_log_root(temp_dir("symlink-cache"), &log_root, None).unwrap();
    let outside = temp_dir("symlink-outside");
    let link = log_root.join("outside-link");
    symlink(&outside, &link).unwrap();

    let (status, _) = json_request(
        &server,
        "POST",
        "/_dtu/start-runner",
        json!({ "runnerName": "runner-a", "logDir": link.join("logs") }),
    );

    assert_eq!(status, 400);
    assert!(
        !server
            .state
            .runner_logs
            .lock()
            .unwrap()
            .contains_key("runner-a")
    );
    server.close();
}

#[test]
fn drop_closes_ephemeral_server() {
    let port = {
        let server = start_ephemeral_dtu(temp_dir("drop"), None).unwrap();
        let port = server.port;
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
        port
    };

    for _ in 0..50 {
        if TcpStream::connect(("127.0.0.1", port)).is_err() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("DTU port {port} was still accepting connections after drop");
}

#[test]
fn seeds_jobs_and_dispatches_to_runner_session() {
    let server = start_ephemeral_dtu(temp_dir("dispatch"), None).unwrap();
    let (status, _) = json_request(
        &server,
        "POST",
        "/_dtu/seed",
        json!({ "id": "job-1", "runnerName": "runner-a", "steps": [{ "name": "Run" }] }),
    );
    assert_eq!(status, 201);
    let (status, session) = json_request(
        &server,
        "POST",
        "/_apis/distributedtask/pools/1/sessions",
        json!({ "agent": { "name": "runner-a" } }),
    );
    assert_eq!(status, 200);
    let session_id = session["sessionId"].as_str().unwrap();
    let (status, message) = json_request(
        &server,
        "GET",
        &format!("/_apis/distributedtask/pools/1/messages?sessionId={session_id}"),
        Value::Null,
    );
    assert_eq!(status, 200);
    assert_eq!(message["MessageType"], "PipelineAgentJobRequest");
    let body = serde_json::from_str::<Value>(message["Body"].as_str().unwrap()).unwrap();
    assert_eq!(body["MessageType"], "PipelineAgentJobRequest");
    assert_eq!(body["Steps"][0]["displayName"], "Run");
    assert_eq!(body["Steps"][0]["inputs"]["type"], 2);
    server.close();
}

#[test]
fn timeline_feed_writes_sanitized_step_logs() {
    let log_root = temp_dir("feed-logs-root");
    let server = start_ephemeral_dtu_with_log_root(temp_dir("feed"), &log_root, None).unwrap();
    let log_dir = log_root.join("feed-logs");
    let mut client = DtuHttpClient::with_control_token(&server.url, &server.control_token);
    client
        .register_runner(&DtuRunnerRegistration {
            runner_name: "runner-a".to_owned(),
            log_dir: log_dir.clone(),
            timeline_dir: log_dir.clone(),
            virtual_cache_patterns: vec![],
        })
        .unwrap();
    let (status, _) = json_request(
        &server,
        "POST",
        "/_dtu/seed",
        json!({ "id": "job-1", "runnerName": "runner-a", "steps": [{ "name": "Run tests" }] }),
    );
    assert_eq!(status, 201);
    let (status, session) = json_request(
        &server,
        "POST",
        "/_apis/distributedtask/pools/1/sessions",
        json!({ "agent": { "name": "runner-a" } }),
    );
    assert_eq!(status, 200);
    let session_id = session["sessionId"].as_str().unwrap();
    let (status, message) = json_request(
        &server,
        "GET",
        &format!("/_apis/distributedtask/pools/1/messages?sessionId={session_id}"),
        Value::Null,
    );
    assert_eq!(status, 200);
    let body = serde_json::from_str::<Value>(message["Body"].as_str().unwrap()).unwrap();
    let plan_id = body["Plan"]["PlanId"].as_str().unwrap();
    let timeline_id = body["Timeline"]["Id"].as_str().unwrap();
    let record_id = "00000000-0000-4000-8000-000000000001";
    let (status, _) = json_request(
        &server,
        "PATCH",
        &format!("/_apis/distributedtask/timelines/{timeline_id}/records"),
        json!({ "value": [{
                "id": record_id,
                "type": "Task",
                "name": "Run tests",
                "state": "inProgress",
                "result": "succeeded"
            }] }),
    );
    assert_eq!(status, 200);
    let (status, _) = json_request(
        &server,
        "POST",
        &format!(
            "/_apis/distributedtask/hubs/Actions/plans/{plan_id}/timelines/{timeline_id}/records/{record_id}/feed"
        ),
        json!({ "value": [
                { "message": "2026-01-01T00:00:00.0000000Z ##[command]echo hello" },
                { "message": "2026-01-01T00:00:00.0000000Z hello from step" },
                { "message": "::local-ci-output::answer=42" }
            ] }),
    );
    assert_eq!(status, 200);

    assert_eq!(
        fs::read_to_string(log_dir.join("steps/Run-tests.log")).unwrap(),
        "hello from step\n"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&fs::read_to_string(log_dir.join("outputs.json")).unwrap())
            .unwrap()["answer"],
        json!("42")
    );
    server.close();
}

#[test]
fn compare_rejects_metacharacters_and_leading_dash_refs() {
    let server = start_ephemeral_dtu(temp_dir("compare-cache"), None).unwrap();
    let repo = compare_fixture_repo();
    let (status, _) = json_request(
        &server,
        "POST",
        "/_dtu/seed",
        json!({ "id": "compare", "repoRoot": repo }),
    );
    assert_eq!(status, 201);

    let (status, comparison) = json_request(
        &server,
        "GET",
        "/repos/owner/repo/compare/HEAD~1...HEAD",
        Value::Null,
    );
    assert_eq!(status, 200);
    assert_eq!(comparison["files"][0]["filename"], "a.txt");

    let marker = repo.join("marker");
    let (status, _) = request(
        &server,
        "GET",
        "/repos/owner/repo/compare/HEAD~1...HEAD;touch${IFS}marker;",
        None,
    );
    assert_eq!(status, 422);
    assert!(!marker.exists());

    let (status, _) = request(
        &server,
        "GET",
        "/repos/owner/repo/compare/-bad...HEAD",
        None,
    );
    assert_eq!(status, 422);
    server.close();
}

#[test]
fn serves_registration_and_installation_endpoints() {
    let server = start_ephemeral_dtu(temp_dir("github"), None).unwrap();
    let (status, token) = json_request(
        &server,
        "POST",
        "/repos/owner/repo/actions/runners/registration-token",
        Value::Null,
    );
    assert_eq!(status, 201);
    assert!(
        token["token"]
            .as_str()
            .unwrap()
            .starts_with("ghr_mock_registration_token_")
    );
    let (status, installation) = request(&server, "GET", "/repos/owner/repo/installation", None);
    assert_eq!(status, 200);
    assert!(
        String::from_utf8(installation)
            .unwrap()
            .contains("access_tokens_url")
    );
    server.close();
}

#[test]
fn cache_round_trip_preserves_uploaded_archive() {
    let server = start_ephemeral_dtu(temp_dir("cache"), None).unwrap();
    let (status, reserve) = json_request(
        &server,
        "POST",
        "/_apis/artifactcache/caches",
        json!({ "key": "pnpm-key", "version": "v1" }),
    );
    assert_eq!(status, 201);
    let cache_id = reserve["cacheId"].as_u64().unwrap();
    let (status, _) = request(
        &server,
        "PATCH",
        &format!("/_apis/artifactcache/caches/{cache_id}"),
        Some(b"archive"),
    );
    assert_eq!(status, 200);
    let (status, _) = json_request(
        &server,
        "POST",
        &format!("/_apis/artifactcache/caches/{cache_id}"),
        json!({ "size": 7 }),
    );
    assert_eq!(status, 200);
    let (status, hit) = json_request(
        &server,
        "GET",
        "/_apis/artifactcache/cache?keys=pnpm-key&version=v1",
        Value::Null,
    );
    assert_eq!(status, 200);
    assert_eq!(hit["result"], "hit");
    let (status, archive) = request(
        &server,
        "GET",
        &format!("/_apis/artifactcache/artifacts/{cache_id}"),
        None,
    );
    assert_eq!(status, 200);
    assert_eq!(archive, b"archive");
    server.close();
}

#[test]
fn artifact_rest_round_trip_preserves_bytes() {
    let server = start_ephemeral_dtu(temp_dir("artifact"), None).unwrap();
    let (status, created) = json_request(
        &server,
        "POST",
        "/_apis/artifacts",
        json!({ "name": "logs" }),
    );
    assert_eq!(status, 201);
    let container_id = created["containerId"].as_u64().unwrap();
    let (status, _) = request(
        &server,
        "PUT",
        &format!("/_apis/artifacts/{container_id}?itemPath=out.txt"),
        Some(b"hello artifact"),
    );
    assert_eq!(status, 200);
    let (status, _) = json_request(
        &server,
        "PATCH",
        "/_apis/artifacts",
        json!({ "artifactName": "logs" }),
    );
    assert_eq!(status, 200);
    let (status, listed) = json_request(
        &server,
        "GET",
        "/_apis/artifacts?artifactName=logs",
        Value::Null,
    );
    assert_eq!(status, 200);
    assert_eq!(listed["count"], 1);
    let (status, bytes) = request(
        &server,
        "GET",
        &format!("/_apis/artifactfiles/{container_id}"),
        None,
    );
    assert_eq!(status, 200);
    assert_eq!(bytes, b"hello artifact");
    server.close();
}

#[test]
fn artifact_twirp_block_blob_round_trip_preserves_bytes() {
    let server = start_ephemeral_dtu(temp_dir("twirp-artifact"), None).unwrap();
    let (status, created) = json_request(
        &server,
        "POST",
        "/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact",
        json!({ "name": "zip" }),
    );
    assert_eq!(status, 200);
    let upload = created["signedUploadUrl"].as_str().unwrap();
    let container_id = upload.split('/').nth_back(1).unwrap();
    let (status, _) = request(
        &server,
        "PUT",
        &format!("/_apis/artifactblob/{container_id}/upload?comp=block&blockid=a"),
        Some(b"hello "),
    );
    assert_eq!(status, 201);
    let (status, _) = request(
        &server,
        "PUT",
        &format!("/_apis/artifactblob/{container_id}/upload?comp=block&blockid=b"),
        Some(b"world"),
    );
    assert_eq!(status, 201);
    let (status, _) = request(
        &server,
        "PUT",
        &format!("/_apis/artifactblob/{container_id}/upload?comp=blocklist"),
        Some(b"<Latest>a</Latest><Latest>b</Latest>"),
    );
    assert_eq!(status, 201);
    let (status, _) = json_request(
        &server,
        "POST",
        "/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact",
        json!({ "name": "zip" }),
    );
    assert_eq!(status, 200);
    let (status, signed) = json_request(
        &server,
        "POST",
        "/twirp/github.actions.results.api.v1.ArtifactService/GetSignedArtifactURL",
        json!({ "name": "zip" }),
    );
    assert_eq!(status, 200);
    let signed_url = signed["signedUrl"].as_str().unwrap();
    let path = signed_url
        .split_once(&format!("127.0.0.1:{}", server.port))
        .unwrap()
        .1;
    let (status, bytes) = request(&server, "GET", path, None);
    assert_eq!(status, 200);
    assert_eq!(bytes, b"hello world");
    server.close();
}
