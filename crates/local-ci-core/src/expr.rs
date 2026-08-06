use globset::Glob;
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const ZERO_SHA: &str = "0000000000000000000000000000000000000000";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExpressionContext {
    pub repo_path: Option<PathBuf>,
    pub secrets: BTreeMap<String, String>,
    pub matrix: BTreeMap<String, String>,
    pub needs: BTreeMap<String, BTreeMap<String, String>>,
    pub inputs: BTreeMap<String, String>,
    pub vars: BTreeMap<String, String>,
    pub runner: RunnerContext,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerContext {
    pub os: String,
    pub arch: String,
}

impl Default for RunnerContext {
    fn default() -> Self {
        Self {
            os: "Linux".to_owned(),
            arch: "X64".to_owned(),
        }
    }
}

mod context;
mod eval;
mod functions;
mod hash;
mod parse;

use context::*;
use functions::*;
use parse::*;

pub use eval::{
    evaluate_expr_value, evaluate_job_if, expand_expressions, uses_status_check_function,
};
pub use hash::hash_files;

#[cfg(test)]
mod tests;
