use super::*;

#[derive(Debug, Clone)]
pub struct DockerCliRuntime {
    docker_bin: String,
}

impl Default for DockerCliRuntime {
    fn default() -> Self {
        Self::new("docker")
    }
}

impl DockerCliRuntime {
    pub fn new(docker_bin: impl Into<String>) -> Self {
        Self {
            docker_bin: docker_bin.into(),
        }
    }

    pub fn create_network(&mut self, name: &str) -> Result<(), String> {
        self.docker_output(&docker_network_create_args(name))
            .map(|_| ())
    }

    pub fn remove_network(&mut self, name: &str) -> Result<(), String> {
        self.docker_output(&docker_network_remove_args(name))
            .map(|_| ())
    }

    fn docker_output(&mut self, args: &[String]) -> Result<String, String> {
        let output = Command::new(&self.docker_bin)
            .args(args)
            .output()
            .map_err(|err| format!("failed to run docker: {err}"))?;
        if !output.status.success() {
            return Err(format!(
                "docker {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }
}

impl ImageOps for DockerCliRuntime {
    fn image_exists(&mut self, image: &str) -> Result<bool, String> {
        let output = Command::new(&self.docker_bin)
            .args(["image", "inspect", image])
            .output()
            .map_err(|err| format!("failed to run docker: {err}"))?;
        Ok(output.status.success())
    }

    fn pull_image(&mut self, image: &str) -> Result<(), String> {
        self.docker_output(&["pull".to_owned(), image.to_owned()])
            .map(|_| ())
    }

    fn build_image(
        &mut self,
        image: &str,
        dockerfile: &Path,
        context: Option<&Path>,
    ) -> Result<(), String> {
        if let Some(context) = context {
            return self
                .docker_output(&[
                    "build".to_owned(),
                    "-t".to_owned(),
                    image.to_owned(),
                    "-f".to_owned(),
                    dockerfile.to_string_lossy().into_owned(),
                    context.to_string_lossy().into_owned(),
                ])
                .map(|_| ());
        }

        let dockerfile_content = fs::read(dockerfile).map_err(|err| err.to_string())?;
        let mut child = Command::new(&self.docker_bin)
            .args(["build", "-t", image, "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("failed to run docker build: {err}"))?;
        child
            .stdin
            .take()
            .ok_or_else(|| "failed to open docker build stdin".to_owned())?
            .write_all(&dockerfile_content)
            .map_err(|err| err.to_string())?;
        let output = child.wait_with_output().map_err(|err| err.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }
}

pub(super) fn active_endpoint_error(err: &str) -> bool {
    err.contains("active endpoints") || err.contains("has active endpoints")
}

pub(super) fn network_container_ids_args(network: &str) -> Vec<String> {
    vec![
        "network".to_owned(),
        "inspect".to_owned(),
        "-f".to_owned(),
        "{{range $id, $_ := .Containers}}{{println $id}}{{end}}".to_owned(),
        network.to_owned(),
    ]
}

fn ignore_container_removal_in_progress(result: Result<String, String>) -> Result<(), String> {
    match result {
        Ok(_) => Ok(()),
        Err(err)
            if err.contains("removal of container") && err.contains("is already in progress") =>
        {
            Ok(())
        }
        Err(err) => Err(err),
    }
}

fn spawn_log_reader<R>(reader: R, tx: mpsc::Sender<String>)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
}

impl ContainerRuntime for DockerCliRuntime {
    fn create_network(&mut self, network: &str) -> Result<(), String> {
        if let Ok(containers) = self.docker_output(&[
            "ps".to_owned(),
            "-aq".to_owned(),
            "--filter".to_owned(),
            format!("name=^/{network}"),
        ]) {
            for container in containers
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
            {
                let _ = self.docker_output(&docker_rm_force_args(container));
            }
        }
        let _ = self.docker_output(&docker_network_remove_args(network));
        self.docker_output(&docker_network_create_args(network))
            .map(|_| ())
    }

    fn remove_network(&mut self, network: &str) -> Result<(), String> {
        match self.docker_output(&docker_network_remove_args(network)) {
            Ok(_) => Ok(()),
            Err(err) if active_endpoint_error(&err) => {
                if let Ok(container_ids) = self.docker_output(&network_container_ids_args(network))
                {
                    for container_id in container_ids
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                    {
                        let _ = self.docker_output(&docker_rm_force_args(container_id));
                    }
                }
                self.docker_output(&docker_network_remove_args(network))
                    .map(|_| ())
                    .map_err(|retry_err| {
                        format!("{err}; retry after removing active endpoints failed: {retry_err}")
                    })
            }
            Err(err) => Err(err),
        }
    }

    fn start_service(
        &mut self,
        service: &ServiceSpec,
        network: &str,
    ) -> Result<StartedService, String> {
        let container_name = format!("{network}-svc-{}", service.id);
        let config = DockerRunConfig {
            name: container_name.clone(),
            image: service.image.clone(),
            network: network.to_owned(),
            env: service.env.clone(),
            binds: Vec::new(),
            extra_hosts: Vec::new(),
            ports: service.ports.clone(),
            options: Some(match &service.options {
                Some(options) if !options.trim().is_empty() => {
                    format!("--network-alias {} {options}", service.id)
                }
                _ => format!("--network-alias {}", service.id),
            }),
            health_cmd: service.health_cmd.clone(),
            detach: true,
            command: Vec::new(),
        };
        self.docker_output(&docker_run_args(&config))?;
        Ok(StartedService {
            id: service.id.clone(),
            container_name,
        })
    }

    fn wait_service_healthy(&mut self, service: &StartedService) -> Result<(), String> {
        let mut last_status = String::new();
        for _ in 0..60 {
            let status = self.docker_output(&[
                "inspect".to_owned(),
                "-f".to_owned(),
                "{{if .State.Health}}{{.State.Health.Status}}{{else}}healthy{{end}}".to_owned(),
                service.container_name.clone(),
            ])?;
            if status == "healthy" {
                return Ok(());
            }
            last_status = status;
            thread::sleep(Duration::from_secs(1));
        }
        Err(format!(
            "service '{}' is not healthy yet: {last_status}",
            service.id
        ))
    }

    fn remove_service(&mut self, service: &StartedService) -> Result<(), String> {
        ignore_container_removal_in_progress(
            self.docker_output(&docker_rm_force_args(&service.container_name)),
        )
    }

    fn start_runner(&mut self, plan: &JobExecutionPlan, network: &str) -> Result<(), String> {
        let _ = self.docker_output(&docker_rm_force_args(&plan.container_name));
        let config = DockerRunConfig {
            name: plan.container_name.clone(),
            image: plan.image.clone(),
            network: network.to_owned(),
            env: plan.env.clone(),
            binds: plan.binds.clone(),
            extra_hosts: plan.extra_hosts.clone(),
            ports: BTreeMap::new(),
            options: None,
            health_cmd: None,
            detach: true,
            command: plan.command.clone(),
        };
        self.docker_output(&docker_run_args(&config)).map(|_| ())
    }

    fn stream_runner_logs(
        &mut self,
        runner_name: &str,
        signals_dir: Option<&Path>,
        sink: &mut dyn Write,
        on_pause: &mut dyn FnMut(PausedSignal),
    ) -> Result<(), String> {
        let mut child = Command::new(&self.docker_bin)
            .args(["logs", "-f", runner_name])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("failed to stream docker logs: {err}"))?;
        let (tx, rx) = mpsc::channel::<String>();
        if let Some(stdout) = child.stdout.take() {
            spawn_log_reader(stdout, tx.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_log_reader(stderr, tx.clone());
        }
        drop(tx);

        let mut last_paused_content = String::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => {
                    writeln!(sink, "{line}").map_err(|err| err.to_string())?;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }

            if let Some(signals_dir) = signals_dir {
                let paused_path = signals_dir.join("paused");
                if let Ok(content) = fs::read_to_string(&paused_path)
                    && content != last_paused_content
                {
                    last_paused_content = content;
                    if let Some(signal) = read_paused_signal(signals_dir) {
                        on_pause(signal);
                    }
                }
            }
        }

        let status = child.wait().map_err(|err| err.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("docker logs failed for {runner_name}"))
        }
    }

    fn wait_runner(&mut self, runner_name: &str) -> Result<ContainerExit, String> {
        let code = self.docker_output(&["wait".to_owned(), runner_name.to_owned()])?;
        Ok(ContainerExit {
            code: code.trim().parse::<i32>().unwrap_or(1),
        })
    }

    fn remove_runner(&mut self, runner_name: &str) -> Result<(), String> {
        ignore_container_removal_in_progress(self.docker_output(&docker_rm_force_args(runner_name)))
    }
}
