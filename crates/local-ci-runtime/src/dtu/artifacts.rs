use super::*;

pub(super) fn route_artifacts(
    request: &Request,
    state: &DtuState,
    segments: &[&str],
) -> Option<Response> {
    if request.method == "POST" && request.path == format!("{TWIRP_ARTIFACT_PREFIX}/CreateArtifact")
    {
        return Some(twirp_create_artifact(request, state));
    }
    if request.method == "POST"
        && request.path == format!("{TWIRP_ARTIFACT_PREFIX}/FinalizeArtifact")
    {
        return Some(twirp_finalize_artifact(request, state));
    }
    if request.method == "POST" && request.path == format!("{TWIRP_ARTIFACT_PREFIX}/ListArtifacts")
    {
        return Some(twirp_list_artifacts(request, state));
    }
    if request.method == "POST"
        && request.path == format!("{TWIRP_ARTIFACT_PREFIX}/GetSignedArtifactURL")
    {
        return Some(twirp_signed_artifact_url(request, state));
    }
    if segments.len() == 4 && segments[0..2] == ["_apis", "artifactblob"] {
        let container_id = segments[2].parse::<u64>().unwrap_or(u64::MAX);
        if request.method == "PUT" && segments[3] == "upload" {
            return Some(blob_upload(request, state, container_id));
        }
        if request.method == "GET" && segments[3] == "download" {
            return Some(blob_download(state, container_id));
        }
    }
    if request.method == "POST" && request.path == "/_apis/artifacts" {
        return Some(rest_create_artifact(request, state));
    }
    if request.method == "PUT" && segments.len() == 3 && segments[0..2] == ["_apis", "artifacts"] {
        return Some(rest_upload_artifact(
            request,
            state,
            segments[2].parse::<u64>().unwrap_or(u64::MAX),
        ));
    }
    if request.method == "PATCH" && request.path == "/_apis/artifacts" {
        return Some(rest_finalize_artifact(request, state));
    }
    if request.method == "GET" && request.path == "/_apis/artifacts" {
        return Some(rest_list_artifacts(request, state));
    }
    if request.method == "GET"
        && segments.len() == 3
        && segments[0..2] == ["_apis", "artifactfiles"]
    {
        return Some(rest_download_artifact(
            state,
            segments[2].parse::<u64>().unwrap_or(u64::MAX),
        ));
    }
    None
}

pub(super) fn twirp_create_artifact(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let Some(name) = payload.get("name").and_then(Value::as_str) else {
        return Response::json(400, json!({ "msg": "Missing artifact name" }));
    };
    let container_id = state.next_id();
    state
        .pending_artifacts
        .lock()
        .expect("pending artifacts lock")
        .insert(
            container_id,
            PendingArtifact {
                name: name.to_owned(),
                files: BTreeMap::new(),
            },
        );
    Response::json(
        200,
        json!({ "ok": true, "signedUploadUrl": format!("{}/_apis/artifactblob/{container_id}/upload", base_url(request)) }),
    )
}

pub(super) fn twirp_finalize_artifact(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let Some(name) = payload.get("name").and_then(Value::as_str) else {
        return Response::json(400, json!({ "msg": "Missing artifact name" }));
    };
    finalize_artifact_by_name(state, name).map_or_else(
        || Response::json(404, json!({ "ok": false })),
        |container_id| {
            Response::json(
                200,
                json!({ "ok": true, "artifactId": container_id.to_string() }),
            )
        },
    )
}

pub(super) fn twirp_list_artifacts(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let filter_name = payload.get("nameFilter").and_then(|value| {
        value
            .as_str()
            .or_else(|| value.get("value").and_then(Value::as_str))
    });
    let artifacts = state.artifacts.lock().expect("artifacts lock").iter().filter_map(|(name, artifact)| {
        if filter_name.is_some_and(|filter| filter != name) {
            return None;
        }
        Some(json!({
            "workflowRunBackendId": "00000000-0000-0000-0000-000000000001",
            "databaseId": artifact.container_id.to_string(),
            "name": name,
            "size": artifact.files.values().next().and_then(|path| fs::metadata(path).ok()).map_or(0, |meta| meta.len()).to_string(),
            "createdAt": iso_now()
        }))
    }).collect::<Vec<_>>();
    Response::json(200, json!({ "artifacts": artifacts }))
}

pub(super) fn twirp_signed_artifact_url(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let Some(name) = payload.get("name").and_then(Value::as_str) else {
        return Response::json(404, json!({ "signedUrl": "" }));
    };
    let artifact = state
        .artifacts
        .lock()
        .expect("artifacts lock")
        .get(name)
        .cloned();
    artifact.map_or_else(
        || Response::json(404, json!({ "signedUrl": "" })),
        |artifact| Response::json(200, json!({ "signedUrl": format!("{}/_apis/artifactblob/{}/download", base_url(request), artifact.container_id) })),
    )
}

pub(super) fn blob_upload(request: &Request, state: &DtuState, container_id: u64) -> Response {
    let mut pending = state
        .pending_artifacts
        .lock()
        .expect("pending artifacts lock");
    let Some(artifact) = pending.get_mut(&container_id) else {
        return Response::empty(404);
    };
    if request
        .query
        .get("comp")
        .is_some_and(|comp| comp == "block")
    {
        let block_id = request.query.get("blockid").cloned().unwrap_or_default();
        state
            .artifact_blocks
            .lock()
            .expect("blocks lock")
            .entry(container_id)
            .or_default()
            .insert(block_id, request.body.clone());
        return Response::empty(201);
    }
    if request
        .query
        .get("comp")
        .is_some_and(|comp| comp == "blocklist")
    {
        let xml = String::from_utf8_lossy(&request.body);
        let ids = latest_block_ids(&xml);
        let blocks = state
            .artifact_blocks
            .lock()
            .expect("blocks lock")
            .remove(&container_id)
            .unwrap_or_default();
        let bytes = if ids.is_empty() {
            blocks.values().flatten().copied().collect()
        } else {
            ids.iter()
                .flat_map(|id| blocks.get(id).cloned().unwrap_or_default())
                .collect()
        };
        return write_artifact_blob(state, artifact, container_id, bytes);
    }
    write_artifact_blob(state, artifact, container_id, request.body.clone())
}

pub(super) fn write_artifact_blob(
    state: &DtuState,
    artifact: &mut PendingArtifact,
    container_id: u64,
    bytes: Vec<u8>,
) -> Response {
    let path = state
        .cache_dir
        .join("artifacts")
        .join(format!("{container_id}_blob.zip"));
    if fs::write(&path, bytes).is_err() {
        return Response::empty(500);
    }
    artifact.files.insert("artifact.zip".to_owned(), path);
    Response::json(201, json!({ "ok": true }))
}

pub(super) fn latest_block_ids(xml: &str) -> Vec<String> {
    xml.split("<Latest>")
        .skip(1)
        .filter_map(|part| part.split("</Latest>").next())
        .map(ToOwned::to_owned)
        .collect()
}

pub(super) fn blob_download(state: &DtuState, container_id: u64) -> Response {
    let path = state
        .artifacts
        .lock()
        .expect("artifacts lock")
        .values()
        .find(|artifact| artifact.container_id == container_id)
        .and_then(|artifact| artifact.files.values().next().cloned());
    path.and_then(|path| fs::read(path).ok()).map_or_else(
        || Response::empty(404),
        |bytes| Response::bytes(200, "application/zip", bytes),
    )
}

pub(super) fn rest_create_artifact(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let Some(name) = payload.get("name").and_then(Value::as_str) else {
        return Response::json(400, json!({ "error": "Missing artifact name" }));
    };
    let container_id = state.next_id();
    state
        .pending_artifacts
        .lock()
        .expect("pending artifacts lock")
        .insert(
            container_id,
            PendingArtifact {
                name: name.to_owned(),
                files: BTreeMap::new(),
            },
        );
    Response::json(
        201,
        json!({ "containerId": container_id, "name": name, "fileContainerResourceUrl": format!("{}/_apis/artifacts/{container_id}", base_url(request)) }),
    )
}

pub(super) fn rest_upload_artifact(
    request: &Request,
    state: &DtuState,
    container_id: u64,
) -> Response {
    let item_path = request
        .query
        .get("itemPath")
        .cloned()
        .unwrap_or_else(|| "artifact.bin".to_owned());
    let mut pending = state
        .pending_artifacts
        .lock()
        .expect("pending artifacts lock");
    let Some(artifact) = pending.get_mut(&container_id) else {
        return Response::empty(404);
    };
    let path = state.cache_dir.join("artifacts").join(format!(
        "{}_{}",
        container_id,
        Path::new(&item_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    ));
    if fs::write(&path, &request.body).is_err() {
        return Response::empty(500);
    }
    artifact.files.insert(item_path, path);
    Response::json(200, json!({ "ok": true }))
}

pub(super) fn rest_finalize_artifact(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let Some(name) = payload.get("artifactName").and_then(Value::as_str) else {
        return Response::json(400, json!({ "error": "Missing artifactName" }));
    };
    finalize_artifact_by_name(state, name).map_or_else(
        || Response::empty(404),
        |container_id| Response::json(200, json!({ "ok": true, "containerId": container_id })),
    )
}

pub(super) fn finalize_artifact_by_name(state: &DtuState, name: &str) -> Option<u64> {
    let mut pending = state
        .pending_artifacts
        .lock()
        .expect("pending artifacts lock");
    let container_id = pending
        .iter()
        .find(|(_, pending)| pending.name == name)
        .map(|(id, _)| *id)?;
    let pending_artifact = pending.remove(&container_id)?;
    state.artifacts.lock().expect("artifacts lock").insert(
        name.to_owned(),
        Artifact {
            container_id,
            files: pending_artifact.files,
        },
    );
    Some(container_id)
}

pub(super) fn rest_list_artifacts(request: &Request, state: &DtuState) -> Response {
    let filter = request.query.get("artifactName").map(String::as_str);
    let value = state.artifacts.lock().expect("artifacts lock").iter().filter_map(|(name, artifact)| {
        if filter.is_some_and(|filter| filter != name) {
            return None;
        }
        Some(json!({ "containerId": artifact.container_id, "name": name, "fileContainerResourceUrl": format!("{}/_apis/artifactfiles/{}", base_url(request), artifact.container_id) }))
    }).collect::<Vec<_>>();
    Response::json(200, json!({ "count": value.len(), "value": value }))
}

pub(super) fn rest_download_artifact(state: &DtuState, container_id: u64) -> Response {
    let path = state
        .artifacts
        .lock()
        .expect("artifacts lock")
        .values()
        .find(|artifact| artifact.container_id == container_id)
        .and_then(|artifact| artifact.files.values().next().cloned());
    path.and_then(|path| fs::read(path).ok()).map_or_else(
        || Response::empty(404),
        |bytes| Response::bytes(200, "application/octet-stream", bytes),
    )
}
