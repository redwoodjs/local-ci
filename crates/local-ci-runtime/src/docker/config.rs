use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedContainerOptions {
    pub env: Vec<String>,
    pub labels: BTreeMap<String, String>,
}

pub fn parse_container_options(options: Option<&str>) -> ParsedContainerOptions {
    let mut parsed = ParsedContainerOptions::default();
    let Some(options) = options else {
        return parsed;
    };
    let tokens = options.split_whitespace().collect::<Vec<_>>();
    let mut index = 0;
    while index < tokens.len() {
        match tokens[index] {
            "--env" | "-e" if index + 1 < tokens.len() => {
                index += 1;
                parsed.env.push(tokens[index].to_owned());
            }
            "--label" | "-l" if index + 1 < tokens.len() => {
                index += 1;
                let token = tokens[index];
                let (key, value) = token.split_once('=').unwrap_or((token, ""));
                parsed.labels.insert(key.to_owned(), value.to_owned());
            }
            _ => {}
        }
        index += 1;
    }
    parsed
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerEnvOpts {
    pub container_name: String,
    pub registration_token: String,
    pub repo_url: String,
    pub docker_api_url: String,
    pub github_repo: String,
    pub head_sha: Option<String>,
    pub dtu_host: String,
    pub use_direct_container: bool,
}

pub fn build_container_env(opts: &ContainerEnvOpts) -> Vec<String> {
    let mut env = vec![
        format!("RUNNER_NAME={}", opts.container_name),
        format!("RUNNER_TOKEN={}", opts.registration_token),
        format!("RUNNER_REPOSITORY_URL={}", opts.repo_url),
        format!("GITHUB_API_URL={}", opts.docker_api_url),
        format!("GITHUB_SERVER_URL={}", opts.repo_url),
        format!("GITHUB_REPOSITORY={}", opts.github_repo),
        "LOCAL_CI_LOCAL=true".to_owned(),
        "LOCAL_CI_LOCAL_SYNC=true".to_owned(),
        format!("LOCAL_CI_HEAD_SHA={}", opts.head_sha.as_deref().unwrap_or("HEAD")),
        format!("LOCAL_CI_DTU_HOST={}", opts.dtu_host),
        "AGENT_CI_LOCAL=true".to_owned(),
        "AGENT_CI_LOCAL_SYNC=true".to_owned(),
        format!("AGENT_CI_HEAD_SHA={}", opts.head_sha.as_deref().unwrap_or("HEAD")),
        format!("AGENT_CI_DTU_HOST={}", opts.dtu_host),
        format!("ACTIONS_CACHE_URL={}/", opts.docker_api_url),
        format!("ACTIONS_RESULTS_URL={}/", opts.docker_api_url),
        "ACTIONS_RUNTIME_TOKEN=mock_cache_token_123".to_owned(),
        "RUNNER_TOOL_CACHE=/opt/hostedtoolcache".to_owned(),
        "PATH=/home/runner/externals/node24/bin:/home/runner/externals/node20/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_owned(),
        "FORCE_COLOR=1".to_owned(),
    ];
    if opts.use_direct_container {
        env.push("RUNNER_ALLOW_RUNASROOT=1".to_owned());
        env.push("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1".to_owned());
    }
    env
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerBindsOpts {
    pub host_work_dir: String,
    pub shims_dir: String,
    pub signals_dir: Option<String>,
    pub diag_dir: String,
    pub tool_cache_dir: String,
    pub pnpm_store_dir: Option<String>,
    pub npm_cache_dir: Option<String>,
    pub yarn_cache_dir: Option<String>,
    pub bun_cache_dir: Option<String>,
    pub playwright_cache_dir: String,
    pub cypress_cache_dir: Option<String>,
    pub host_runner_dir: String,
    pub use_direct_container: bool,
    pub github_repo: String,
    pub docker_socket_path: Option<String>,
}

pub fn build_container_binds(opts: &ContainerBindsOpts) -> Vec<String> {
    let docker_socket_path = opts.docker_socket_path.as_deref().unwrap_or(DEFAULT_SOCKET);
    let mut binds = Vec::new();
    if opts.use_direct_container {
        binds.push(format!("{}:/home/runner", opts.host_runner_dir));
    }
    binds.extend([
        format!("{}:/home/runner/_work", opts.host_work_dir),
        format!("{docker_socket_path}:/var/run/docker.sock"),
        format!("{}:/tmp/local-ci-shims", opts.shims_dir),
    ]);
    if let Some(signals_dir) = &opts.signals_dir {
        binds.push(format!("{signals_dir}:/tmp/local-ci-signals"));
    }
    binds.extend([
        format!("{}:/home/runner/_diag", opts.diag_dir),
        format!("{}:/opt/hostedtoolcache", opts.tool_cache_dir),
    ]);
    if let Some(dir) = &opts.pnpm_store_dir {
        binds.push(format!("{dir}:/home/runner/_work/.pnpm-store"));
    }
    if let Some(dir) = &opts.npm_cache_dir {
        binds.push(format!("{dir}:/home/runner/.npm"));
    }
    if let Some(dir) = &opts.yarn_cache_dir {
        binds.push(format!("{dir}:/home/runner/.cache/yarn"));
    }
    if let Some(dir) = &opts.bun_cache_dir {
        binds.push(format!("{dir}:/home/runner/.bun"));
    }
    binds.push(format!(
        "{}:/home/runner/.cache/ms-playwright",
        opts.playwright_cache_dir
    ));
    if let Some(dir) = &opts.cypress_cache_dir {
        binds.push(format!("{dir}:/home/runner/.cache/Cypress"));
    }
    binds
}

pub fn cache_permission_fix_commands() -> Vec<String> {
    vec![
        // Playwright and Cypress live under /home/runner/.cache. Bind mounts can
        // create that parent as root inside Docker Desktop/Colima, so make the
        // parent writable before package installers try to populate it.
        "MAYBE_SUDO chmod 1777 /home/runner/.cache 2>/dev/null || true".to_owned(),
        "MAYBE_SUDO chmod 1777 /home/runner/_work 2>/dev/null || true".to_owned(),
    ]
}

pub fn docker_socket_permission_fix_command() -> String {
    // Native Linux Docker commonly exposes /var/run/docker.sock as root:docker
    // 0660. The runner user is not in the host docker group, so buildx/docker
    // steps need the same pre-step chmod used by the TypeScript runner path.
    "MAYBE_SUDO chmod 666 /var/run/docker.sock 2>/dev/null || true".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerCmdOpts {
    pub dtu_port: String,
    pub dtu_host: String,
    pub use_direct_container: bool,
    pub container_name: String,
}

pub fn build_container_cmd(opts: &ContainerCmdOpts) -> Vec<String> {
    let dtu_base_url = format!("http://{}:{}", opts.dtu_host, opts.dtu_port);
    let credential_snippet = if opts.use_direct_container {
        String::new()
    } else {
        format!(
            "echo '{{\"agentId\":1,\"agentName\":\"{}\",\"poolId\":1,\"poolName\":\"Default\",\"serverUrl\":\"{}\",\"gitHubUrl\":\"{}/'$GITHUB_REPOSITORY'\",\"workFolder\":\"_work\",\"ephemeral\":true}}' > /home/runner/.runner && echo '{{\"scheme\":\"OAuth\",\"data\":{{\"clientId\":\"00000000-0000-0000-0000-000000000000\",\"authorizationUrl\":\"{}/_apis/oauth2/token\",\"oAuthEndpointUrl\":\"{}/_apis/oauth2/token\",\"requireFipsCryptography\":\"False\"}}}}' > /home/runner/.credentials && echo '{{\"d\":\"CQpCI+sO2GD1N/JsHHI9zEhMlu5Fcc8mU4O2bO6iscOsagFjvEnTesJgydC/Go1HuOBlx+GT9EG2h7+juS0z2o5n8Mvt5BBxlK+tqoDOs8VfQ9CSUl3hqYRPeNdBfnA1w8ovLW0wqfPO08FWTLI0urYsnwjZ5BQrBM+D7zYeA0aCsKdo75bKmaEKnmqrtIEhb7hE45XQa32Yt0RPCPi8QcQAY2HLHbdWdZYDj6k/UuDvz9H/xlDzwYq6Yikk2RSMArFzaufxCGS9tBZNEACDPYgnZnEMXRcvsnZ9FYbq81KOSifCmq7Yocq+j3rY5zJCD+PIDY9QJwPxB4PGasRKAQ==\",\"dp\":\"A0sY1oOz1+3uUMiy+I5xGuHGHOrEQPYspd1xGClBYYsa/Za0UDWS7V0Tn1cbRWfWtNe5vTpxcvwQd6UZBwrtHF6R2zyXFhE++PLPhCe0tH4C5FY9i9jUw9Vo8t44i/s5JUHU2B1mEptXFUA0GcVrLKS8toZSgqELSS2Q/YLRxoE=\",\"dq\":\"GrLC9dPJ5n3VYw51ghCH7tybUN9/Oe4T8d9v4dLQ34RQEWHwRd4g3U3zkvuhpXFPloUTMmkxS7MF5pS1evrtzkay4QUTDv+28s0xRuAsw5qNTzuFygg8t93MvpvTVZ2TNApW6C7NFvkL9NbxAnU8+I61/3ow7i6a7oYJJ0hWAxE=\",\"exponent\":\"AQAB\",\"inverseQ\":\"8DVz9FSvEdt5W4B9OjgakZHwGfnhn2VLDUxrsR5ilC5tPC/IgA8C2xEfKQM1t+K/N3pAYHBYQ6EPgtW4kquBS/Sy102xbRI7GSCnUbRtTpWYPOaCn6EaxBNzwWzbp5vCbCGvFqlSu4+OBYRVe+iCj+gAnkmT/TKPhHHbTjJHvw==\",\"modulus\":\"x0eoW2DD7xsW5YiorMN8pNHVvZk4ED1SHlA/bmVnRz5FjEDnQloMn0nBgIUHxoNArksknrp/FOVJv5sJHJTiRZkOp+ZmH7d3W3gmw63IxK2C5pV+6xfav9jR2+Wt/6FMYMgG2utBdF95oif1f2XREFovHoXkWms2l0CPLLHVPO44Hh9EEmBmjOeMJEZkulHJ44z9y8e+GZ2nYqO0ZiRWQcRObZ0vlRaGg6PPOl4ltay0BfNksMB3NDtlhkdVkAEFQxEaZZDK9NtkvNljXCioP3TyTAbqNUGsYCA5D+IHGZT9An99J9vUqTFP6TKjqUvy9WNiIzaUksCySA0a4SVBkQ==\",\"p\":\"8fgAdmWy+sTzAN19fYkWMQqeC7t1BCQMo5z5knfVLg8TtwP9ZGqDtoe+r0bGv3UgVsvvDdP/QwRvRVP+5G9l999Y6b4VbSdUbrfPfOgjpPDmRTQzHDve5jh5xBENQoRXYm7PMgHGmjwuFsE/tKtSGTrvt2Z3qcYAo0IOqLLhYmE=\",\"q\":\"0tXx4+P7gUWePf92UJLkzhNBClvdnmDbIt52Lui7YCARczbN/asCDJxcMy6Bh3qmIx/bNuOUrfzHkYZHfnRw8AGEK80qmiLLPI6jrUBOGRajmzemGQx0W8FWalEQfGdNIv9R2nsegDRoMq255Zo/qX60xQ6abpp0c6UNhVYSjTE=\"}}' > /home/runner/.credentials_rsaparams && ",
            opts.container_name, dtu_base_url, dtu_base_url, dtu_base_url, dtu_base_url
        )
    };

    let script = [
        "MAYBE_SUDO() { if command -v sudo >/dev/null 2>&1; then sudo -n \"$@\"; else \"$@\"; fi; }".to_owned(),
        "BOOT_T0=$(date +%s%3N); T0=$BOOT_T0".to_owned(),
        "if [ -f /usr/bin/git ]; then MAYBE_SUDO mv /usr/bin/git /usr/bin/git.real 2>/dev/null || true; MAYBE_SUDO cp -p /tmp/local-ci-shims/git /usr/bin/git 2>/dev/null; MAYBE_SUDO chmod +x /usr/bin/git 2>/dev/null; fi".to_owned(),
        "T1=$(date +%s%3N); echo \"[local-ci:boot] git-shim: $((T1-T0))ms\"; T0=$T1".to_owned(),
        docker_socket_permission_fix_command(),
        "T1=$(date +%s%3N); echo \"[local-ci:boot] docker-sock: $((T1-T0))ms\"; T0=$T1".to_owned(),
    ]
    .into_iter()
    .chain(cache_permission_fix_commands())
    .chain([
        "MAYBE_SUDO chmod 1777 /home/runner/_diag 2>/dev/null || true".to_owned(),
        "cd /home/runner".to_owned(),
        format!("{credential_snippet}true"),
        "T1=$(date +%s%3N); echo \"[local-ci:boot] credentials: $((T1-T0))ms\"; T0=$T1".to_owned(),
        "REPO_NAME=$(basename $GITHUB_REPOSITORY)".to_owned(),
        "WORKSPACE_PATH=/home/runner/_work/$REPO_NAME/$REPO_NAME".to_owned(),
        "mkdir -p $WORKSPACE_PATH /home/runner/_work/_actions /home/runner/_work/_temp /home/runner/_work/_tool".to_owned(),
        "T1=$(date +%s%3N); echo \"[local-ci:boot] workspace-setup: $((T1-T0))ms\"; T0=$T1".to_owned(),
        "echo \"[local-ci:boot] total: $(($(date +%s%3N)-BOOT_T0))ms\"".to_owned(),
        "echo \"[local-ci:boot] starting run.sh --once\"".to_owned(),
        "./run.sh --once".to_owned(),
    ])
    .collect::<Vec<_>>()
    .join(" && ");

    if opts.use_direct_container {
        vec!["-c".to_owned(), script]
    } else {
        vec!["bash".to_owned(), "-c".to_owned(), script]
    }
}

pub fn resolve_docker_api_url(dtu_url: &str, dtu_host: &str) -> String {
    let Some((scheme, rest)) = dtu_url.split_once("://") else {
        return dtu_url.to_owned();
    };
    let (authority, suffix) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
    let new_host = if matches!(host, "localhost" | "127.0.0.1" | "::1") {
        dtu_host
    } else {
        host
    };
    let authority = if port.is_empty() {
        new_host.to_owned()
    } else {
        format!("{new_host}:{port}")
    };
    if suffix.is_empty() {
        format!("{scheme}://{authority}")
    } else {
        format!("{scheme}://{authority}/{suffix}")
    }
}

pub fn resolve_docker_extra_hosts(
    env: &BTreeMap<String, String>,
    dtu_host: &str,
) -> Option<Vec<String>> {
    if let Some(configured) = env.get("LOCAL_CI_DOCKER_EXTRA_HOSTS") {
        let parsed = configured
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        return (!parsed.is_empty()).then_some(parsed);
    }
    if env
        .get("LOCAL_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS")
        .is_some_and(|value| value == "1")
    {
        return None;
    }
    if dtu_host != DEFAULT_DTU_HOST_ALIAS {
        return None;
    }
    let gateway = env
        .get("LOCAL_CI_DOCKER_HOST_GATEWAY")
        .map(String::as_str)
        .unwrap_or(DEFAULT_DOCKER_HOST_GATEWAY);
    Some(vec![format!("{DEFAULT_DTU_HOST_ALIAS}:{gateway}")])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerRunConfig {
    pub name: String,
    pub image: String,
    pub network: String,
    pub env: Vec<String>,
    pub binds: Vec<String>,
    pub extra_hosts: Vec<String>,
    pub ports: BTreeMap<String, String>,
    pub options: Option<String>,
    pub health_cmd: Option<String>,
    pub detach: bool,
    pub command: Vec<String>,
}

fn split_shell_words(input: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (Some(q), c) if c == q => quote = None,
            (None, '\'' | '"') => quote = Some(ch),
            (None, c) if c.is_whitespace() => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            (_, '\\') => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            (_, c) => current.push(c),
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

pub fn docker_run_args(config: &DockerRunConfig) -> Vec<String> {
    let mut args = vec!["run".to_owned()];
    if config.detach {
        args.push("-d".to_owned());
    }
    args.extend([
        "--name".to_owned(),
        config.name.clone(),
        "--network".to_owned(),
        config.network.clone(),
    ]);
    for env in &config.env {
        args.extend(["-e".to_owned(), env.clone()]);
    }
    for bind in &config.binds {
        args.extend(["-v".to_owned(), bind.clone()]);
    }
    for host in &config.extra_hosts {
        args.extend(["--add-host".to_owned(), host.clone()]);
    }
    for (container_port, host_port) in &config.ports {
        args.extend(["-p".to_owned(), format!("{host_port}:{container_port}")]);
    }
    if let Some(health_cmd) = &config.health_cmd {
        args.extend(["--health-cmd".to_owned(), health_cmd.clone()]);
    }
    if let Some(options) = &config.options {
        args.extend(split_shell_words(options));
    }
    args.push(config.image.clone());
    args.extend(config.command.iter().cloned());
    args
}

pub fn docker_network_create_args(name: &str) -> Vec<String> {
    vec!["network".to_owned(), "create".to_owned(), name.to_owned()]
}

pub fn docker_network_remove_args(name: &str) -> Vec<String> {
    vec!["network".to_owned(), "rm".to_owned(), name.to_owned()]
}

pub fn docker_rm_force_args(name: &str) -> Vec<String> {
    vec!["rm".to_owned(), "-f".to_owned(), name.to_owned()]
}
