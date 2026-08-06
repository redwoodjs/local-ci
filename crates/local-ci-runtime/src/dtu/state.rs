use super::*;

#[derive(Debug)]
pub(super) struct DtuState {
    pub(super) cache_dir: PathBuf,
    pub(super) allowed_log_root: PathBuf,
    pub(super) jobs: Mutex<BTreeMap<String, Value>>,
    pub(super) runner_jobs: Mutex<BTreeMap<String, Value>>,
    pub(super) sessions: Mutex<BTreeMap<String, Value>>,
    pub(super) session_to_runner: Mutex<BTreeMap<String, String>>,
    pub(super) runner_logs: Mutex<BTreeMap<String, String>>,
    pub(super) runner_timeline_dirs: Mutex<BTreeMap<String, String>>,
    pub(super) timeline_to_log_dir: Mutex<BTreeMap<String, String>>,
    pub(super) plan_to_log_dir: Mutex<BTreeMap<String, String>>,
    pub(super) record_to_step_name: Mutex<BTreeMap<String, String>>,
    pub(super) current_in_progress_step: Mutex<BTreeMap<String, String>>,
    pub(super) caches: Mutex<BTreeMap<String, CacheEntry>>,
    pub(super) pending_caches: Mutex<BTreeMap<u64, PendingCache>>,
    pub(super) virtual_cache_patterns: Mutex<BTreeSet<String>>,
    pub(super) pending_artifacts: Mutex<BTreeMap<u64, PendingArtifact>>,
    pub(super) artifacts: Mutex<BTreeMap<String, Artifact>>,
    pub(super) artifact_blocks: Mutex<BTreeMap<u64, BTreeMap<String, Vec<u8>>>>,
    pub(super) repo_root: Mutex<Option<String>>,
    pub(super) control_token: String,
    pub(super) next_id: AtomicU64,
}

impl DtuState {
    pub(super) fn new(
        cache_dir: PathBuf,
        allowed_log_root: PathBuf,
        control_token: String,
    ) -> Self {
        let caches = load_caches_from_disk(&cache_dir);
        Self {
            cache_dir,
            allowed_log_root,
            jobs: Mutex::new(BTreeMap::new()),
            runner_jobs: Mutex::new(BTreeMap::new()),
            sessions: Mutex::new(BTreeMap::new()),
            session_to_runner: Mutex::new(BTreeMap::new()),
            runner_logs: Mutex::new(BTreeMap::new()),
            runner_timeline_dirs: Mutex::new(BTreeMap::new()),
            timeline_to_log_dir: Mutex::new(BTreeMap::new()),
            plan_to_log_dir: Mutex::new(BTreeMap::new()),
            record_to_step_name: Mutex::new(BTreeMap::new()),
            current_in_progress_step: Mutex::new(BTreeMap::new()),
            caches: Mutex::new(caches),
            pending_caches: Mutex::new(BTreeMap::new()),
            virtual_cache_patterns: Mutex::new(BTreeSet::new()),
            pending_artifacts: Mutex::new(BTreeMap::new()),
            artifacts: Mutex::new(BTreeMap::new()),
            artifact_blocks: Mutex::new(BTreeMap::new()),
            repo_root: Mutex::new(None),
            control_token,
            next_id: AtomicU64::new(now_ms() as u64),
        }
    }

    pub(super) fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(super) fn is_virtual_cache_key(&self, key: &str) -> bool {
        self.virtual_cache_patterns
            .lock()
            .expect("virtual cache lock")
            .iter()
            .any(|pattern| key.contains(pattern))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CacheEntry {
    pub(super) version: String,
    pub(super) archive_location: String,
    pub(super) size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PendingCache {
    pub(super) temp_path: PathBuf,
    pub(super) key: String,
    pub(super) version: String,
}

pub(super) fn load_caches_from_disk(cache_dir: &Path) -> BTreeMap<String, CacheEntry> {
    let path = cache_dir.join("caches.json");
    let Ok(raw) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(&raw) else {
        return BTreeMap::new();
    };
    object
        .into_iter()
        .map(|(key, value)| {
            (
                key,
                CacheEntry {
                    version: value
                        .get("version")
                        .map(value_to_string)
                        .unwrap_or_default(),
                    archive_location: value
                        .get("archiveLocation")
                        .or_else(|| value.get("archive_location"))
                        .map(value_to_string)
                        .unwrap_or_default(),
                    size: value.get("size").and_then(Value::as_u64).unwrap_or(0),
                },
            )
        })
        .collect()
}

pub(super) fn save_caches_to_disk(state: &DtuState) {
    let _ = fs::create_dir_all(&state.cache_dir);
    let value = {
        let caches = state.caches.lock().expect("caches lock");
        let object = caches
            .iter()
            .map(|(key, entry)| {
                (
                    key.clone(),
                    json!({
                        "version": entry.version,
                        "archiveLocation": entry.archive_location,
                        "size": entry.size,
                    }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        Value::Object(object)
    };
    let _ = fs::write(
        state.cache_dir.join("caches.json"),
        serde_json::to_vec_pretty(&value).unwrap_or_default(),
    );
}

pub(super) fn cache_id_from_archive_location(location: &str) -> Option<u64> {
    location
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|id| id.parse::<u64>().ok())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PendingArtifact {
    pub(super) name: String,
    pub(super) files: BTreeMap<String, PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Artifact {
    pub(super) container_id: u64,
    pub(super) files: BTreeMap<String, PathBuf>,
}
