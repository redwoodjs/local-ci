use super::*;

pub fn discover_workflow_run(
    args: &RunArgs,
    current_dir: &Path,
) -> Result<WorkflowDiscovery, RunDiscoveryError> {
    let workflow_arg = args
        .workflow
        .as_ref()
        .ok_or(RunDiscoveryError::MissingWorkflow)?;
    let repo_root = resolve_repo_root(current_dir);
    let workflow_path = resolve_workflow_arg_path(workflow_arg, current_dir, &repo_root);
    if !workflow_path.exists() {
        return Err(RunDiscoveryError::WorkflowNotFound(workflow_path));
    }

    let workflow = parse_workflow_file(&workflow_path)?;
    let repo_root = resolve_repo_root_from_workflow(&workflow_path, current_dir);
    let effective_sha = resolve_effective_sha(&repo_root, args.sha.as_deref())?;
    let jobs = runnable_jobs(&workflow);
    let diagnostics = workflow
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.message.clone())
        .collect();

    Ok(WorkflowDiscovery {
        workflow_path,
        repo_root,
        effective_sha,
        jobs,
        diagnostics,
    })
}

pub fn discover_all_workflows(
    current_dir: &Path,
) -> Result<AllWorkflowDiscovery, RunDiscoveryError> {
    let repo_root = resolve_repo_root(current_dir);
    let branch = current_branch(&repo_root)?;
    let changed_files = get_changed_files(&repo_root);
    let (relevant, skipped) = discover_relevant_workflows(&repo_root, &branch, &changed_files)?;

    Ok(AllWorkflowDiscovery {
        repo_root,
        branch,
        changed_files,
        relevant,
        skipped,
    })
}

pub fn discover_relevant_workflows(
    repo_root: &Path,
    branch: &str,
    changed_files: &[String],
) -> Result<(Vec<PathBuf>, Vec<SkippedWorkflow>), RunDiscoveryError> {
    let workflows_dir = repo_root.join(".github/workflows");
    if !workflows_dir.exists() {
        return Err(RunDiscoveryError::MissingWorkflowsDir(
            repo_root.to_path_buf(),
        ));
    }

    let mut files = fs::read_dir(&workflows_dir)
        .map_err(|_| RunDiscoveryError::MissingWorkflowsDir(repo_root.to_path_buf()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| matches!(extension, "yml" | "yaml"))
        })
        .collect::<Vec<_>>();
    files.sort();

    let mut relevant = Vec::new();
    let mut skipped = Vec::new();
    for file in files {
        match parse_workflow_file(&file) {
            Ok(workflow) => {
                let Some(on) = workflow.on.as_ref() else {
                    skipped.push(SkippedWorkflow {
                        path: file,
                        reason: "missing `on` trigger".to_owned(),
                    });
                    continue;
                };
                let events = extract_events(on);
                if is_workflow_relevant(&events, branch, changed_files) {
                    relevant.push(file);
                } else {
                    skipped.push(SkippedWorkflow {
                        path: file,
                        reason: "event filters did not match".to_owned(),
                    });
                }
            }
            Err(err) => skipped.push(SkippedWorkflow {
                path: file,
                reason: err.to_string(),
            }),
        }
    }

    Ok((relevant, skipped))
}

pub fn get_changed_files(repo_root: &Path) -> Vec<String> {
    git(repo_root, None, &["diff", "--name-only", "HEAD~1"])
        .map(|stdout| {
            stdout
                .lines()
                .filter(|line| !line.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn runnable_jobs(workflow: &WorkflowDocument) -> Vec<RunnableJob> {
    workflow
        .jobs
        .values()
        .map(|job| RunnableJob {
            id: job.id.clone(),
            display_name: job.name.clone().unwrap_or_else(|| job.id.clone()),
            runs_on: job.runs_on.as_ref().map(format_runs_on),
            uses: job.uses.clone(),
            step_count: job.steps.len(),
        })
        .collect()
}

pub fn resolve_effective_sha(
    repo_root: &Path,
    explicit_sha: Option<&str>,
) -> Result<EffectiveSha, RunDiscoveryError> {
    if let Some(sha) = explicit_sha {
        let head_sha = resolve_head_sha(repo_root, sha)?;
        return Ok(EffectiveSha {
            head_sha,
            sha_ref: Some(sha.to_owned()),
            source: EffectiveShaSource::Explicit,
        });
    }

    if let Some(dirty_sha) = compute_dirty_sha(repo_root) {
        return Ok(EffectiveSha {
            head_sha: dirty_sha,
            sha_ref: None,
            source: EffectiveShaSource::DirtyTree,
        });
    }

    Ok(EffectiveSha {
        head_sha: resolve_head_sha(repo_root, "HEAD")?,
        sha_ref: Some("HEAD".to_owned()),
        source: EffectiveShaSource::Head,
    })
}

pub(super) fn current_branch(repo_root: &Path) -> Result<String, RunDiscoveryError> {
    git(repo_root, None, &["rev-parse", "--abbrev-ref", "HEAD"]).map_err(|_| {
        RunDiscoveryError::RefResolve {
            repo_root: repo_root.to_path_buf(),
            reference: "HEAD".to_owned(),
        }
    })
}

pub(super) fn resolve_head_sha(repo_root: &Path, sha: &str) -> Result<String, RunDiscoveryError> {
    git(repo_root, None, &["rev-parse", sha]).map_err(|_| RunDiscoveryError::RefResolve {
        repo_root: repo_root.to_path_buf(),
        reference: sha.to_owned(),
    })
}

pub(super) fn compute_dirty_sha(repo_root: &Path) -> Option<String> {
    let status = git(repo_root, None, &["status", "--porcelain"]).ok()?;
    if status.is_empty() {
        return None;
    }

    let git_dir = git(repo_root, None, &["rev-parse", "--git-dir"]).ok()?;
    let git_dir = {
        let path = PathBuf::from(git_dir);
        if path.is_absolute() {
            path
        } else {
            repo_root.join(path)
        }
    };
    let tmp_index = git_dir.join(format!("index-local-ci-rust-{}", now_nanos()));

    let result = (|| {
        fs::copy(git_dir.join("index"), &tmp_index).ok()?;
        let tmp_index_value = tmp_index.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", tmp_index_value.as_str())];
        git(repo_root, Some(&env), &["add", "-A"]).ok()?;
        let tree = git(repo_root, Some(&env), &["write-tree"]).ok()?;
        let commit_env = [
            ("GIT_AUTHOR_NAME", "Local CI"),
            ("GIT_AUTHOR_EMAIL", "local-ci@example.invalid"),
            ("GIT_COMMITTER_NAME", "Local CI"),
            ("GIT_COMMITTER_EMAIL", "local-ci@example.invalid"),
        ];
        git(
            repo_root,
            Some(&commit_env),
            &[
                "commit-tree",
                &tree,
                "-p",
                "HEAD",
                "-m",
                "local-ci: dirty working tree",
            ],
        )
        .ok()
    })();

    let _ = fs::remove_file(tmp_index);
    result
}

pub(super) fn git(
    repo_root: &Path,
    env: Option<&[(&str, &str)]>,
    args: &[&str],
) -> Result<String, String> {
    let mut command = Command::new("git");
    command.args(args).current_dir(repo_root);
    if let Some(env) = env {
        for (key, value) in env {
            command.env(key, value);
        }
    }
    let output = command.output().map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub(super) fn resolve_workflow_arg_path(
    workflow: &str,
    current_dir: &Path,
    repo_root: &Path,
) -> PathBuf {
    let workflow_path = Path::new(workflow);
    if workflow_path.is_absolute() {
        return workflow_path.to_path_buf();
    }

    let workflows_dir = repo_root.join(".github/workflows");
    let paths_to_try = [
        current_dir.join(workflow_path),
        repo_root.join(workflow_path),
        workflows_dir.join(workflow_path),
    ];
    paths_to_try
        .iter()
        .find(|path| path.exists())
        .cloned()
        .unwrap_or_else(|| repo_root.join(workflow_path))
}

pub(super) fn resolve_repo_root_from_workflow(workflow_path: &Path, current_dir: &Path) -> PathBuf {
    let mut dir = workflow_path
        .parent()
        .unwrap_or(workflow_path)
        .to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return dir;
        }
        if !dir.pop() {
            return resolve_repo_root(current_dir);
        }
    }
}

pub(super) fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunDiscoveryError {
    MissingWorkflow,
    WorkflowNotFound(PathBuf),
    WorkflowParse(String),
    MissingWorkflowsDir(PathBuf),
    RefResolve {
        repo_root: PathBuf,
        reference: String,
    },
}

impl From<WorkflowParseError> for RunDiscoveryError {
    fn from(value: WorkflowParseError) -> Self {
        Self::WorkflowParse(value.to_string())
    }
}

impl std::fmt::Display for RunDiscoveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingWorkflow => write!(formatter, "run requires --workflow <path>"),
            Self::WorkflowNotFound(path) => {
                write!(formatter, "Workflow file not found: {}", path.display())
            }
            Self::WorkflowParse(message) => write!(formatter, "{message}"),
            Self::MissingWorkflowsDir(repo_root) => write!(
                formatter,
                "No .github/workflows directory found in {}",
                repo_root.display()
            ),
            Self::RefResolve { reference, .. } => {
                write!(formatter, "Failed to resolve ref: {reference}")
            }
        }
    }
}

impl std::error::Error for RunDiscoveryError {}
