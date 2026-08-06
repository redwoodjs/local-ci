use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Condvar, Mutex, OnceLock};

pub const DEFAULT_MACOS_IMAGE: &str = "ghcr.io/cirruslabs/macos-sequoia-xcode:latest";
pub const DEFAULT_MACOS_RUNNER_VERSION: &str = "2.331.0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostCapability {
    Supported,
    Unsupported {
        reason: String,
        hint: Option<String>,
    },
}

mod command;
mod execute;
mod host;
mod image;
mod runner_binary;

pub use command::{
    CommandSpec, SshCreds, rsync_args, ssh_args, tart_clone_args, tart_delete_args, tart_ip_args,
    tart_list_args, tart_pull_args, tart_run_args, tart_stop_args,
};
pub use execute::{
    CommandMacosVmRuntime, MacosVmJobPlan, MacosVmJobResult, MacosVmRuntime, VmCommandResult,
    apply_dns_override, build_macos_runner_script, execute_macos_vm_job,
    macos_vm_concurrency_limit, sync_repo_to_vm, wait_for_ip, wait_for_ssh,
};
pub use host::check_macos_vm_host;
pub use image::{ImageResolution, resolve_macos_vm_image};
pub use runner_binary::{
    CachedRunner, CommandRunnerBinaryIo, RunnerBinaryIo, ensure_macos_runner_binary,
    macos_runner_tarball_url, resolve_macos_runner_version,
};

#[cfg(test)]
mod tests;
