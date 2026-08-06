#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl CommandSpec {
    pub(super) fn new(
        program: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }
}

pub fn tart_pull_args(image: &str) -> CommandSpec {
    CommandSpec::new("tart", ["pull", image])
}

pub fn tart_clone_args(base: &str, name: &str) -> CommandSpec {
    CommandSpec::new("tart", ["clone", base, name])
}

pub fn tart_run_args(name: &str, graphics: bool) -> CommandSpec {
    let mut args = vec!["run".to_owned()];
    if !graphics {
        args.push("--no-graphics".to_owned());
    }
    args.push(name.to_owned());
    CommandSpec::new("tart", args)
}

pub fn tart_ip_args(name: &str) -> CommandSpec {
    CommandSpec::new("tart", ["ip", name])
}

pub fn tart_stop_args(name: &str) -> CommandSpec {
    CommandSpec::new("tart", ["stop", name])
}

pub fn tart_delete_args(name: &str) -> CommandSpec {
    CommandSpec::new("tart", ["delete", name])
}

pub fn tart_list_args() -> CommandSpec {
    CommandSpec::new("tart", ["list", "--format", "json"])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshCreds {
    pub user: String,
    pub password: String,
    pub reverse_tunnel: Option<String>,
}

pub fn ssh_args(ip: &str, creds: &SshCreds, remote_cmd: &[String]) -> CommandSpec {
    let mut args = vec![
        "-p".to_owned(),
        creds.password.clone(),
        "ssh".to_owned(),
        "-o".to_owned(),
        "StrictHostKeyChecking=no".to_owned(),
        "-o".to_owned(),
        "UserKnownHostsFile=/dev/null".to_owned(),
        "-o".to_owned(),
        "LogLevel=ERROR".to_owned(),
        "-o".to_owned(),
        "ConnectTimeout=5".to_owned(),
    ];
    if let Some(tunnel) = &creds.reverse_tunnel {
        args.push("-R".to_owned());
        args.push(tunnel.clone());
    }
    args.push(format!("{}@{ip}", creds.user));
    args.extend(remote_cmd.iter().cloned());
    CommandSpec::new("sshpass", args)
}

pub fn rsync_args(
    src: &str,
    dst: &str,
    creds: &SshCreds,
    exclude: &[String],
    delete: bool,
) -> CommandSpec {
    let rsync_rsh = format!(
        "sshpass -p {} ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR",
        creds.password
    );
    let mut args = vec!["-az".to_owned(), "-e".to_owned(), rsync_rsh];
    if delete {
        args.push("--delete".to_owned());
    }
    for pattern in exclude {
        args.push("--exclude".to_owned());
        args.push(pattern.clone());
    }
    args.push(src.to_owned());
    args.push(dst.to_owned());
    CommandSpec::new("rsync", args)
}
