use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerSocket {
    pub socket_path: String,
    pub uri: String,
    pub bind_mount_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerSocketError {
    message: String,
}

impl DockerSocketError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn contains(&self, needle: &str) -> bool {
        self.message.contains(needle)
    }
}

impl std::fmt::Display for DockerSocketError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for DockerSocketError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerSocketProbe {
    pub env: BTreeMap<String, String>,
    pub existing_paths: BTreeSet<String>,
    pub accessible_paths: BTreeSet<String>,
    pub realpaths: BTreeMap<String, String>,
    pub docker_context_host: Option<String>,
    pub home: Option<PathBuf>,
}

impl DockerSocketProbe {
    pub fn from_process() -> Self {
        Self {
            env: std::env::vars().collect(),
            existing_paths: BTreeSet::new(),
            accessible_paths: BTreeSet::new(),
            realpaths: BTreeMap::new(),
            docker_context_host: active_docker_context_host(),
            home: std::env::var_os("HOME").map(PathBuf::from),
        }
    }

    fn exists(&self, path: &str) -> bool {
        if self.existing_paths.is_empty() {
            Path::new(path).exists()
        } else {
            self.existing_paths.contains(path)
        }
    }

    fn resolve_if_exists(&self, path: &str) -> Option<String> {
        let resolved = self
            .realpaths
            .get(path)
            .cloned()
            .unwrap_or_else(|| path.to_owned());
        if self.existing_paths.is_empty() {
            let real = fs::canonicalize(path).ok()?;
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&real)
                .ok()?;
            return Some(real.to_string_lossy().into_owned());
        }
        (self.exists(path) && self.accessible_paths.contains(&resolved)).then_some(resolved)
    }

    fn docker_desktop_running_without_default_socket(&self) -> bool {
        let Some(home) = &self.home else {
            return false;
        };
        self.exists(&home.join(".docker/run/docker.sock").to_string_lossy())
    }
}

pub fn resolve_docker_socket(probe: &DockerSocketProbe) -> Result<DockerSocket, DockerSocketError> {
    if let Some(env_host) = probe
        .env
        .get("LOCAL_CI_DOCKER_HOST")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if !env_host.starts_with("unix://") {
            return Ok(DockerSocket {
                socket_path: String::new(),
                uri: env_host.to_owned(),
                bind_mount_path: String::new(),
            });
        }
        let socket_path = env_host.trim_start_matches("unix://");
        if let Some(resolved) = probe.resolve_if_exists(socket_path) {
            return Ok(DockerSocket {
                socket_path: resolved.clone(),
                uri: format!("unix://{resolved}"),
                bind_mount_path: socket_path.to_owned(),
            });
        }
        return Err(unusable_socket_error(
            probe,
            &format!("LOCAL_CI_DOCKER_HOST={env_host} does not resolve to a working socket."),
        ));
    }

    if !probe.exists(DEFAULT_SOCKET) {
        return Err(unusable_socket_error(
            probe,
            &format!("{DEFAULT_SOCKET} is missing or a dangling symlink."),
        ));
    }

    if let Some(resolved) = probe.resolve_if_exists(DEFAULT_SOCKET) {
        return Ok(DockerSocket {
            socket_path: resolved.clone(),
            uri: format!("unix://{resolved}"),
            bind_mount_path: DEFAULT_SOCKET.to_owned(),
        });
    }

    if let Some(context_host) = &probe.docker_context_host {
        if let Some(socket_path) = context_host.strip_prefix("unix://") {
            if probe.exists(socket_path) {
                return Ok(DockerSocket {
                    socket_path: socket_path.to_owned(),
                    uri: format!("unix://{socket_path}"),
                    bind_mount_path: DEFAULT_SOCKET.to_owned(),
                });
            }
        }
    }

    Err(unusable_socket_error(
        probe,
        &format!(
            "{DEFAULT_SOCKET} exists but is not readable, and no active docker context provides an alternative."
        ),
    ))
}

fn active_docker_context_host() -> Option<String> {
    let output = Command::new("docker")
        .args([
            "context",
            "inspect",
            "--format",
            "{{.Endpoints.docker.Host}}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty() && value != "<no value>").then_some(value)
}

fn unusable_socket_error(probe: &DockerSocketProbe, detail: &str) -> DockerSocketError {
    let mut lines = vec![
        "local-ci couldn't use a Docker socket at /var/run/docker.sock.".to_owned(),
        detail.to_owned(),
        String::new(),
        "A working Docker socket is required there (or set LOCAL_CI_DOCKER_HOST explicitly)."
            .to_owned(),
    ];
    if probe.docker_desktop_running_without_default_socket() {
        lines.extend([
            String::new(),
            "Docker Desktop is running but the default socket is disabled.".to_owned(),
            "Enable it: Docker Desktop → Settings → Advanced →".to_owned(),
            "  \"Allow the default Docker socket to be used (requires password)\" → Apply & Restart.".to_owned(),
        ]);
    }
    lines.extend([String::new(), format!("See: {DOCS_URL}")]);
    DockerSocketError::new(lines.join("\n"))
}
