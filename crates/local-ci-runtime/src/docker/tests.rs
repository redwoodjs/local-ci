use super::*;
use crate::docker::runtime::{active_endpoint_error, network_container_ids_args};
use serde_json::{Value, json};

fn probe() -> DockerSocketProbe {
    DockerSocketProbe {
        env: BTreeMap::new(),
        existing_paths: BTreeSet::new(),
        accessible_paths: BTreeSet::new(),
        realpaths: BTreeMap::new(),
        docker_context_host: None,
        home: Some(PathBuf::from("/home/me")),
    }
}

#[test]
fn docker_socket_fixture_contracts_match_snapshots() {
    let fixtures =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../local-ci/fixtures/docker-socket");
    let mut entries = fs::read_dir(&fixtures)
        .expect("docker socket fixtures directory should exist")
        .collect::<Result<Vec<_>, _>>()
        .expect("docker socket fixtures should be readable")
        .into_iter()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.path());
    assert!(!entries.is_empty(), "expected docker socket fixtures");

    for entry in entries {
        let fixture: Value = serde_json::from_slice(
            &fs::read(entry.path()).expect("docker socket fixture should be readable"),
        )
        .expect("docker socket fixture should be valid JSON");
        let probe = probe_from_fixture(&fixture["probe"]);
        match (resolve_docker_socket(&probe), fixture.get("expected")) {
            (Ok(socket), Some(expected)) => assert_eq!(
                json!({
                    "socketPath": socket.socket_path,
                    "uri": socket.uri,
                    "bindMountPath": socket.bind_mount_path,
                }),
                *expected,
                "docker socket fixture mismatch: {}",
                entry.path().display()
            ),
            (Err(err), None) => {
                for expected in fixture["expectedErrorContains"]
                    .as_array()
                    .expect("error fixture should list expected substrings")
                {
                    let expected = expected
                        .as_str()
                        .expect("expected substring should be string");
                    assert!(
                        err.contains(expected),
                        "docker socket fixture {} error should contain {expected:?}: {err}",
                        entry.path().display()
                    );
                }
            }
            (Ok(_), None) => panic!("fixture should have failed: {}", entry.path().display()),
            (Err(err), Some(_)) => panic!(
                "fixture should have resolved: {}: {err}",
                entry.path().display()
            ),
        }
    }
}

fn probe_from_fixture(value: &Value) -> DockerSocketProbe {
    let env = value
        .get("env")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default();
    let string_set = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let realpaths = value
        .get("realpaths")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default();
    DockerSocketProbe {
        env,
        existing_paths: string_set("existingPaths"),
        accessible_paths: string_set("accessiblePaths"),
        realpaths,
        docker_context_host: value
            .get("dockerContextHost")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        home: value.get("home").and_then(Value::as_str).map(PathBuf::from),
    }
}

#[test]
fn explicit_non_unix_docker_host_wins() {
    let mut probe = probe();
    probe.env.insert(
        "LOCAL_CI_DOCKER_HOST".to_owned(),
        "ssh://docker-host".to_owned(),
    );

    let socket = resolve_docker_socket(&probe).unwrap();

    assert_eq!(socket.uri, "ssh://docker-host");
    assert_eq!(socket.bind_mount_path, "");
}

#[test]
fn explicit_unix_socket_resolves_real_path_and_keeps_bind_path() {
    let mut probe = probe();
    probe.env.insert(
        "LOCAL_CI_DOCKER_HOST".to_owned(),
        "unix:///tmp/docker.sock".to_owned(),
    );
    probe.existing_paths.insert("/tmp/docker.sock".to_owned());
    probe.realpaths.insert(
        "/tmp/docker.sock".to_owned(),
        "/private/tmp/docker.sock".to_owned(),
    );
    probe
        .accessible_paths
        .insert("/private/tmp/docker.sock".to_owned());

    let socket = resolve_docker_socket(&probe).unwrap();

    assert_eq!(socket.socket_path, "/private/tmp/docker.sock");
    assert_eq!(socket.uri, "unix:///private/tmp/docker.sock");
    assert_eq!(socket.bind_mount_path, "/tmp/docker.sock");
}

#[test]
fn default_socket_uses_var_run_as_bind_mount() {
    let mut probe = probe();
    probe.existing_paths.insert(DEFAULT_SOCKET.to_owned());
    probe
        .realpaths
        .insert(DEFAULT_SOCKET.to_owned(), "/real/docker.sock".to_owned());
    probe
        .accessible_paths
        .insert("/real/docker.sock".to_owned());

    let socket = resolve_docker_socket(&probe).unwrap();

    assert_eq!(socket.socket_path, "/real/docker.sock");
    assert_eq!(socket.bind_mount_path, DEFAULT_SOCKET);
}

#[test]
fn falls_back_to_docker_context_when_default_socket_is_not_accessible() {
    let mut probe = probe();
    probe.existing_paths.insert(DEFAULT_SOCKET.to_owned());
    probe
        .existing_paths
        .insert("/home/me/.docker/desktop/docker.sock".to_owned());
    probe.docker_context_host = Some("unix:///home/me/.docker/desktop/docker.sock".to_owned());

    let socket = resolve_docker_socket(&probe).unwrap();

    assert_eq!(socket.socket_path, "/home/me/.docker/desktop/docker.sock");
    assert_eq!(socket.bind_mount_path, DEFAULT_SOCKET);
}

#[test]
fn missing_default_socket_reports_docker_desktop_hint() {
    let mut probe = probe();
    probe
        .existing_paths
        .insert("/home/me/.docker/run/docker.sock".to_owned());

    let err = resolve_docker_socket(&probe).unwrap_err();

    assert!(err.contains("Docker Desktop is running but the default socket is disabled"));
    assert!(err.contains(DOCS_URL));
}

#[test]
fn detects_active_endpoint_network_remove_errors() {
    assert!(active_endpoint_error(
        "docker network rm failed: network abc has active endpoints"
    ));
    assert!(!active_endpoint_error(
        "docker network rm failed: no such network"
    ));
}

#[test]
fn builds_network_container_ids_inspect_args() {
    assert_eq!(
        network_container_ids_args("local-ci-net"),
        vec![
            "network".to_owned(),
            "inspect".to_owned(),
            "-f".to_owned(),
            "{{range $id, $_ := .Containers}}{{println $id}}{{end}}".to_owned(),
            "local-ci-net".to_owned(),
        ]
    );
}

#[test]
fn parses_container_options_env_and_labels() {
    let parsed = parse_container_options(Some("--env FOO=bar -e BAZ=qux --label a=b -l empty"));

    assert_eq!(parsed.env, vec!["FOO=bar", "BAZ=qux"]);
    assert_eq!(parsed.labels.get("a"), Some(&"b".to_owned()));
    assert_eq!(parsed.labels.get("empty"), Some(&String::new()));
}

#[test]
fn builds_container_environment() {
    let env = build_container_env(&ContainerEnvOpts {
        container_name: "runner".to_owned(),
        registration_token: "token".to_owned(),
        repo_url: "http://github.local/owner/repo".to_owned(),
        docker_api_url: "http://host.docker.internal:1234".to_owned(),
        github_repo: "owner/repo".to_owned(),
        head_sha: Some("abc".to_owned()),
        dtu_host: "host.docker.internal".to_owned(),
        use_direct_container: true,
    });

    assert!(env.contains(&"RUNNER_NAME=runner".to_owned()));
    assert!(env.contains(&"LOCAL_CI_HEAD_SHA=abc".to_owned()));
    assert!(env.contains(&"RUNNER_ALLOW_RUNASROOT=1".to_owned()));
}

#[test]
fn builds_container_binds_with_optional_caches() {
    let binds = build_container_binds(&ContainerBindsOpts {
        host_work_dir: "/work".to_owned(),
        shims_dir: "/shims".to_owned(),
        signals_dir: Some("/signals".to_owned()),
        diag_dir: "/diag".to_owned(),
        tool_cache_dir: "/tools".to_owned(),
        pnpm_store_dir: Some("/pnpm".to_owned()),
        npm_cache_dir: None,
        yarn_cache_dir: Some("/yarn".to_owned()),
        bun_cache_dir: Some("/bun".to_owned()),
        playwright_cache_dir: "/pw".to_owned(),
        cypress_cache_dir: Some("/cypress".to_owned()),
        host_runner_dir: "/runner".to_owned(),
        use_direct_container: true,
        github_repo: "owner/repo".to_owned(),
        docker_socket_path: Some("/docker.sock".to_owned()),
    });

    assert!(binds.contains(&"/runner:/home/runner".to_owned()));
    assert!(binds.contains(&"/docker.sock:/var/run/docker.sock".to_owned()));
    assert!(binds.contains(&"/signals:/tmp/local-ci-signals".to_owned()));
    assert!(binds.contains(&"/yarn:/home/runner/.cache/yarn".to_owned()));
    assert!(binds.contains(&"/cypress:/home/runner/.cache/Cypress".to_owned()));
    assert!(!binds.iter().any(|bind| bind.contains("/node_modules")));
}

#[test]
fn cache_permission_fixes_cover_browser_cache_parent() {
    let commands = cache_permission_fix_commands();

    assert!(
        commands
            .iter()
            .any(|command| command.contains("/home/runner/.cache"))
    );
    assert!(
        commands
            .iter()
            .any(|command| command.contains("/home/runner/_work"))
    );
}

#[test]
fn docker_socket_permission_fix_matches_buildx_needs() {
    let command = docker_socket_permission_fix_command();

    assert!(command.contains("chmod 666 /var/run/docker.sock"));
}

#[test]
fn builds_docker_run_args_for_runner_container() {
    let args = docker_run_args(&DockerRunConfig {
        name: "local-ci-1-j1".to_owned(),
        image: "ghcr.io/redwoodjs/local-ci-runner:latest".to_owned(),
        network: "local-ci-local-ci-1-j1".to_owned(),
        env: vec!["RUNNER_NAME=local-ci-1-j1".to_owned()],
        binds: vec!["/work:/home/runner/_work".to_owned()],
        extra_hosts: vec!["host.docker.internal:host-gateway".to_owned()],
        ports: BTreeMap::new(),
        options: None,
        health_cmd: None,
        detach: true,
        command: vec!["bash".to_owned(), "-c".to_owned(), "echo ok".to_owned()],
    });

    assert_eq!(
        args,
        vec![
            "run",
            "-d",
            "--name",
            "local-ci-1-j1",
            "--network",
            "local-ci-local-ci-1-j1",
            "-e",
            "RUNNER_NAME=local-ci-1-j1",
            "-v",
            "/work:/home/runner/_work",
            "--add-host",
            "host.docker.internal:host-gateway",
            "ghcr.io/redwoodjs/local-ci-runner:latest",
            "bash",
            "-c",
            "echo ok",
        ]
    );
}

#[test]
fn builds_docker_run_args_for_service_container() {
    let mut ports = BTreeMap::new();
    ports.insert("5432".to_owned(), "15432".to_owned());
    let args = docker_run_args(&DockerRunConfig {
        name: "postgres".to_owned(),
        image: "postgres:16".to_owned(),
        network: "local-ci-net".to_owned(),
        env: vec!["POSTGRES_PASSWORD=postgres".to_owned()],
        binds: Vec::new(),
        extra_hosts: Vec::new(),
        ports,
        options: Some("--label local-ci=true".to_owned()),
        health_cmd: Some("pg_isready".to_owned()),
        detach: true,
        command: Vec::new(),
    });

    assert_eq!(
        args,
        vec![
            "run",
            "-d",
            "--name",
            "postgres",
            "--network",
            "local-ci-net",
            "-e",
            "POSTGRES_PASSWORD=postgres",
            "-p",
            "15432:5432",
            "--health-cmd",
            "pg_isready",
            "--label",
            "local-ci=true",
            "postgres:16",
        ]
    );
}

#[test]
fn builds_docker_network_and_remove_args() {
    assert_eq!(
        docker_network_create_args("local-ci-net"),
        vec!["network", "create", "local-ci-net"]
    );
    assert_eq!(
        docker_network_remove_args("local-ci-net"),
        vec!["network", "rm", "local-ci-net"]
    );
    assert_eq!(docker_rm_force_args("runner"), vec!["rm", "-f", "runner"]);
}

#[test]
fn docker_cli_runtime_can_create_and_remove_network_when_opted_in() {
    if std::env::var("LOCAL_CI_RUST_DOCKER_INTEGRATION").as_deref() != Ok("1") {
        return;
    }
    let name = format!("local-ci-rust-test-{}", std::process::id());
    let mut runtime = DockerCliRuntime::default();

    runtime.create_network(&name).unwrap();
    runtime.remove_network(&name).unwrap();
}

#[test]
fn rewrites_loopback_dtu_url_for_containers() {
    assert_eq!(
        resolve_docker_api_url("http://127.0.0.1:1234", "host.docker.internal"),
        "http://host.docker.internal:1234"
    );
}

#[test]
fn resolves_default_extra_hosts() {
    let env = BTreeMap::new();
    assert_eq!(
        resolve_docker_extra_hosts(&env, "host.docker.internal"),
        Some(vec!["host.docker.internal:host-gateway".to_owned()])
    );
}
