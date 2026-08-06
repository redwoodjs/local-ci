use super::*;

pub(super) fn route_cache(
    request: &Request,
    state: &DtuState,
    segments: &[&str],
) -> Option<Response> {
    if request.method == "GET"
        && (request.path == "/_apis/artifactcache/caches"
            || request.path == "/_apis/artifactcache/cache")
    {
        return Some(cache_lookup(request, state));
    }
    if request.method == "POST" && segments == ["_apis", "artifactcache", "caches"] {
        return Some(cache_reserve(request, state));
    }
    if segments.len() == 4 && segments[0..3] == ["_apis", "artifactcache", "caches"] {
        let cache_id = segments[3].parse::<u64>().unwrap_or(u64::MAX);
        if request.method == "PATCH" {
            return Some(cache_upload(request, state, cache_id));
        }
        if request.method == "POST" {
            return Some(cache_commit(request, state, cache_id));
        }
    }
    if request.method == "GET"
        && segments.len() == 4
        && segments[0..3] == ["_apis", "artifactcache", "artifacts"]
    {
        return Some(cache_download(
            state,
            segments[3].parse::<u64>().unwrap_or(u64::MAX),
        ));
    }
    None
}

pub(super) fn cache_lookup(request: &Request, state: &DtuState) -> Response {
    let keys = request
        .query
        .get("keys")
        .map(|keys| {
            keys.split(',')
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let version = request.query.get("version").cloned().unwrap_or_default();
    for key in keys {
        if state.is_virtual_cache_key(key) {
            return Response::json(
                200,
                json!({ "result": "hit", "archiveLocation": format!("{}/_apis/artifactcache/artifacts/{VIRTUAL_CACHE_ID}", base_url(request)), "cacheKey": key }),
            );
        }
        let lookup = {
            let mut caches = state.caches.lock().expect("caches lock");
            if let Some(entry) = caches.get(key).cloned() {
                if entry.version != version {
                    None
                } else if let Some(cache_id) =
                    cache_id_from_archive_location(&entry.archive_location)
                {
                    if state
                        .cache_dir
                        .join(format!("cache_{cache_id}.tar.gz"))
                        .exists()
                    {
                        Some((cache_id, entry))
                    } else {
                        caches.remove(key);
                        drop(caches);
                        save_caches_to_disk(state);
                        None
                    }
                } else {
                    Some((0, entry))
                }
            } else {
                None
            }
        };
        if let Some((cache_id, entry)) = lookup {
            let archive_location = if cache_id == 0 {
                entry.archive_location
            } else {
                format!(
                    "{}/_apis/artifactcache/artifacts/{cache_id}",
                    base_url(request)
                )
            };
            return Response::json(
                200,
                json!({ "result": "hit", "archiveLocation": archive_location, "cacheKey": key }),
            );
        }
    }
    Response::empty(204)
}

pub(super) fn cache_reserve(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let key = payload.get("key").map(value_to_string).unwrap_or_default();
    let version = payload
        .get("version")
        .map(value_to_string)
        .unwrap_or_default();
    if state.is_virtual_cache_key(&key) {
        return Response::json(201, json!({ "cacheId": VIRTUAL_CACHE_ID }));
    }
    if state
        .caches
        .lock()
        .expect("caches lock")
        .get(&key)
        .is_some_and(|entry| entry.version == version)
    {
        return Response::json(409, json!({ "message": "Cache already exists" }));
    }
    let cache_id = state.next_id();
    let temp_path = state.cache_dir.join(format!("temp_{cache_id}.tar.gz"));
    let _ = fs::write(&temp_path, []);
    state
        .pending_caches
        .lock()
        .expect("pending cache lock")
        .insert(
            cache_id,
            PendingCache {
                temp_path,
                key,
                version,
            },
        );
    Response::json(201, json!({ "cacheId": cache_id }))
}

pub(super) fn cache_upload(request: &Request, state: &DtuState, cache_id: u64) -> Response {
    if cache_id == VIRTUAL_CACHE_ID {
        return Response::empty(200);
    }
    let Some(pending) = state
        .pending_caches
        .lock()
        .expect("pending cache lock")
        .get(&cache_id)
        .cloned()
    else {
        return Response::empty(404);
    };
    let start = request
        .headers
        .get("content-range")
        .and_then(|range| range.strip_prefix("bytes "))
        .and_then(|range| range.split('-').next())
        .and_then(|start| start.parse::<u64>().ok());
    let result = if let Some(start) = start {
        fs::OpenOptions::new()
            .write(true)
            .open(&pending.temp_path)
            .and_then(|mut file| {
                use std::io::Seek;
                file.seek(std::io::SeekFrom::Start(start))?;
                file.write_all(&request.body)
            })
    } else {
        fs::OpenOptions::new()
            .append(true)
            .open(&pending.temp_path)
            .and_then(|mut file| file.write_all(&request.body))
    };
    if result.is_ok() {
        Response::empty(200)
    } else {
        Response::empty(500)
    }
}

pub(super) fn cache_commit(request: &Request, state: &DtuState, cache_id: u64) -> Response {
    if cache_id == VIRTUAL_CACHE_ID {
        return Response::empty(200);
    }
    let Some(pending) = state
        .pending_caches
        .lock()
        .expect("pending cache lock")
        .remove(&cache_id)
    else {
        return Response::empty(404);
    };
    let final_path = state.cache_dir.join(format!("cache_{cache_id}.tar.gz"));
    if fs::rename(&pending.temp_path, &final_path).is_err() {
        return Response::empty(500);
    }
    let size = request_json(request)
        .get("size")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let archive_location = format!(
        "{}/_apis/artifactcache/artifacts/{cache_id}",
        base_url(request)
    );
    state.caches.lock().expect("caches lock").insert(
        pending.key,
        CacheEntry {
            version: pending.version,
            archive_location,
            size,
        },
    );
    save_caches_to_disk(state);
    Response::empty(200)
}

pub(super) fn cache_download(state: &DtuState, cache_id: u64) -> Response {
    if cache_id == VIRTUAL_CACHE_ID {
        return fs::read(empty_tar_gz_path(state)).map_or_else(
            |_| Response::empty(500),
            |bytes| Response::bytes(200, "application/octet-stream", bytes),
        );
    }
    let path = state.cache_dir.join(format!("cache_{cache_id}.tar.gz"));
    fs::read(path).map_or_else(
        |_| Response::empty(404),
        |bytes| Response::bytes(200, "application/octet-stream", bytes),
    )
}

pub(super) fn empty_tar_gz_path(state: &DtuState) -> PathBuf {
    let path = state.cache_dir.join("__empty__.tar.gz");
    if path.exists() {
        return path;
    }
    let _ = fs::create_dir_all(&state.cache_dir);
    let _ = std::process::Command::new("tar")
        .arg("-czf")
        .arg(&path)
        .arg("-T")
        .arg("/dev/null")
        .status();
    path
}
