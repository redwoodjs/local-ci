use super::*;

pub(super) fn route_github(
    request: &Request,
    state: &DtuState,
    segments: &[&str],
) -> Option<Response> {
    if request.method == "POST"
        && segments.len() == 4
        && segments[0] == "app"
        && segments[1] == "installations"
        && segments[3] == "access_tokens"
    {
        return Some(Response::json(
            201,
            json!({
                "token": format!("ghs_mock_token_{}_{}", segments[2], state.next_id()),
                "expires_at": iso_now_plus_hour(),
                "permissions": { "actions": "read", "metadata": "read" },
                "repository_selection": "selected"
            }),
        ));
    }

    if segments.len() >= 4 && segments[0] == "repos" {
        let owner = segments[1];
        let repo = segments[2];
        if request.method == "GET" && segments.len() == 4 && segments[3] == "installation" {
            return Some(Response::json(
                200,
                json!({
                    "id": 12345678,
                    "account": { "login": owner, "type": "User" },
                    "repository_selection": "all",
                    "access_tokens_url": format!("{}/app/installations/12345678/access_tokens", base_url(request))
                }),
            ));
        }
        if request.method == "POST"
            && segments.len() == 6
            && segments[3] == "actions"
            && segments[4] == "runners"
            && segments[5] == "registration-token"
        {
            return Some(registration_token(state));
        }
        if request.method == "GET"
            && segments.len() == 6
            && segments[3] == "actions"
            && segments[4] == "jobs"
        {
            let job_id = segments[5];
            let job = state.jobs.lock().expect("jobs lock").get(job_id).cloned();
            return Some(job.map_or_else(
                || Response::json(404, json!({ "message": "Not Found (DTU Mock)" })),
                |job| Response::json(200, job),
            ));
        }
        if request.method == "GET" && segments.len() == 5 && segments[3] == "compare" {
            return Some(compare_commits(segments[4], state));
        }
        if request.method == "GET"
            && segments.len() == 6
            && segments[3] == "commits"
            && segments[5] == "pulls"
        {
            return Some(Response::json(200, json!([])));
        }
        if request.method == "GET" && segments.len() == 6 && segments[3] == "tarball" {
            return Some(empty_tarball_response());
        }
        let _ = (owner, repo);
    }

    if request.method == "POST"
        && segments.len() == 7
        && segments[0] == "api"
        && segments[1] == "v3"
        && segments[2] == "repos"
        && segments[5] == "runners"
        && segments[6] == "registration-token"
    {
        return Some(registration_token(state));
    }

    if request.method == "POST"
        && segments.len() == 2
        && segments[0] == "actions"
        && segments[1] == "runner-registration"
    {
        return Some(global_runner_registration(request, state));
    }
    if request.method == "POST"
        && segments.len() == 4
        && segments[0] == "api"
        && segments[1] == "v3"
        && segments[2] == "actions"
        && segments[3] == "runner-registration"
    {
        return Some(global_runner_registration(request, state));
    }

    None
}

pub(super) fn registration_token(state: &DtuState) -> Response {
    Response::json(
        201,
        json!({
            "token": format!("ghr_mock_registration_token_{}", state.next_id()),
            "expires_at": iso_now_plus_hour()
        }),
    )
}

pub(super) fn global_runner_registration(request: &Request, state: &DtuState) -> Response {
    Response::json(
        200,
        json!({
            "token": format!("ghr_mock_tenant_token_{}", state.next_id()),
            "token_schema": "OAuthAccessToken",
            "authorization_url": format!("{}/auth/authorize", base_url(request)),
            "client_id": "mock-client-id",
            "tenant_id": "mock-tenant-id",
            "expiration": iso_now_plus_hour(),
            "url": base_url(request)
        }),
    )
}

fn is_safe_git_revision(revision: &str) -> bool {
    !revision.is_empty()
        && revision.len() <= 200
        && !revision.starts_with('-')
        && revision.chars().all(|ch| {
            ch.is_ascii_alphanumeric()
                || matches!(ch, '.' | '_' | '/' | '@' | '+' | '~' | '^' | '-')
        })
}

fn resolve_commit(repo_root: &str, revision: &str) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", "--end-of-options"])
        .arg(format!("{revision}^{{commit}}"))
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let commit = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!commit.is_empty()).then_some(commit)
}

pub(super) fn compare_commits(basehead: &str, state: &DtuState) -> Response {
    let parts = basehead
        .split("...")
        .flat_map(|part| part.split(".."))
        .collect::<Vec<_>>();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Response::json(422, json!({ "message": "Invalid basehead format" }));
    }
    let base = parts[0];
    let head = parts[1];
    let Some(repo_root) = state.repo_root.lock().expect("repo root lock").clone() else {
        return Response::json(
            200,
            json!({ "status": "identical", "files": [], "total_commits": 0, "commits": [] }),
        );
    };
    if !is_safe_git_revision(base) || !is_safe_git_revision(head) {
        return Response::json(422, json!({ "message": "Invalid basehead ref" }));
    }
    let Some(base_commit) = resolve_commit(&repo_root, base) else {
        return Response::json(422, json!({ "message": "Invalid basehead ref" }));
    };
    let Some(head_commit) = resolve_commit(&repo_root, head) else {
        return Response::json(422, json!({ "message": "Invalid basehead ref" }));
    };

    let output = std::process::Command::new("git")
        .args([
            "diff",
            "--name-status",
            "--no-ext-diff",
            "--no-textconv",
            "--end-of-options",
        ])
        .arg(&base_commit)
        .arg(&head_commit)
        .arg("--")
        .current_dir(repo_root)
        .output();
    let files = output
        .ok()
        .filter(|out| out.status.success())
        .map_or_else(Vec::new, |out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| {
                    let parts = line.split('\t').collect::<Vec<_>>();
                    let raw_status = *parts.first()?;
                    let filename = if raw_status.starts_with('R') {
                        parts.get(2)?
                    } else {
                        parts.get(1)?
                    };
                    Some(json!({
                        "sha": "0000000000000000000000000000000000000000",
                        "filename": filename,
                        "status": match raw_status.chars().next().unwrap_or('M') {
                            'A' => "added",
                            'D' => "removed",
                            'R' => "renamed",
                            _ => "modified",
                        },
                        "additions": 0,
                        "deletions": 0,
                        "changes": 0
                    }))
                })
                .collect()
        });
    Response::json(
        200,
        json!({ "status": if files.is_empty() { "identical" } else { "ahead" }, "total_commits": 1, "commits": [], "files": files }),
    )
}

pub(super) fn empty_tarball_response() -> Response {
    // A tiny empty gzip stream. It is enough for route/contract tests; execution
    // mode still uses the TypeScript DTU until the runner is fully ported.
    Response::bytes(
        200,
        "application/gzip",
        vec![
            0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0x03, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ],
    )
}
