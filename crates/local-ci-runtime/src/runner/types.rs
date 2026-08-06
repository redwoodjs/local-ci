use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobExecutionPlan {
    pub workflow: String,
    pub job_id: String,
    pub runner_name: String,
    pub container_name: String,
    pub image: String,
    pub env: Vec<String>,
    pub binds: Vec<String>,
    pub extra_hosts: Vec<String>,
    pub command: Vec<String>,
    pub log_dir: PathBuf,
    pub signals_dir: PathBuf,
    pub services: Vec<ServiceSpec>,
    pub pause_on_failure: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DtuRunnerRegistration {
    pub runner_name: String,
    pub log_dir: PathBuf,
    pub timeline_dir: PathBuf,
    pub virtual_cache_patterns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DtuJobSeed {
    pub id: String,
    pub runner_name: String,
    pub name: String,
    pub workflow_name: String,
    pub repo_root: PathBuf,
    pub github_repo: String,
    pub head_sha: String,
    pub real_head_sha: String,
    pub runner_work_dir: Option<PathBuf>,
    pub runner_os: Option<String>,
    pub runner_arch: Option<String>,
    pub env: BTreeMap<String, String>,
    pub outputs: BTreeMap<String, String>,
    pub needs_context: BTreeMap<String, local_ci_core::plan::NeedContext>,
    pub container: Option<DtuJobContainer>,
    pub services: Vec<ServiceSpec>,
    pub matrix_context: Option<BTreeMap<String, String>>,
    pub steps: Vec<DtuJobStep>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DtuJobContainer {
    pub image: String,
    pub env: BTreeMap<String, String>,
    pub ports: Vec<String>,
    pub volumes: Vec<String>,
    pub options: Option<String>,
}

impl From<&local_ci_core::plan::PlannedJobContainer> for DtuJobContainer {
    fn from(container: &local_ci_core::plan::PlannedJobContainer) -> Self {
        Self {
            image: container.image.clone(),
            env: container.env.clone(),
            ports: container.ports.clone(),
            volumes: container.volumes.clone(),
            options: container.options.clone(),
        }
    }
}

impl DtuJobContainer {
    fn to_payload(&self) -> Value {
        json!({
            "image": self.image,
            "env": self.env,
            "ports": self.ports,
            "volumes": self.volumes,
            "options": self.options,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DtuJobStep {
    pub name: String,
    pub context_name: Option<String>,
    pub run: Option<String>,
    pub uses: Option<String>,
    pub condition: Option<String>,
    pub shell: Option<String>,
    pub working_directory: Option<String>,
    pub env: BTreeMap<String, String>,
    pub with: BTreeMap<String, String>,
}

impl DtuJobSeed {
    pub fn to_payload(&self) -> Value {
        json!({
            "id": self.id,
            "runnerName": self.runner_name,
            "name": self.name,
            "workflowName": self.workflow_name,
            "repoRoot": self.repo_root,
            "githubRepo": self.github_repo,
            "headSha": self.head_sha,
            "realHeadSha": self.real_head_sha,
            "runnerWorkDir": self.runner_work_dir,
            "runnerOs": self.runner_os,
            "runnerArch": self.runner_arch,
            "env": self.env,
            "outputs": self.outputs,
            "needs": self.needs_context.iter().map(|(key, value)| (key.clone(), json!({ "result": value.result, "outputs": value.outputs }))).collect::<serde_json::Map<_, _>>(),
            "container": self.container.as_ref().map(DtuJobContainer::to_payload),
            "services": self.services.iter().map(ServiceSpec::to_payload).collect::<Vec<_>>(),
            "matrix": self.matrix_context.clone().unwrap_or_default(),
            "repository": {
                "full_name": self.github_repo,
                "name": self.github_repo.split('/').next_back().unwrap_or(&self.github_repo),
                "owner": { "login": self.github_repo.split('/').next().unwrap_or("local") },
                "default_branch": "main",
            },
            "steps": self.steps.iter().map(DtuJobStep::to_payload).collect::<Vec<_>>(),
        })
    }
}

impl DtuJobStep {
    pub fn to_payload(&self) -> Value {
        let mut payload = json!({ "name": self.name });
        if let Some(context_name) = &self.context_name {
            payload["ContextName"] = Value::String(context_name.clone());
        }
        if let Some(run) = &self.run {
            let script = apply_shell_override(run, self.shell.as_deref());
            let mut inputs = serde_json::Map::new();
            inputs.insert("script".to_owned(), Value::String(script));
            if let Some(working_directory) = &self.working_directory {
                inputs.insert(
                    "workingDirectory".to_owned(),
                    Value::String(working_directory.clone()),
                );
            }
            payload["run"] = Value::String(run.clone());
            payload["Inputs"] = Value::Object(inputs);
        }
        if let Some(uses) = &self.uses {
            payload["uses"] = Value::String(uses.clone());
        }
        if let Some(condition) = &self.condition {
            payload["condition"] = Value::String(normalize_step_condition(condition));
        }
        if !self.env.is_empty() {
            payload["Env"] = json!(self.env);
        }
        if self.run.is_none() && !self.with.is_empty() {
            payload["Inputs"] = json!(self.with);
        }
        payload
    }
}
