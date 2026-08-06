use crate::workflow::{WorkflowDocument, WorkflowParseError, parse_workflow_file};
use serde_yaml::{Mapping, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_REUSABLE_DEPTH: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpandedJobEntry {
    pub id: String,
    pub workflow_path: PathBuf,
    pub source_task_name: String,
    pub needs: Vec<String>,
    pub inputs: Option<BTreeMap<String, String>>,
    pub input_defaults: Option<BTreeMap<String, String>>,
    pub workflow_call_output_defs: Option<BTreeMap<String, String>>,
    pub caller_job_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteWorkflowRef {
    pub owner: String,
    pub repo: String,
    pub path: String,
    pub ref_name: String,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFetchError {
    pub status: Option<u16>,
    pub message: String,
}

pub trait RemoteWorkflowFetcher {
    fn fetch(
        &self,
        reference: &RemoteWorkflowRef,
        github_token: Option<&str>,
    ) -> Result<String, RemoteFetchError>;
}

pub fn expand_reusable_jobs(
    workflow_path: &Path,
    repo_root: &Path,
    remote_cache: Option<&BTreeMap<String, PathBuf>>,
) -> Result<Vec<ExpandedJobEntry>, ReusableWorkflowError> {
    let mut visited = BTreeSet::new();
    expand_reusable_jobs_inner(workflow_path, repo_root, remote_cache, 0, &mut visited)
}

pub fn parse_remote_ref(uses: &str) -> Option<RemoteWorkflowRef> {
    let (path_part, ref_name) = uses.rsplit_once('@')?;
    if ref_name.is_empty() {
        return None;
    }
    let segments = path_part.split('/').collect::<Vec<_>>();
    if segments.len() < 3 {
        return None;
    }
    Some(RemoteWorkflowRef {
        owner: segments[0].to_owned(),
        repo: segments[1].to_owned(),
        path: segments[2..].join("/"),
        ref_name: ref_name.to_owned(),
        raw: uses.to_owned(),
    })
}

pub fn is_sha_ref(ref_name: &str) -> bool {
    ref_name.len() == 40 && ref_name.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn remote_cache_path(cache_dir: &Path, reference: &RemoteWorkflowRef) -> PathBuf {
    let sanitized_ref = reference
        .ref_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    cache_dir
        .join(format!(
            "{}__{}@{}",
            reference.owner, reference.repo, sanitized_ref
        ))
        .join(&reference.path)
}

pub fn build_auth_hint(status: u16, has_token: bool) -> String {
    const AUTH_INSTRUCTIONS: &str = "  To authenticate, either:\n    - Install and log in with the GitHub CLI, then run:\n        gh auth login\n        local-ci run --github-token\n    - Or pass a token value directly:\n        local-ci run --github-token <token>\n    - Or export it:\n        export LOCAL_CI_GITHUB_TOKEN=<token>";
    const INSUFFICIENT_TOKEN_HINT: &str = "  If a token is already provided, it may lack the 'repo' scope (classic PAT) or 'contents: read' permission (fine-grained PAT), or the organization may require SSO authorization for the token.";

    match status {
        404 => {
            let detail = if has_token {
                INSUFFICIENT_TOKEN_HINT
            } else {
                AUTH_INSTRUCTIONS
            };
            format!(
                "\n  The repository or ref was not found. If this is a private repository, GitHub returns 404 when authentication is missing or insufficient.\n\n{detail}"
            )
        }
        401 | 403 => {
            if has_token {
                format!("\n{INSUFFICIENT_TOKEN_HINT}")
            } else {
                format!("\n{AUTH_INSTRUCTIONS}")
            }
        }
        _ => String::new(),
    }
}

pub fn prefetch_remote_workflows<F: RemoteWorkflowFetcher>(
    workflow_path: &Path,
    cache_dir: &Path,
    github_token: Option<&str>,
    fetcher: &F,
) -> Result<BTreeMap<String, PathBuf>, ReusableWorkflowError> {
    let refs = scan_remote_refs(workflow_path)?;
    let mut resolved = BTreeMap::new();
    let mut errors = Vec::new();

    for reference in refs {
        let destination = remote_cache_path(cache_dir, &reference);
        if is_sha_ref(&reference.ref_name) && destination.exists() {
            resolved.insert(reference.raw, destination);
            continue;
        }

        match fetcher.fetch(&reference, github_token) {
            Ok(content) => {
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent).map_err(|source| ReusableWorkflowError::Io {
                        path: parent.to_path_buf(),
                        source: source.to_string(),
                    })?;
                }
                fs::write(&destination, content).map_err(|source| ReusableWorkflowError::Io {
                    path: destination.clone(),
                    source: source.to_string(),
                })?;
                resolved.insert(reference.raw, destination);
            }
            Err(err) => {
                let hint = err
                    .status
                    .map(|status| build_auth_hint(status, github_token.is_some()))
                    .unwrap_or_default();
                errors.push(format!(
                    "Failed to fetch remote workflow {}{}: {}",
                    reference.raw, hint, err.message
                ));
            }
        }
    }

    if errors.is_empty() {
        Ok(resolved)
    } else {
        Err(ReusableWorkflowError::RemoteFetch(errors))
    }
}

fn scan_remote_refs(workflow_path: &Path) -> Result<Vec<RemoteWorkflowRef>, ReusableWorkflowError> {
    let workflow = parse_workflow_file(workflow_path)?;
    Ok(workflow
        .jobs
        .values()
        .filter_map(|job| job.uses.as_deref())
        .filter(|uses| !uses.starts_with("./"))
        .filter_map(parse_remote_ref)
        .collect())
}

fn expand_reusable_jobs_inner(
    workflow_path: &Path,
    repo_root: &Path,
    remote_cache: Option<&BTreeMap<String, PathBuf>>,
    depth: usize,
    visited_paths: &mut BTreeSet<PathBuf>,
) -> Result<Vec<ExpandedJobEntry>, ReusableWorkflowError> {
    if depth > MAX_REUSABLE_DEPTH {
        return Err(ReusableWorkflowError::DepthExceeded(
            workflow_path.to_path_buf(),
        ));
    }

    let resolved_path = absolute_path(workflow_path);
    if !visited_paths.insert(resolved_path.clone()) {
        return Err(ReusableWorkflowError::Cycle(resolved_path));
    }

    let workflow = parse_workflow_file(workflow_path)?;
    let mut entries = Vec::new();
    let mut caller_to_terminals = BTreeMap::<String, Vec<String>>::new();

    for job in workflow.jobs.values() {
        if let Some(uses) = &job.uses {
            let called_path = resolve_called_path(uses, repo_root, remote_cache)?;
            if !called_path.exists() {
                return Err(ReusableWorkflowError::MissingCalledWorkflow {
                    path: called_path,
                    job_id: job.id.clone(),
                });
            }

            let called_workflow = parse_workflow_file(&called_path)?;
            let caller_with = parse_string_map(mapping_get(job.raw.as_mapping(), "with"));
            let input_defaults = workflow_call_input_defaults(&called_workflow);
            let output_defs = workflow_call_output_defs(&called_workflow);
            let called_entries = expand_reusable_jobs_inner(
                &called_path,
                repo_root,
                remote_cache,
                depth + 1,
                visited_paths,
            )?;
            let caller_needs = job.needs.clone();
            let prefixed = called_entries
                .into_iter()
                .map(|entry| ExpandedJobEntry {
                    id: format!("{}/{}", job.id, entry.id),
                    workflow_path: entry.workflow_path,
                    source_task_name: entry.source_task_name,
                    needs: if entry.needs.is_empty() {
                        caller_needs.clone()
                    } else {
                        entry
                            .needs
                            .into_iter()
                            .map(|need| format!("{}/{}", job.id, need))
                            .collect()
                    },
                    inputs: caller_with.clone(),
                    input_defaults: non_empty(input_defaults.clone()),
                    workflow_call_output_defs: non_empty(output_defs.clone()),
                    caller_job_id: Some(job.id.clone()),
                })
                .collect::<Vec<_>>();

            let prefixed_ids = prefixed
                .iter()
                .map(|entry| entry.id.clone())
                .collect::<BTreeSet<_>>();
            let depended = prefixed
                .iter()
                .flat_map(|entry| entry.needs.iter())
                .filter(|need| prefixed_ids.contains(*need))
                .cloned()
                .collect::<BTreeSet<_>>();
            let terminals = prefixed
                .iter()
                .filter(|entry| !depended.contains(&entry.id))
                .map(|entry| entry.id.clone())
                .collect::<Vec<_>>();

            caller_to_terminals.insert(job.id.clone(), terminals);
            entries.extend(prefixed);
        } else {
            entries.push(ExpandedJobEntry {
                id: job.id.clone(),
                workflow_path: workflow_path.to_path_buf(),
                source_task_name: job.id.clone(),
                needs: job.needs.clone(),
                inputs: None,
                input_defaults: None,
                workflow_call_output_defs: None,
                caller_job_id: None,
            });
        }
    }

    for entry in &mut entries {
        entry.needs = entry
            .needs
            .iter()
            .flat_map(|need| {
                caller_to_terminals
                    .get(need)
                    .cloned()
                    .unwrap_or_else(|| vec![need.clone()])
            })
            .collect();
    }

    visited_paths.remove(&resolved_path);
    Ok(entries)
}

fn resolve_called_path(
    uses: &str,
    repo_root: &Path,
    remote_cache: Option<&BTreeMap<String, PathBuf>>,
) -> Result<PathBuf, ReusableWorkflowError> {
    if uses.starts_with("./") {
        return Ok(repo_root.join(uses));
    }
    remote_cache
        .and_then(|cache| cache.get(uses).cloned())
        .ok_or_else(|| ReusableWorkflowError::RemoteNotResolved(uses.to_owned()))
}

fn workflow_call_input_defaults(workflow: &WorkflowDocument) -> BTreeMap<String, String> {
    workflow_call_section(workflow, "inputs")
        .and_then(Value::as_mapping)
        .map(|mapping| {
            mapping
                .iter()
                .filter_map(|(key, definition)| {
                    let key = value_to_string(key)?;
                    let default = mapping_get(definition.as_mapping(), "default")
                        .and_then(value_to_string)?;
                    Some((key, default))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn workflow_call_output_defs(workflow: &WorkflowDocument) -> BTreeMap<String, String> {
    workflow_call_section(workflow, "outputs")
        .and_then(Value::as_mapping)
        .map(|mapping| {
            mapping
                .iter()
                .filter_map(|(key, definition)| {
                    let key = value_to_string(key)?;
                    let value =
                        mapping_get(definition.as_mapping(), "value").and_then(value_to_string)?;
                    Some((key, value))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn workflow_call_section<'a>(workflow: &'a WorkflowDocument, key: &str) -> Option<&'a Value> {
    let on = workflow.on.as_ref()?.as_mapping()?;
    let workflow_call = mapping_get(Some(on), "workflow_call")?.as_mapping()?;
    mapping_get(Some(workflow_call), key)
}

fn parse_string_map(value: Option<&Value>) -> Option<BTreeMap<String, String>> {
    value.and_then(Value::as_mapping).map(|mapping| {
        mapping
            .iter()
            .filter_map(|(key, value)| Some((value_to_string(key)?, value_to_string(value)?)))
            .collect()
    })
}

fn mapping_get<'a>(mapping: Option<&'a Mapping>, key: &str) -> Option<&'a Value> {
    mapping?.get(Value::String(key.to_owned()))
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn non_empty(map: BTreeMap<String, String>) -> Option<BTreeMap<String, String>> {
    (!map.is_empty()).then_some(map)
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReusableWorkflowError {
    WorkflowParse(String),
    DepthExceeded(PathBuf),
    Cycle(PathBuf),
    RemoteNotResolved(String),
    MissingCalledWorkflow { path: PathBuf, job_id: String },
    RemoteFetch(Vec<String>),
    Io { path: PathBuf, source: String },
}

impl From<WorkflowParseError> for ReusableWorkflowError {
    fn from(value: WorkflowParseError) -> Self {
        Self::WorkflowParse(value.to_string())
    }
}

impl std::fmt::Display for ReusableWorkflowError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WorkflowParse(message) => write!(formatter, "{message}"),
            Self::DepthExceeded(path) => write!(
                formatter,
                "Reusable workflow nesting depth exceeds maximum of {MAX_REUSABLE_DEPTH}: {}",
                path.display()
            ),
            Self::Cycle(path) => write!(
                formatter,
                "Cycle detected in reusable workflows: {} is already in the call chain",
                path.display()
            ),
            Self::RemoteNotResolved(uses) => {
                write!(formatter, "Remote reusable workflow not resolved: {uses}")
            }
            Self::MissingCalledWorkflow { path, job_id } => write!(
                formatter,
                "Reusable workflow file not found: {} (referenced by job \"{job_id}\")",
                path.display()
            ),
            Self::RemoteFetch(errors) => write!(
                formatter,
                "[Local CI] Remote workflow fetch failed:\n  {}",
                errors.join("\n  ")
            ),
            Self::Io { path, source } => write!(formatter, "{}: {source}", path.display()),
        }
    }
}

impl std::error::Error for ReusableWorkflowError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("local-ci-rust-reusable-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn expands_local_reusable_workflows_and_rewires_needs() {
        let repo = temp_dir("local");
        let workflows = repo.join(".github/workflows");
        fs::create_dir_all(&workflows).unwrap();
        let caller = workflows.join("caller.yml");
        let called = workflows.join("called.yml");
        fs::write(
            &caller,
            r#"on: push
jobs:
  setup:
    runs-on: ubuntu-latest
  build:
    needs: setup
    uses: ./.github/workflows/called.yml
    with:
      target: app
  after:
    needs: build
    runs-on: ubuntu-latest
"#,
        )
        .unwrap();
        fs::write(
            &called,
            r#"on:
  workflow_call:
    inputs:
      target:
        default: default-target
    outputs:
      artifact:
        value: ${{ jobs.package.outputs.artifact }}
jobs:
  compile:
    runs-on: ubuntu-latest
  package:
    needs: compile
    runs-on: ubuntu-latest
"#,
        )
        .unwrap();

        let entries = expand_reusable_jobs(&caller, &repo, None).unwrap();

        let ids = entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec!["after", "build/compile", "build/package", "setup"]
        );
        let compile = entries
            .iter()
            .find(|entry| entry.id == "build/compile")
            .unwrap();
        let package = entries
            .iter()
            .find(|entry| entry.id == "build/package")
            .unwrap();
        let after = entries.iter().find(|entry| entry.id == "after").unwrap();
        assert_eq!(compile.needs, vec!["setup".to_owned()]);
        assert_eq!(package.needs, vec!["build/compile".to_owned()]);
        assert_eq!(after.needs, vec!["build/package".to_owned()]);
        assert_eq!(
            compile.inputs.as_ref().unwrap().get("target"),
            Some(&"app".to_owned())
        );
        assert_eq!(
            compile.input_defaults.as_ref().unwrap().get("target"),
            Some(&"default-target".to_owned())
        );
        assert!(
            compile
                .workflow_call_output_defs
                .as_ref()
                .unwrap()
                .contains_key("artifact")
        );
    }

    #[test]
    fn detects_reusable_workflow_cycles() {
        let repo = temp_dir("cycle");
        let workflows = repo.join(".github/workflows");
        fs::create_dir_all(&workflows).unwrap();
        let workflow = workflows.join("cycle.yml");
        fs::write(
            &workflow,
            "on: push\njobs:\n  self:\n    uses: ./.github/workflows/cycle.yml\n",
        )
        .unwrap();

        let err = expand_reusable_jobs(&workflow, &repo, None).unwrap_err();

        assert!(matches!(err, ReusableWorkflowError::Cycle(_)));
    }

    #[test]
    fn parses_remote_refs_and_cache_paths() {
        let reference =
            parse_remote_ref("owner/repo/.github/workflows/ci.yml@feature/foo").unwrap();

        assert_eq!(reference.owner, "owner");
        assert_eq!(reference.repo, "repo");
        assert_eq!(reference.path, ".github/workflows/ci.yml");
        assert_eq!(reference.ref_name, "feature/foo");
        assert_eq!(
            remote_cache_path(Path::new("cache"), &reference),
            PathBuf::from("cache/owner__repo@feature-foo/.github/workflows/ci.yml")
        );
        assert!(is_sha_ref("0123456789abcdef0123456789abcdef01234567"));
        assert!(!is_sha_ref("main"));
    }

    struct FakeFetcher {
        calls: RefCell<Vec<(String, Option<String>)>>,
    }

    impl RemoteWorkflowFetcher for FakeFetcher {
        fn fetch(
            &self,
            reference: &RemoteWorkflowRef,
            github_token: Option<&str>,
        ) -> Result<String, RemoteFetchError> {
            self.calls
                .borrow_mut()
                .push((reference.raw.clone(), github_token.map(ToOwned::to_owned)));
            Ok("on: workflow_call\njobs:\n  test:\n    runs-on: ubuntu-latest\n".to_owned())
        }
    }

    #[test]
    fn prefetches_remote_workflows_and_passes_github_token() {
        let repo = temp_dir("remote");
        let workflow = repo.join("caller.yml");
        fs::write(
            &workflow,
            "on: push\njobs:\n  remote:\n    uses: owner/repo/.github/workflows/ci.yml@main\n",
        )
        .unwrap();
        let cache = repo.join("cache");
        let fetcher = FakeFetcher {
            calls: RefCell::new(Vec::new()),
        };

        let resolved =
            prefetch_remote_workflows(&workflow, &cache, Some("ghs_token"), &fetcher).unwrap();

        let cached = resolved
            .get("owner/repo/.github/workflows/ci.yml@main")
            .unwrap();
        assert!(cached.exists());
        assert_eq!(fetcher.calls.borrow()[0].1, Some("ghs_token".to_owned()));
    }

    #[test]
    fn sha_refs_use_existing_cache_without_fetching() {
        let repo = temp_dir("sha-cache");
        let workflow = repo.join("caller.yml");
        let raw = "owner/repo/.github/workflows/ci.yml@0123456789abcdef0123456789abcdef01234567";
        fs::write(
            &workflow,
            format!("on: push\njobs:\n  remote:\n    uses: {raw}\n"),
        )
        .unwrap();
        let cache = repo.join("cache");
        let reference = parse_remote_ref(raw).unwrap();
        let destination = remote_cache_path(&cache, &reference);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&destination, "cached").unwrap();
        let fetcher = FakeFetcher {
            calls: RefCell::new(Vec::new()),
        };

        let resolved = prefetch_remote_workflows(&workflow, &cache, None, &fetcher).unwrap();

        assert_eq!(resolved.get(raw), Some(&destination));
        assert!(fetcher.calls.borrow().is_empty());
    }

    #[test]
    fn auth_hints_cover_private_repo_statuses() {
        assert!(build_auth_hint(404, false).contains("gh auth login"));
        assert!(build_auth_hint(403, true).contains("contents: read"));
        assert_eq!(build_auth_hint(500, false), "");
    }
}
