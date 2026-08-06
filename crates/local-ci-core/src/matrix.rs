use crate::workflow::{WorkflowDocument, WorkflowJob};
use serde_yaml::Value;
use std::collections::BTreeMap;

pub type MatrixContext = BTreeMap<String, String>;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MatrixDefinition {
    pub axes: BTreeMap<String, Vec<String>>,
    pub include: Vec<MatrixContext>,
    pub exclude: Vec<MatrixContext>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpandedWorkflowJob {
    pub job_id: String,
    pub runner_name: String,
    pub matrix_context: Option<MatrixContext>,
}

pub fn parse_matrix_def(job: &WorkflowJob) -> Option<MatrixDefinition> {
    let strategy = job.strategy.as_ref()?.as_mapping()?;
    let matrix = mapping_get(strategy, "matrix")?.as_mapping()?;
    let mut definition = MatrixDefinition::default();

    for (key, value) in matrix {
        let Some(key) = value_to_string(key) else {
            continue;
        };
        match key.as_str() {
            "include" => definition.include = parse_matrix_objects(value),
            "exclude" => definition.exclude = parse_matrix_objects(value),
            _ => {
                if let Some(values) = value.as_sequence() {
                    definition.axes.insert(
                        key,
                        values
                            .iter()
                            .filter_map(value_to_string)
                            .collect::<Vec<_>>(),
                    );
                }
            }
        }
    }

    if definition.axes.is_empty() && definition.include.is_empty() && definition.exclude.is_empty()
    {
        None
    } else {
        Some(definition)
    }
}

pub fn collapse_matrix_to_single(matrix: &MatrixDefinition) -> Vec<MatrixContext> {
    let mut combo = MatrixContext::new();
    for (key, values) in &matrix.axes {
        if let Some(first) = values.first() {
            combo.insert(key.clone(), first.clone());
        }
    }
    combo.insert("__job_total".to_owned(), "1".to_owned());
    combo.insert("__job_index".to_owned(), "0".to_owned());
    vec![combo]
}

pub fn expand_matrix_combinations(matrix: &MatrixDefinition) -> Vec<MatrixContext> {
    let mut combos = cartesian_product(&matrix.axes);
    combos.retain(|combo| {
        !matrix
            .exclude
            .iter()
            .any(|exclude| matrix_object_matches(combo, exclude))
    });
    apply_includes(&mut combos, &matrix.include);

    if combos.is_empty() {
        vec![MatrixContext::new()]
    } else {
        combos
    }
}

pub fn matrix_contexts(matrix: &MatrixDefinition, no_matrix: bool) -> Vec<MatrixContext> {
    if no_matrix {
        return collapse_matrix_to_single(matrix);
    }

    let mut combos = expand_matrix_combinations(matrix);
    let total = combos.len().to_string();
    for (index, combo) in combos.iter_mut().enumerate() {
        combo.insert("__job_total".to_owned(), total.clone());
        combo.insert("__job_index".to_owned(), index.to_string());
    }
    combos
}

pub fn expand_workflow_jobs(
    workflow: &WorkflowDocument,
    no_matrix: bool,
    base_run_num: u32,
) -> Vec<ExpandedWorkflowJob> {
    let mut expanded = Vec::new();
    for (job_index, job) in workflow.jobs.values().enumerate() {
        if let Some(matrix) = parse_matrix_def(job) {
            for context in matrix_contexts(&matrix, no_matrix) {
                expanded.push(ExpandedWorkflowJob {
                    job_id: job.id.clone(),
                    runner_name: runner_name(base_run_num, job_index, Some(&context)),
                    matrix_context: Some(context),
                });
            }
        } else {
            expanded.push(ExpandedWorkflowJob {
                job_id: job.id.clone(),
                runner_name: runner_name(base_run_num, job_index, None),
                matrix_context: None,
            });
        }
    }
    expanded
}

pub fn runner_name(
    base_run_num: u32,
    job_index: usize,
    matrix_context: Option<&MatrixContext>,
) -> String {
    let mut name = format!("local-ci-{base_run_num}-j{}", job_index + 1);
    if let Some(context) = matrix_context {
        let matrix_index = context
            .get("__job_index")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        name.push_str(&format!("-m{}", matrix_index + 1));
    }
    name
}

fn cartesian_product(axes: &BTreeMap<String, Vec<String>>) -> Vec<MatrixContext> {
    if axes.is_empty() {
        return vec![MatrixContext::new()];
    }

    let mut combos = vec![MatrixContext::new()];
    for (key, values) in axes {
        let mut next = Vec::new();
        for combo in &combos {
            for value in values {
                let mut combo = combo.clone();
                combo.insert(key.clone(), value.clone());
                next.push(combo);
            }
        }
        combos = next;
    }
    combos
}

fn apply_includes(combos: &mut Vec<MatrixContext>, includes: &[MatrixContext]) {
    for include in includes {
        let mut matched = false;
        for combo in combos.iter_mut() {
            if include_is_compatible(combo, include) {
                combo.extend(include.clone());
                matched = true;
            }
        }
        if !matched {
            combos.push(include.clone());
        }
    }
}

fn include_is_compatible(combo: &MatrixContext, include: &MatrixContext) -> bool {
    include
        .iter()
        .all(|(key, value)| combo.get(key).is_none_or(|existing| existing == value))
}

fn matrix_object_matches(combo: &MatrixContext, matcher: &MatrixContext) -> bool {
    matcher
        .iter()
        .all(|(key, value)| combo.get(key).is_some_and(|existing| existing == value))
}

fn parse_matrix_objects(value: &Value) -> Vec<MatrixContext> {
    value
        .as_sequence()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let mapping = item.as_mapping()?;
                    let mut object = MatrixContext::new();
                    for (key, value) in mapping {
                        if let (Some(key), Some(value)) =
                            (value_to_string(key), value_to_string(value))
                        {
                            object.insert(key, value);
                        }
                    }
                    Some(object)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn mapping_get<'a>(mapping: &'a serde_yaml::Mapping, key: &str) -> Option<&'a Value> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::parse_workflow_str;
    use std::path::Path;

    fn matrix_from_yaml(yaml: &str) -> MatrixDefinition {
        let workflow = parse_workflow_str(Path::new("matrix.yml"), yaml).unwrap();
        parse_matrix_def(workflow.jobs.get("test").unwrap()).unwrap()
    }

    #[test]
    fn expands_cartesian_product() {
        let matrix = matrix_from_yaml(
            r#"on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu, macos]
        node: [20, 22]
"#,
        );

        let combos = expand_matrix_combinations(&matrix);

        assert_eq!(combos.len(), 4);
        assert_eq!(combos[0].get("node"), Some(&"20".to_owned()));
        assert_eq!(combos[0].get("os"), Some(&"ubuntu".to_owned()));
    }

    #[test]
    fn applies_exclude_and_include_rules() {
        let matrix = matrix_from_yaml(
            r#"on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu, macos]
        node: [20, 22]
        exclude:
          - os: macos
            node: 20
        include:
          - os: ubuntu
            node: 22
            experimental: true
          - os: windows
            node: 22
"#,
        );

        let combos = expand_matrix_combinations(&matrix);

        assert_eq!(combos.len(), 4);
        assert!(
            !combos
                .iter()
                .any(|combo| combo.get("os") == Some(&"macos".to_owned())
                    && combo.get("node") == Some(&"20".to_owned()))
        );
        assert!(
            combos
                .iter()
                .any(|combo| combo.get("experimental") == Some(&"true".to_owned()))
        );
        assert!(
            combos
                .iter()
                .any(|combo| combo.get("os") == Some(&"windows".to_owned()))
        );
    }

    #[test]
    fn collapse_uses_first_axis_values_and_sets_strategy_metadata() {
        let matrix = matrix_from_yaml(
            r#"on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3]
"#,
        );

        let combos = collapse_matrix_to_single(&matrix);

        assert_eq!(combos.len(), 1);
        assert_eq!(combos[0].get("shard"), Some(&"1".to_owned()));
        assert_eq!(combos[0].get("__job_total"), Some(&"1".to_owned()));
        assert_eq!(combos[0].get("__job_index"), Some(&"0".to_owned()));
    }

    #[test]
    fn expanded_contexts_get_strategy_metadata() {
        let matrix = matrix_from_yaml(
            r#"on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3]
"#,
        );

        let combos = matrix_contexts(&matrix, false);

        assert_eq!(combos[2].get("__job_total"), Some(&"3".to_owned()));
        assert_eq!(combos[2].get("__job_index"), Some(&"2".to_owned()));
    }

    #[test]
    fn generates_runner_names_for_matrix_jobs() {
        let workflow = parse_workflow_str(
            Path::new("matrix.yml"),
            r#"on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2]
"#,
        )
        .unwrap();

        let jobs = expand_workflow_jobs(&workflow, false, 12);

        assert_eq!(jobs[0].runner_name, "local-ci-12-j1-m1");
        assert_eq!(jobs[1].runner_name, "local-ci-12-j1-m2");
    }
}
