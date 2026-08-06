use crate::runner::{
    ContainerExit, ContainerRuntime, JobExecutionPlan, PausedSignal, ServiceSpec, StartedService,
    read_paused_signal,
};
use crate::runner_image::ImageOps;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

pub const DEFAULT_SOCKET: &str = "/var/run/docker.sock";
const DOCS_URL: &str =
    "https://github.com/redwoodjs/local-ci/blob/main/packages/cli/docs/docker-socket.md";
const DEFAULT_DTU_HOST_ALIAS: &str = "host.docker.internal";
const DEFAULT_DOCKER_HOST_GATEWAY: &str = "host-gateway";

mod config;
mod runtime;
mod socket;

pub use config::{
    ContainerBindsOpts, ContainerCmdOpts, ContainerEnvOpts, DockerRunConfig,
    ParsedContainerOptions, build_container_binds, build_container_cmd, build_container_env,
    cache_permission_fix_commands, docker_network_create_args, docker_network_remove_args,
    docker_rm_force_args, docker_run_args, docker_socket_permission_fix_command,
    parse_container_options, resolve_docker_api_url, resolve_docker_extra_hosts,
};
pub use runtime::DockerCliRuntime;
pub use socket::{DockerSocket, DockerSocketError, DockerSocketProbe, resolve_docker_socket};

#[cfg(test)]
mod tests;
