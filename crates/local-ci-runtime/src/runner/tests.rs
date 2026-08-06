use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default)]
struct FakeRuntime {
    calls: Vec<String>,
    exit_code: i32,
    logs: Vec<String>,
    fail_start_runner: bool,
}

#[derive(Default)]
struct FakeDtu {
    calls: Vec<String>,
    registrations: Vec<DtuRunnerRegistration>,
    seeds: Vec<DtuJobSeed>,
}

impl DtuControlPlane for FakeDtu {
    fn register_runner(&mut self, registration: &DtuRunnerRegistration) -> Result<(), String> {
        self.calls
            .push(format!("register {}", registration.runner_name));
        self.registrations.push(registration.clone());
        Ok(())
    }

    fn seed_job(&mut self, seed: &DtuJobSeed) -> Result<(), String> {
        self.calls.push(format!("seed {}", seed.id));
        self.seeds.push(seed.clone());
        Ok(())
    }
}

impl ContainerRuntime for FakeRuntime {
    fn create_network(&mut self, network: &str) -> Result<(), String> {
        self.calls.push(format!("create-network {network}"));
        Ok(())
    }

    fn remove_network(&mut self, network: &str) -> Result<(), String> {
        self.calls.push(format!("remove-network {network}"));
        Ok(())
    }

    fn start_service(
        &mut self,
        service: &ServiceSpec,
        network: &str,
    ) -> Result<StartedService, String> {
        self.calls
            .push(format!("start-service {} {network}", service.id));
        Ok(StartedService {
            id: service.id.clone(),
            container_name: format!("svc-{}", service.id),
        })
    }

    fn wait_service_healthy(&mut self, service: &StartedService) -> Result<(), String> {
        self.calls.push(format!("wait-service {}", service.id));
        Ok(())
    }

    fn remove_service(&mut self, service: &StartedService) -> Result<(), String> {
        self.calls.push(format!("remove-service {}", service.id));
        Ok(())
    }

    fn start_runner(&mut self, plan: &JobExecutionPlan, network: &str) -> Result<(), String> {
        self.calls
            .push(format!("start-runner {} {network}", plan.runner_name));
        if self.fail_start_runner {
            Err("start runner failed".to_owned())
        } else {
            Ok(())
        }
    }

    fn stream_runner_logs(
        &mut self,
        runner_name: &str,
        _signals_dir: Option<&Path>,
        sink: &mut dyn Write,
        _on_pause: &mut dyn FnMut(PausedSignal),
    ) -> Result<(), String> {
        self.calls.push(format!("stream {runner_name}"));
        for line in &self.logs {
            writeln!(sink, "{line}").map_err(|err| err.to_string())?;
        }
        Ok(())
    }

    fn wait_runner(&mut self, runner_name: &str) -> Result<ContainerExit, String> {
        self.calls.push(format!("wait {runner_name}"));
        Ok(ContainerExit {
            code: self.exit_code,
        })
    }

    fn remove_runner(&mut self, runner_name: &str) -> Result<(), String> {
        self.calls.push(format!("remove-runner {runner_name}"));
        Ok(())
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("local-ci-rust-runner-{name}-{nonce}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn plan(root: &Path, pause_on_failure: bool) -> JobExecutionPlan {
    JobExecutionPlan {
        workflow: "ci.yml".to_owned(),
        job_id: "test".to_owned(),
        runner_name: "local-ci-1-j1".to_owned(),
        container_name: "local-ci-1-j1".to_owned(),
        image: crate::runner_image::UPSTREAM_RUNNER_IMAGE.to_owned(),
        env: vec![],
        binds: vec![],
        extra_hosts: vec!["host.docker.internal:host-gateway".to_owned()],
        command: vec!["bash".to_owned(), "-lc".to_owned(), "echo ok".to_owned()],
        log_dir: root.join("logs"),
        signals_dir: root.join("signals"),
        services: vec![ServiceSpec {
            id: "postgres".to_owned(),
            image: "postgres:16".to_owned(),
            env: vec!["POSTGRES_PASSWORD=pw".to_owned()],
            ports: BTreeMap::from([("5432".to_owned(), "5432".to_owned())]),
            options: None,
            health_cmd: Some("pg_isready".to_owned()),
        }],
        pause_on_failure,
    }
}

fn seed(root: &Path) -> DtuJobSeed {
    DtuJobSeed {
        id: "job-1".to_owned(),
        runner_name: "local-ci-1-j1".to_owned(),
        name: "test".to_owned(),
        workflow_name: "ci".to_owned(),
        repo_root: root.to_path_buf(),
        github_repo: "owner/repo".to_owned(),
        head_sha: "HEAD".to_owned(),
        real_head_sha: "abc123".to_owned(),
        runner_work_dir: None,
        runner_os: None,
        runner_arch: None,
        env: BTreeMap::new(),
        outputs: BTreeMap::new(),
        needs_context: BTreeMap::new(),
        container: None,
        services: Vec::new(),
        matrix_context: None,
        steps: vec![DtuJobStep {
            name: "Run".to_owned(),
            context_name: None,
            run: Some("echo hi".to_owned()),
            uses: None,
            condition: None,
            shell: None,
            working_directory: None,
            env: BTreeMap::new(),
            with: BTreeMap::new(),
        }],
    }
}

#[test]
fn parses_timeline_steps_into_result_entries() {
    let root = temp_dir("timeline");
    let timeline = root.join("timeline.json");
    fs::write(
        &timeline,
        r#"[
              {"name":"ci","type":"Job","result":"succeeded"},
              {"name":"Set up job","type":"Task","result":"succeeded"},
              {"name":"Run tests","type":"Task","result":"failed"},
              {"name":"Upload","type":"Task","result":"skipped"}
            ]"#,
    )
    .unwrap();

    fs::create_dir_all(root.join("steps")).unwrap();
    fs::write(root.join("steps/Run-tests.log"), "failed output").unwrap();

    let steps = parse_timeline_steps(&timeline);

    assert_eq!(steps.len(), 3);
    assert_eq!(steps[0].status, StepStatus::Passed);
    assert_eq!(steps[1].status, StepStatus::Failed);
    assert_eq!(steps[1].log_path, Some(root.join("steps/Run-tests.log")));
    assert_eq!(steps[2].status, StepStatus::Skipped);
}

#[test]
fn executes_job_starts_services_streams_logs_collects_results_and_cleans_up() {
    let root = temp_dir("success");
    let plan = plan(&root, false);
    fs::create_dir_all(&plan.log_dir).unwrap();
    fs::write(
        plan.log_dir.join("timeline.json"),
        r#"[{"name":"Run","type":"Task","result":"succeeded"}]"#,
    )
    .unwrap();
    let mut runtime = FakeRuntime {
        exit_code: 0,
        logs: vec!["hello".to_owned()],
        calls: vec![],
        ..FakeRuntime::default()
    };

    let result = execute_job(&mut runtime, &plan).unwrap();

    assert!(result.succeeded);
    assert!(!result.paused);
    assert_eq!(result.steps.len(), 1);
    assert_eq!(
        fs::read_to_string(plan.log_dir.join("output.log")).unwrap(),
        "hello\n"
    );
    assert!(plan.log_dir.join("summary.json").exists());
    assert_eq!(
        runtime.calls,
        vec![
            "create-network local-ci-local-ci-1-j1",
            "start-service postgres local-ci-local-ci-1-j1",
            "wait-service postgres",
            "start-runner local-ci-1-j1 local-ci-local-ci-1-j1",
            "stream local-ci-1-j1",
            "wait local-ci-1-j1",
            "remove-runner local-ci-1-j1",
            "remove-service postgres",
            "remove-network local-ci-local-ci-1-j1",
        ]
    );
}

#[test]
fn failed_start_cleans_up_services_and_network() {
    let root = temp_dir("start-fail");
    let plan = plan(&root, false);
    fs::create_dir_all(&plan.log_dir).unwrap();
    let mut runtime = FakeRuntime {
        fail_start_runner: true,
        ..FakeRuntime::default()
    };

    let err = execute_job(&mut runtime, &plan).unwrap_err();

    assert_eq!(err, "start runner failed");
    assert_eq!(
        runtime.calls,
        vec![
            "create-network local-ci-local-ci-1-j1",
            "start-service postgres local-ci-local-ci-1-j1",
            "wait-service postgres",
            "start-runner local-ci-1-j1 local-ci-local-ci-1-j1",
            "remove-service postgres",
            "remove-network local-ci-local-ci-1-j1",
        ]
    );
}

#[test]
fn registered_runner_job_registers_seeds_starts_runner_and_collects_logs() {
    let root = temp_dir("registered");
    let plan = plan(&root, false);
    fs::create_dir_all(&plan.log_dir).unwrap();
    fs::write(
        plan.log_dir.join("timeline.json"),
        r#"[{"name":"Run","type":"Task","result":"succeeded"}]"#,
    )
    .unwrap();
    let seed = seed(&root);
    let mut dtu = FakeDtu::default();
    let mut runtime = FakeRuntime {
        exit_code: 0,
        logs: vec!["hello from runner".to_owned()],
        calls: vec![],
        ..FakeRuntime::default()
    };

    let result = execute_registered_runner_job(&mut dtu, &mut runtime, &plan, &seed).unwrap();

    assert!(result.succeeded);
    assert_eq!(plan.image, crate::runner_image::UPSTREAM_RUNNER_IMAGE);
    assert_eq!(dtu.calls, vec!["register local-ci-1-j1", "seed job-1"]);
    assert_eq!(dtu.registrations[0].log_dir, plan.log_dir);
    assert_eq!(dtu.registrations[0].timeline_dir, plan.log_dir);
    assert_eq!(dtu.seeds[0], seed);
    assert_eq!(
        runtime.calls[3],
        "start-runner local-ci-1-j1 local-ci-local-ci-1-j1"
    );
    assert_eq!(runtime.calls[4], "stream local-ci-1-j1");
    assert_eq!(runtime.calls[5], "wait local-ci-1-j1");
    assert_eq!(
        fs::read_to_string(plan.log_dir.join("output.log")).unwrap(),
        "hello from runner\n"
    );
}

#[test]
fn wraps_script_steps_with_pause_retry_loop() {
    let mut steps = vec![
        DtuJobStep {
            name: "Build's step".to_owned(),
            context_name: None,
            run: Some("echo build && exit 1".to_owned()),
            uses: None,
            condition: None,
            shell: None,
            working_directory: None,
            env: BTreeMap::new(),
            with: BTreeMap::new(),
        },
        DtuJobStep {
            name: "checkout".to_owned(),
            context_name: None,
            run: None,
            uses: Some("actions/checkout@v4".to_owned()),
            condition: None,
            shell: None,
            working_directory: None,
            env: BTreeMap::new(),
            with: BTreeMap::new(),
        },
    ];

    wrap_pause_on_failure_steps(&mut steps);

    let script = steps[0].run.as_ref().unwrap();
    assert!(script.contains("/tmp/local-ci-signals"));
    assert!(script.contains("__STEP_INDEX=1"));
    assert!(script.contains("__WORKDIR=\"${PWD:-}\""));
    assert!(script.contains("cd / && cd \"$__WORKDIR\""));
    assert!(script.contains("echo build && exit 1"));
    assert!(script.contains("Build'\\''s step"));
    assert_eq!(steps[1].run, None);
}

#[test]
fn dtu_job_seed_payload_contains_targeted_runner_and_script_step() {
    let root = temp_dir("seed-payload");
    let seed = seed(&root);

    let payload = seed.to_payload();

    assert_eq!(payload["id"], "job-1");
    assert_eq!(payload["runnerName"], "local-ci-1-j1");
    assert_eq!(payload["repository"]["full_name"], "owner/repo");
    assert_eq!(payload["steps"][0]["name"], "Run");
    assert_eq!(payload["steps"][0]["run"], "echo hi");
}

#[test]
fn failed_job_with_pause_cleans_up_when_no_step_wrapper_paused() {
    let root = temp_dir("pause");
    let plan = plan(&root, true);
    fs::create_dir_all(&plan.log_dir).unwrap();
    fs::write(
        plan.log_dir.join("timeline.json"),
        r#"[{"name":"Run tests","type":"Task","result":"failed"}]"#,
    )
    .unwrap();
    let mut runtime = FakeRuntime {
        exit_code: 1,
        logs: vec![],
        calls: vec![],
        ..FakeRuntime::default()
    };

    let result = execute_job(&mut runtime, &plan).unwrap();

    assert!(!result.succeeded);
    assert!(!result.paused);
    assert!(!plan.signals_dir.join("paused").exists());
    assert!(
        runtime
            .calls
            .iter()
            .any(|call| call.starts_with("remove-runner"))
    );
    assert!(
        runtime
            .calls
            .iter()
            .any(|call| call.starts_with("remove-service"))
    );
    assert!(
        runtime
            .calls
            .iter()
            .any(|call| call.starts_with("remove-network"))
    );
}
