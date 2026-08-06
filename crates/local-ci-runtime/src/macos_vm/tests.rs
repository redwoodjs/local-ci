use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn macos_vm_concurrency_default_and_env_override() {
    assert_eq!(macos_vm_concurrency_limit(None), 2);
    assert_eq!(macos_vm_concurrency_limit(Some("4")), 4);
    assert_eq!(macos_vm_concurrency_limit(Some("0")), 2);
    assert_eq!(macos_vm_concurrency_limit(Some("nope")), 2);
}

fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("local-ci-rust-macos-vm-{name}-{nonce}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[derive(Default)]
struct FakeBinaryIo {
    calls: Vec<String>,
    create_run_sh: bool,
}

impl RunnerBinaryIo for FakeBinaryIo {
    fn download_to_file(&mut self, url: &str, dst: &Path) -> Result<(), String> {
        self.calls.push(format!("download {url} {}", dst.display()));
        fs::write(dst, "tarball").map_err(|err| err.to_string())
    }

    fn extract_tarball(&mut self, tarball: &Path, dst: &Path) -> Result<(), String> {
        self.calls
            .push(format!("extract {} {}", tarball.display(), dst.display()));
        if self.create_run_sh {
            fs::write(dst.join("run.sh"), "#!/bin/sh\n").map_err(|err| err.to_string())?;
        }
        Ok(())
    }
}

#[derive(Default)]
struct FakeVmRuntime {
    calls: Vec<String>,
    ips: Vec<Option<String>>,
    ssh_ready_after: usize,
    ssh_attempts: usize,
    job_code: i32,
}

impl MacosVmRuntime for FakeVmRuntime {
    fn image_exists(&mut self, image: &str) -> Result<bool, String> {
        self.calls.push(format!("image-exists {image}"));
        Ok(false)
    }

    fn pull_image(&mut self, image: &str) -> Result<(), String> {
        self.calls.push(format!("pull {image}"));
        Ok(())
    }

    fn clone_vm(&mut self, image: &str, name: &str) -> Result<(), String> {
        self.calls.push(format!("clone {image} {name}"));
        Ok(())
    }

    fn start_vm(&mut self, name: &str) -> Result<(), String> {
        self.calls.push(format!("start {name}"));
        Ok(())
    }

    fn get_ip(&mut self, name: &str) -> Result<Option<String>, String> {
        self.calls.push(format!("ip {name}"));
        Ok(if self.ips.is_empty() {
            Some("192.168.64.10".to_owned())
        } else {
            self.ips.remove(0)
        })
    }

    fn ssh_exec(
        &mut self,
        ip: &str,
        _creds: &SshCreds,
        script: &str,
    ) -> Result<VmCommandResult, String> {
        if script == "true" {
            self.ssh_attempts += 1;
            self.calls.push(format!("ssh-ready {ip}"));
            let ready = self.ssh_attempts >= self.ssh_ready_after.max(1);
            return Ok(VmCommandResult {
                code: if ready { 0 } else { 255 },
                stdout: String::new(),
                stderr: String::new(),
            });
        }
        if script.contains("networksetup -setdnsservers") {
            self.calls.push(format!("dns {ip}"));
            return Ok(VmCommandResult {
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
            });
        }
        self.calls.push(format!("job {ip}"));
        Ok(VmCommandResult {
            code: self.job_code,
            stdout: "ok".to_owned(),
            stderr: String::new(),
        })
    }

    fn rsync_to(
        &mut self,
        ip: &str,
        _creds: &SshCreds,
        local_src: &Path,
        remote_dst: &str,
        exclude: &[String],
        delete: bool,
    ) -> Result<(), String> {
        self.calls.push(format!(
            "rsync-to {ip} {} {remote_dst} {:?} {delete}",
            local_src.display(),
            exclude
        ));
        Ok(())
    }

    fn rsync_from(
        &mut self,
        ip: &str,
        _creds: &SshCreds,
        remote_src: &str,
        local_dst: &Path,
    ) -> Result<(), String> {
        self.calls.push(format!(
            "rsync-from {ip} {remote_src} {}",
            local_dst.display()
        ));
        Ok(())
    }

    fn stop_vm(&mut self, name: &str) -> Result<(), String> {
        self.calls.push(format!("stop {name}"));
        Ok(())
    }

    fn delete_vm(&mut self, name: &str) -> Result<(), String> {
        self.calls.push(format!("delete {name}"));
        Ok(())
    }
}

fn plan(root: &Path) -> MacosVmJobPlan {
    MacosVmJobPlan {
        vm_name: "local-ci-macos-1".to_owned(),
        image: "ghcr.io/cirruslabs/macos-sonoma-xcode:latest".to_owned(),
        repo_root: root.join("repo"),
        local_runner_dir: root.join("runner"),
        remote_workspace: "/Users/admin/work".to_owned(),
        remote_runner_dir: "/Users/admin/actions-runner".to_owned(),
        remote_log_dir: "/Users/admin/local-ci-logs".to_owned(),
        local_log_dir: root.join("logs"),
        creds: SshCreds {
            user: "admin".to_owned(),
            password: "admin".to_owned(),
            reverse_tunnel: None,
        },
        dtu_url: "http://127.0.0.1:3000".to_owned(),
        runner_token: "token".to_owned(),
        runner_labels: vec!["macos-14".to_owned(), "arm64".to_owned()],
        job_script: "./run.sh".to_owned(),
    }
}

#[test]
fn host_capability_reports_platform_arch_and_tooling_requirements() {
    assert!(matches!(
        check_macos_vm_host("darwin", "arm64", true, true),
        HostCapability::Supported
    ));
    assert!(matches!(
        check_macos_vm_host("macos", "arm64", true, true),
        HostCapability::Supported
    ));
    assert!(matches!(
        check_macos_vm_host("macos", "aarch64", true, true),
        HostCapability::Supported
    ));
    assert_eq!(
        check_macos_vm_host("linux", "arm64", true, true),
        HostCapability::Unsupported {
            reason: "macOS VM runner requires a macOS host (got linux).".to_owned(),
            hint: None,
        }
    );
    assert_eq!(
        check_macos_vm_host("darwin", "x64", true, true),
        HostCapability::Unsupported {
            reason: "macOS VM runner requires an Apple Silicon host (got x64).".to_owned(),
            hint: Some(
                "Apple's Virtualization.framework does not support macOS guests on Intel Macs."
                    .to_owned(),
            ),
        }
    );
    assert_eq!(
        check_macos_vm_host("darwin", "arm64", false, true),
        HostCapability::Unsupported {
            reason: "macOS VM runner requires `tart` to be installed.".to_owned(),
            hint: Some("Install with: brew install cirruslabs/cli/tart".to_owned()),
        }
    );
    assert_eq!(
        check_macos_vm_host("darwin", "arm64", true, false),
        HostCapability::Unsupported {
            reason: "macOS VM runner requires `sshpass` to be installed.".to_owned(),
            hint: Some("Install with: brew install hudochenkov/sshpass/sshpass".to_owned()),
        }
    );
}

#[test]
fn image_mapping_matches_github_macos_labels_and_override() {
    let labels = vec!["macos-latest".to_owned()];
    let resolved = resolve_macos_vm_image(&labels, None);
    assert_eq!(
        resolved.image,
        "ghcr.io/cirruslabs/macos-sonoma-xcode:latest"
    );
    assert!(resolved.exact);

    let fallback =
        resolve_macos_vm_image(&["self-hosted".to_owned(), "macOS-custom".to_owned()], None);
    assert_eq!(fallback.image, DEFAULT_MACOS_IMAGE);
    assert!(!fallback.exact);
    assert_eq!(fallback.matched_label, Some("macOS-custom".to_owned()));

    let override_resolution = resolve_macos_vm_image(&labels, Some("custom:image"));
    assert_eq!(override_resolution.image, "custom:image");
}

#[test]
fn tart_and_ssh_argv_builders_match_expected_commands() {
    assert_eq!(
        tart_pull_args("img"),
        CommandSpec::new("tart", ["pull", "img"])
    );
    assert_eq!(
        tart_run_args("vm", false),
        CommandSpec::new("tart", ["run", "--no-graphics", "vm"])
    );
    let creds = SshCreds {
        user: "admin".to_owned(),
        password: "pw".to_owned(),
        reverse_tunnel: None,
    };
    let ssh = ssh_args("192.168.64.2", &creds, &["true".to_owned()]);
    assert_eq!(ssh.program, "sshpass");
    assert!(ssh.args.contains(&"StrictHostKeyChecking=no".to_owned()));
    assert!(ssh.args.contains(&"admin@192.168.64.2".to_owned()));
    let rsync = rsync_args("src/", "admin@ip:dst", &creds, &["target".to_owned()], true);
    assert_eq!(rsync.program, "rsync");
    assert!(rsync.args.contains(&"--delete".to_owned()));
    assert!(rsync.args.contains(&"target".to_owned()));
}

#[test]
fn runner_binary_cache_downloads_extracts_and_reuses_marker() {
    let root = temp_dir("runner-cache");
    let mut io = FakeBinaryIo {
        create_run_sh: true,
        calls: vec![],
    };

    let cached = ensure_macos_runner_binary(&mut io, &root, "2.331.0").unwrap();
    assert_eq!(cached.dir, root.join("2.331.0"));
    assert!(cached.dir.join(".extracted").exists());
    assert_eq!(io.calls.len(), 2);

    let cached_again = ensure_macos_runner_binary(&mut io, &root, "2.331.0").unwrap();
    assert_eq!(cached_again, cached);
    assert_eq!(io.calls.len(), 2);
}

#[test]
fn runner_binary_cache_fails_if_tarball_shape_changes() {
    let root = temp_dir("runner-cache-fail");
    let mut io = FakeBinaryIo {
        create_run_sh: false,
        calls: vec![],
    };

    let err = ensure_macos_runner_binary(&mut io, &root, "2.331.0").unwrap_err();

    assert!(err.contains("does not contain run.sh"));
}

#[test]
fn waiters_poll_for_ip_and_ssh_then_dns_override_runs() {
    let mut runtime = FakeVmRuntime {
        ips: vec![None, Some("192.168.64.22".to_owned())],
        ssh_ready_after: 2,
        ..FakeVmRuntime::default()
    };
    let creds = SshCreds {
        user: "admin".to_owned(),
        password: "pw".to_owned(),
        reverse_tunnel: None,
    };

    let ip = wait_for_ip(&mut runtime, "vm", 3).unwrap();
    wait_for_ssh(&mut runtime, &ip, &creds, 3).unwrap();
    apply_dns_override(&mut runtime, &ip, &creds, &["1.1.1.1".to_owned()]).unwrap();

    assert_eq!(ip, "192.168.64.22");
    assert_eq!(
        runtime.calls,
        vec![
            "ip vm",
            "ip vm",
            "ssh-ready 192.168.64.22",
            "ssh-ready 192.168.64.22",
            "dns 192.168.64.22"
        ]
    );
}

#[test]
fn vm_job_execution_syncs_repo_runs_script_copies_logs_and_tears_down() {
    let root = temp_dir("job");
    fs::create_dir_all(root.join("repo")).unwrap();
    let plan = plan(&root);
    let mut runtime = FakeVmRuntime {
        ssh_ready_after: 1,
        job_code: 0,
        ..FakeVmRuntime::default()
    };

    let result = execute_macos_vm_job(&mut runtime, &plan).unwrap();

    assert_eq!(result.code, 0);
    assert_eq!(result.ip, "192.168.64.10");
    assert!(
        runtime
            .calls
            .iter()
            .any(|call| call.starts_with("rsync-to 192.168.64.10"))
    );
    assert!(runtime.calls.iter().any(|call| call == "job 192.168.64.10"));
    assert!(runtime.calls.ends_with(&[
        "stop local-ci-macos-1".to_owned(),
        "delete local-ci-macos-1".to_owned()
    ]));
}

#[test]
fn runner_script_configures_ephemeral_runner_then_runs_job_script() {
    let root = temp_dir("script");
    let plan = plan(&root);

    let script = build_macos_runner_script(&plan);

    assert!(script.contains("Credentials are pre-written"));
    assert!(!script.contains("./config.sh"));
    assert!(script.contains("./run.sh"));
}
