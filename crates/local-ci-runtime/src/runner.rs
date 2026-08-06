use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

mod pause;
mod plans;
mod runtime;
mod timeline;
mod types;

use pause::*;
use timeline::*;

pub use pause::{wrap_pause_on_failure_script, wrap_pause_on_failure_steps};
pub use plans::{dtu_job_seed_for_planned_job, runner_execution_plan_for_job};
pub use runtime::read_paused_signal;
pub use runtime::{
    ContainerExit, ContainerRuntime, DtuControlPlane, JobResult, PausedSignal, ServiceSpec,
    StartedService, StepResult, StepStatus, execute_job, execute_job_with_pause_observer,
    execute_registered_runner_job, execute_registered_runner_job_with_pause_observer,
};
pub use timeline::parse_timeline_steps;
pub use types::{DtuJobContainer, DtuJobSeed, DtuJobStep, DtuRunnerRegistration, JobExecutionPlan};

#[cfg(test)]
mod tests;
