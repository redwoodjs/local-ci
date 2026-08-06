use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const RUN_RESULT_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResultStepEntry {
    pub name: String,
    pub status: StepResultStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepResultStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResultJobEntry {
    pub name: String,
    pub workflow: String,
    pub status: JobResultStatus,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failing_step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_log_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<RunResultStepEntry>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobResultStatus {
    Passed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResultFile {
    pub schema_version: u8,
    pub repo: String,
    pub branch: String,
    pub worktree_path: String,
    pub head_sha: String,
    pub started_at: String,
    pub finished_at: String,
    pub status: JobResultStatus,
    pub jobs: Vec<RunResultJobEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResultInput {
    pub repo: String,
    pub branch: String,
    pub worktree_path: PathBuf,
    pub head_sha: String,
    pub started_at: String,
    pub finished_at: String,
    pub results: Vec<JobResultInput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobResultInput {
    pub name: String,
    pub workflow: String,
    pub succeeded: bool,
    pub duration_ms: u64,
    pub failing_step: Option<String>,
    pub debug_log_path: Option<PathBuf>,
    pub steps: Vec<StepResultInput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepResultInput {
    pub name: String,
    pub status: StepResultStatus,
    pub log_path: Option<PathBuf>,
}

pub fn build_run_result_json(input: &RunResultInput) -> RunResultFile {
    let jobs = input
        .results
        .iter()
        .map(|result| {
            let status = if result.succeeded {
                JobResultStatus::Passed
            } else {
                JobResultStatus::Failed
            };
            let steps = (!result.steps.is_empty()).then(|| {
                result
                    .steps
                    .iter()
                    .map(|step| RunResultStepEntry {
                        name: step.name.clone(),
                        status: step.status.clone(),
                        log_path: path_if_exists(step.log_path.as_deref()),
                    })
                    .collect()
            });

            RunResultJobEntry {
                name: result.name.clone(),
                workflow: result.workflow.clone(),
                status,
                duration_ms: result.duration_ms,
                failing_step: result.failing_step.clone(),
                debug_log_path: path_if_exists(result.debug_log_path.as_deref()),
                steps,
            }
        })
        .collect::<Vec<_>>();
    let status = if input.results.iter().all(|result| result.succeeded) {
        JobResultStatus::Passed
    } else {
        JobResultStatus::Failed
    };

    RunResultFile {
        schema_version: RUN_RESULT_SCHEMA_VERSION,
        repo: input.repo.clone(),
        branch: input.branch.clone(),
        worktree_path: absolute_path(&input.worktree_path)
            .to_string_lossy()
            .into_owned(),
        head_sha: input.head_sha.clone(),
        started_at: input.started_at.clone(),
        finished_at: input.finished_at.clone(),
        status,
        jobs,
    }
}

pub fn normalize_run_result(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(object) = value.as_object_mut() {
        for key in ["worktreePath", "startedAt", "finishedAt", "headSha"] {
            object.remove(key);
        }
        if let Some(jobs) = object
            .get_mut("jobs")
            .and_then(serde_json::Value::as_array_mut)
        {
            for job in jobs {
                if let Some(job) = job.as_object_mut() {
                    job.remove("durationMs");
                    job.remove("debugLogPath");
                    if let Some(steps) = job
                        .get_mut("steps")
                        .and_then(serde_json::Value::as_array_mut)
                    {
                        for step in steps {
                            if let Some(step) = step.as_object_mut() {
                                step.remove("logPath");
                            }
                        }
                    }
                }
            }
        }
    }
    value
}

fn path_if_exists(path: Option<&Path>) -> Option<String> {
    path.filter(|path| path.exists())
        .map(|path| path.to_string_lossy().into_owned())
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn normalizes_run_result_contract_fields() {
        let value = json!({
            "schemaVersion": 1,
            "repo": "owner/repo",
            "branch": "main",
            "worktreePath": "/tmp/repo",
            "headSha": "abc",
            "startedAt": "t0",
            "finishedAt": "t1",
            "status": "failed",
            "jobs": [{
                "name": "test",
                "workflow": "ci.yml",
                "status": "failed",
                "durationMs": 10,
                "failingStep": "Run tests",
                "debugLogPath": "/tmp/debug.log",
                "steps": [{"name":"Run tests","status":"failed","logPath":"/tmp/step.log"}]
            }]
        });

        assert_eq!(
            normalize_run_result(value),
            json!({
                "schemaVersion": 1,
                "repo": "owner/repo",
                "branch": "main",
                "status": "failed",
                "jobs": [{
                    "name": "test",
                    "workflow": "ci.yml",
                    "status": "failed",
                    "failingStep": "Run tests",
                    "steps": [{"name":"Run tests","status":"failed"}]
                }]
            })
        );
    }

    #[test]
    fn run_result_fixture_contracts_match_snapshots() {
        let fixtures =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../local-ci/fixtures/run-results");
        let mut entries = fs::read_dir(&fixtures)
            .expect("run-result fixtures directory should exist")
            .collect::<Result<Vec<_>, _>>()
            .expect("run-result fixtures should be readable")
            .into_iter()
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.path());
        assert!(!entries.is_empty(), "expected run-result fixtures");

        for entry in entries {
            let fixture: serde_json::Value = serde_json::from_slice(
                &fs::read(entry.path()).expect("run-result fixture should be readable"),
            )
            .expect("run-result fixture should be valid JSON");
            let actual = normalize_run_result(fixture["input"].clone());
            assert_eq!(
                actual,
                fixture["normalized"],
                "run-result fixture mismatch: {}",
                entry.path().display()
            );
        }
    }
}
