use globset::Glob;
use serde_yaml::{Mapping, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowDocument {
    pub path: PathBuf,
    pub name: Option<String>,
    pub on: Option<Value>,
    pub env: BTreeMap<String, String>,
    pub jobs: BTreeMap<String, WorkflowJob>,
    pub diagnostics: Vec<WorkflowDiagnostic>,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowJob {
    pub id: String,
    pub name: Option<String>,
    pub runs_on: Option<RunsOn>,
    pub uses: Option<String>,
    pub needs: Vec<String>,
    pub if_condition: Option<String>,
    pub env: BTreeMap<String, String>,
    pub outputs: BTreeMap<String, String>,
    pub services: BTreeMap<String, WorkflowService>,
    pub container: Option<WorkflowContainer>,
    pub steps: Vec<WorkflowStep>,
    pub strategy: Option<Value>,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowContainer {
    pub image: String,
    pub env: BTreeMap<String, String>,
    pub ports: Vec<String>,
    pub volumes: Vec<String>,
    pub options: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowService {
    pub id: String,
    pub image: String,
    pub env: BTreeMap<String, String>,
    pub ports: BTreeMap<String, String>,
    pub options: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunsOn {
    Single(String),
    Labels(Vec<String>),
    Other(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowStep {
    pub id: Option<String>,
    pub name: Option<String>,
    pub uses: Option<String>,
    pub run: Option<String>,
    pub if_condition: Option<String>,
    pub shell: Option<String>,
    pub working_directory: Option<String>,
    pub env: BTreeMap<String, String>,
    pub with: BTreeMap<String, String>,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowDiagnostic {
    pub level: DiagnosticLevel,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticLevel {
    Warning,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkflowEventFilters {
    pub branches: Option<Vec<String>>,
    pub branches_ignore: Option<Vec<String>>,
    pub paths: Option<Vec<String>>,
    pub paths_ignore: Option<Vec<String>>,
}

pub fn parse_workflow_file(path: &Path) -> Result<WorkflowDocument, WorkflowParseError> {
    let content = fs::read_to_string(path).map_err(|source| WorkflowParseError::Read {
        path: path.to_path_buf(),
        source: source.to_string(),
    })?;
    parse_workflow_str(path, &content)
}

pub fn parse_workflow_str(
    path: &Path,
    content: &str,
) -> Result<WorkflowDocument, WorkflowParseError> {
    let raw =
        serde_yaml::from_str::<Value>(content).map_err(|source| WorkflowParseError::Yaml {
            path: path.to_path_buf(),
            source: source.to_string(),
        })?;
    let Some(root) = raw.as_mapping() else {
        return Err(WorkflowParseError::Shape {
            path: path.to_path_buf(),
            message: "workflow root must be a mapping".to_owned(),
        });
    };

    let name = mapping_get(root, "name").and_then(value_to_string);
    let on = mapping_get(root, "on").cloned();
    let env = mapping_get(root, "env")
        .and_then(Value::as_mapping)
        .map(parse_string_map)
        .unwrap_or_default();
    let mut diagnostics = Vec::new();
    if on.is_none() {
        diagnostics.push(WorkflowDiagnostic {
            level: DiagnosticLevel::Warning,
            message: "workflow is missing an `on` trigger".to_owned(),
        });
    }

    let mut jobs = BTreeMap::new();
    match mapping_get(root, "jobs").and_then(Value::as_mapping) {
        Some(jobs_map) => {
            for (key, value) in jobs_map {
                let Some(id) = key.as_str() else {
                    diagnostics.push(WorkflowDiagnostic {
                        level: DiagnosticLevel::Warning,
                        message: "workflow contains a job with a non-string id".to_owned(),
                    });
                    continue;
                };
                match parse_job(id, value) {
                    Ok(job) => {
                        jobs.insert(id.to_owned(), job);
                    }
                    Err(message) => diagnostics.push(WorkflowDiagnostic {
                        level: DiagnosticLevel::Warning,
                        message,
                    }),
                }
            }
        }
        None => diagnostics.push(WorkflowDiagnostic {
            level: DiagnosticLevel::Error,
            message: "workflow is missing a `jobs` mapping".to_owned(),
        }),
    }

    Ok(WorkflowDocument {
        path: path.to_path_buf(),
        name,
        on,
        env,
        jobs,
        diagnostics,
        raw,
    })
}

pub fn workflow_events(workflow: &WorkflowDocument) -> BTreeMap<String, WorkflowEventFilters> {
    workflow
        .on
        .as_ref()
        .map_or_else(BTreeMap::new, extract_events)
}

pub fn extract_events(on: &Value) -> BTreeMap<String, WorkflowEventFilters> {
    let mut events = BTreeMap::new();

    if let Some(event) = value_to_string(on) {
        events.insert(event, WorkflowEventFilters::default());
        return events;
    }

    if let Some(sequence) = on.as_sequence() {
        for event in sequence.iter().filter_map(value_to_string) {
            events.insert(event, WorkflowEventFilters::default());
        }
        return events;
    }

    if let Some(mapping) = on.as_mapping() {
        for (key, value) in mapping {
            let Some(event) = value_to_string(key) else {
                continue;
            };
            let filters = value
                .as_mapping()
                .map(parse_event_filters)
                .unwrap_or_default();
            events.insert(event, filters);
        }
    }

    events
}

pub fn is_workflow_relevant(
    events: &BTreeMap<String, WorkflowEventFilters>,
    branch: &str,
    changed_files: &[String],
) -> bool {
    if events.is_empty() {
        return false;
    }

    for event in ["pull_request", "pull_request_target"] {
        if let Some(filters) = events.get(event) {
            let branch_matches = branch_filters_match(filters, branch);
            if branch_matches && paths_match(filters, changed_files) {
                return true;
            }
        }
    }

    if let Some(filters) = events.get("push") {
        let branch_matches = branch_filters_match(filters, branch);
        if branch_matches && paths_match(filters, changed_files) {
            return true;
        }
    }

    events.contains_key("workflow_dispatch")
        && !events.contains_key("pull_request")
        && !events.contains_key("pull_request_target")
        && !events.contains_key("push")
}

fn parse_job(id: &str, value: &Value) -> Result<WorkflowJob, String> {
    let Some(map) = value.as_mapping() else {
        return Err(format!("job `{id}` must be a mapping"));
    };

    let name = mapping_get(map, "name").and_then(value_to_string);
    let runs_on = mapping_get(map, "runs-on").map(parse_runs_on);
    let uses = mapping_get(map, "uses").and_then(value_to_string);
    let needs = mapping_get(map, "needs").map_or_else(Vec::new, parse_string_list);
    let if_condition = mapping_get(map, "if").and_then(value_to_string);
    let env = mapping_get(map, "env")
        .and_then(Value::as_mapping)
        .map(parse_string_map)
        .unwrap_or_default();
    let strategy = mapping_get(map, "strategy").cloned();
    let outputs = mapping_get(map, "outputs")
        .and_then(Value::as_mapping)
        .map(parse_string_map)
        .unwrap_or_default();
    let services = mapping_get(map, "services")
        .and_then(Value::as_mapping)
        .map(parse_services)
        .unwrap_or_default();
    let container = mapping_get(map, "container").and_then(parse_container);
    let steps = mapping_get(map, "steps").map_or_else(Vec::new, parse_steps);

    if runs_on.is_none() && uses.is_none() {
        return Err(format!("job `{id}` is missing `runs-on` or `uses`"));
    }

    Ok(WorkflowJob {
        id: id.to_owned(),
        name,
        runs_on,
        uses,
        needs,
        if_condition,
        env,
        outputs,
        services,
        container,
        steps,
        strategy,
        raw: value.clone(),
    })
}

fn parse_container(value: &Value) -> Option<WorkflowContainer> {
    if let Some(image) = value_to_string(value) {
        return Some(WorkflowContainer {
            image,
            env: BTreeMap::new(),
            ports: Vec::new(),
            volumes: Vec::new(),
            options: None,
        });
    }
    let map = value.as_mapping()?;
    let image = mapping_get(map, "image").and_then(value_to_string)?;
    Some(WorkflowContainer {
        image,
        env: mapping_get(map, "env")
            .and_then(Value::as_mapping)
            .map(parse_string_map)
            .unwrap_or_default(),
        ports: mapping_get(map, "ports").map_or_else(Vec::new, parse_string_list),
        volumes: mapping_get(map, "volumes").map_or_else(Vec::new, parse_string_list),
        options: mapping_get(map, "options").and_then(value_to_string),
    })
}

fn parse_services(mapping: &Mapping) -> BTreeMap<String, WorkflowService> {
    mapping
        .iter()
        .filter_map(|(key, value)| {
            let id = value_to_string(key)?;
            let map = value.as_mapping()?;
            let image = mapping_get(map, "image").and_then(value_to_string)?;
            let env = mapping_get(map, "env")
                .and_then(Value::as_mapping)
                .map(parse_string_map)
                .unwrap_or_default();
            let ports = mapping_get(map, "ports").map_or_else(BTreeMap::new, parse_service_ports);
            let options = mapping_get(map, "options").and_then(value_to_string);
            Some((
                id.clone(),
                WorkflowService {
                    id,
                    image,
                    env,
                    ports,
                    options,
                },
            ))
        })
        .collect()
}

fn parse_service_ports(value: &Value) -> BTreeMap<String, String> {
    let values = if let Some(sequence) = value.as_sequence() {
        sequence
            .iter()
            .filter_map(value_to_string)
            .collect::<Vec<_>>()
    } else {
        value_to_string(value).into_iter().collect::<Vec<_>>()
    };
    values
        .into_iter()
        .map(|port| {
            let (host, container) = port.split_once(':').unwrap_or((&port, &port));
            (container.trim().to_owned(), host.trim().to_owned())
        })
        .collect()
}

fn parse_steps(value: &Value) -> Vec<WorkflowStep> {
    let Some(items) = value.as_sequence() else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let map = item.as_mapping()?;
            Some(WorkflowStep {
                id: mapping_get(map, "id").and_then(value_to_string),
                name: mapping_get(map, "name").and_then(value_to_string),
                uses: mapping_get(map, "uses").and_then(value_to_string),
                run: mapping_get(map, "run").and_then(value_to_string),
                if_condition: mapping_get(map, "if").and_then(value_to_string),
                shell: mapping_get(map, "shell").and_then(value_to_string),
                working_directory: mapping_get(map, "working-directory").and_then(value_to_string),
                env: mapping_get(map, "env")
                    .and_then(Value::as_mapping)
                    .map(parse_string_map)
                    .unwrap_or_default(),
                with: mapping_get(map, "with")
                    .and_then(Value::as_mapping)
                    .map(parse_string_map)
                    .unwrap_or_default(),
                raw: item.clone(),
            })
        })
        .collect()
}

fn parse_runs_on(value: &Value) -> RunsOn {
    if let Some(scalar) = value_to_string(value) {
        return RunsOn::Single(scalar);
    }
    if let Some(sequence) = value.as_sequence() {
        let labels = sequence
            .iter()
            .filter_map(value_to_string)
            .collect::<Vec<_>>();
        if labels.len() == sequence.len() {
            return RunsOn::Labels(labels);
        }
    }
    RunsOn::Other(value_to_display_string(value))
}

fn parse_string_map(mapping: &Mapping) -> BTreeMap<String, String> {
    mapping
        .iter()
        .filter_map(|(key, value)| Some((value_to_string(key)?, value_to_display_string(value))))
        .collect()
}

fn parse_string_list(value: &Value) -> Vec<String> {
    if let Some(single) = value_to_string(value) {
        return vec![single];
    }
    value
        .as_sequence()
        .map(|items| items.iter().filter_map(value_to_string).collect())
        .unwrap_or_default()
}

fn parse_event_filters(mapping: &Mapping) -> WorkflowEventFilters {
    WorkflowEventFilters {
        branches: mapping_get(mapping, "branches").map(parse_string_list),
        branches_ignore: mapping_get(mapping, "branches-ignore").map(parse_string_list),
        paths: mapping_get(mapping, "paths").map(parse_string_list),
        paths_ignore: mapping_get(mapping, "paths-ignore").map(parse_string_list),
    }
}

fn branch_filters_match(filters: &WorkflowEventFilters, branch: &str) -> bool {
    if let Some(branches) = &filters.branches {
        return branches.iter().any(|pattern| glob_matches(pattern, branch));
    }
    if let Some(branches_ignore) = &filters.branches_ignore {
        return !branches_ignore
            .iter()
            .any(|pattern| glob_matches(pattern, branch));
    }
    true
}

fn paths_match(filters: &WorkflowEventFilters, changed_files: &[String]) -> bool {
    if changed_files.is_empty() {
        return true;
    }
    if let Some(paths) = &filters.paths {
        return changed_files
            .iter()
            .any(|file| paths.iter().any(|pattern| glob_matches(pattern, file)));
    }
    if let Some(paths_ignore) = &filters.paths_ignore {
        return changed_files.iter().any(|file| {
            !paths_ignore
                .iter()
                .any(|pattern| glob_matches(pattern, file))
        });
    }
    true
}

fn glob_matches(pattern: &str, value: &str) -> bool {
    Glob::new(pattern)
        .map(|glob| glob.compile_matcher().is_match(value))
        .unwrap_or_else(|_| pattern == value)
}

fn mapping_get<'a>(mapping: &'a Mapping, key: &str) -> Option<&'a Value> {
    mapping.get(Value::String(key.to_owned()))
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn value_to_display_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Sequence(_) | Value::Mapping(_) | Value::Tagged(_) => {
            serde_yaml::to_string(value).unwrap_or_else(|_| "<unprintable>".to_owned())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkflowParseError {
    Read { path: PathBuf, source: String },
    Yaml { path: PathBuf, source: String },
    Shape { path: PathBuf, message: String },
}

impl std::fmt::Display for WorkflowParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read { path, source } => {
                write!(
                    formatter,
                    "failed to read workflow {}: {source}",
                    path.display()
                )
            }
            Self::Yaml { path, source } => {
                write!(
                    formatter,
                    "failed to parse workflow {}: {source}",
                    path.display()
                )
            }
            Self::Shape { path, message } => {
                write!(formatter, "invalid workflow {}: {message}", path.display())
            }
        }
    }
}

impl std::error::Error for WorkflowParseError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .unwrap()
            .to_path_buf()
    }

    #[test]
    fn parses_smoke_binary_workflow() {
        let workflow =
            parse_workflow_file(&repo_root().join(".github/workflows/smoke-binary.yml")).unwrap();
        let job = workflow.jobs.get("binary-smoke").unwrap();

        assert_eq!(workflow.name, Some("Smoke: Binary".to_owned()));
        assert!(workflow.on.is_some());
        assert_eq!(
            job.runs_on,
            Some(RunsOn::Single("ubuntu-latest".to_owned()))
        );
        assert!(job.steps.iter().any(|step| step.uses.as_deref()
            == Some("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5")));
        assert!(
            job.steps
                .iter()
                .any(|step| step.name.as_deref() == Some("Run built binary (npx)"))
        );
    }

    #[test]
    fn parses_all_in_tree_workflows() {
        let root = repo_root();
        let workflow_dir = root.join(".github/workflows");
        let mut parsed = 0;
        for entry in fs::read_dir(workflow_dir).unwrap().filter_map(Result::ok) {
            let path = entry.path();
            let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
                continue;
            };
            if !matches!(extension, "yml" | "yaml") {
                continue;
            }
            let workflow = parse_workflow_file(&path).unwrap_or_else(|err| panic!("{err}"));
            assert!(
                !workflow.jobs.is_empty(),
                "{} should define jobs",
                path.display()
            );
            parsed += 1;
        }
        assert!(parsed > 20);
    }

    #[test]
    fn records_diagnostics_for_missing_jobs() {
        let workflow =
            parse_workflow_str(Path::new("missing.yml"), "name: Missing\non: push\n").unwrap();

        assert!(workflow.diagnostics.iter().any(|diagnostic| {
            diagnostic.level == DiagnosticLevel::Error
                && diagnostic.message == "workflow is missing a `jobs` mapping"
        }));
    }

    #[test]
    fn applies_branch_and_path_relevance_filters() {
        let workflow = parse_workflow_str(
            Path::new("filters.yml"),
            r#"on:
  push:
    branches: [main]
    paths: [src/**]
  pull_request:
    branches-ignore: [release/**]
    paths-ignore: [docs/**]
jobs:
  test:
    runs-on: ubuntu-latest
"#,
        )
        .unwrap();
        let events = workflow_events(&workflow);

        assert!(is_workflow_relevant(
            &events,
            "main",
            &["src/lib.rs".to_owned()]
        ));
        assert!(!is_workflow_relevant(
            &events,
            "feature",
            &["docs/readme.md".to_owned()]
        ));
        assert!(is_workflow_relevant(
            &events,
            "feature",
            &["src/lib.rs".to_owned()]
        ));
    }

    #[test]
    fn pull_request_branch_filters_use_actual_branch() {
        let workflow = parse_workflow_str(
            Path::new("pr-branch.yml"),
            r#"on:
  pull_request:
    branches: [develop]
jobs:
  test:
    runs-on: ubuntu-latest
"#,
        )
        .unwrap();
        let events = workflow_events(&workflow);

        assert!(is_workflow_relevant(&events, "develop", &[]));
        assert!(!is_workflow_relevant(&events, "main", &[]));
    }

    #[test]
    fn workflow_dispatch_only_is_relevant_for_all_mode() {
        let workflow = parse_workflow_str(
            Path::new("dispatch.yml"),
            "on: workflow_dispatch\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
        )
        .unwrap();
        let events = workflow_events(&workflow);

        assert!(is_workflow_relevant(&events, "anything", &[]));
    }

    #[test]
    fn rejects_invalid_yaml() {
        let err = parse_workflow_str(Path::new("bad.yml"), "jobs: [").unwrap_err();

        assert!(matches!(err, WorkflowParseError::Yaml { .. }));
    }
}
