use crate::runner::{DtuControlPlane, DtuJobSeed, DtuRunnerRegistration};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const VIRTUAL_CACHE_ID: u64 = 0;
const TWIRP_ARTIFACT_PREFIX: &str = "/twirp/github.actions.results.api.v1.ArtifactService";

#[derive(Debug)]
pub struct EphemeralDtu {
    pub url: String,
    pub container_url: String,
    pub port: u16,
    pub control_token: String,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    #[cfg(test)]
    state: Arc<DtuState>,
}

impl EphemeralDtu {
    pub fn close(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for EphemeralDtu {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn start_ephemeral_dtu(
    cache_dir: impl AsRef<Path>,
    container_host: Option<&str>,
) -> std::io::Result<EphemeralDtu> {
    let cache_dir = cache_dir.as_ref().to_path_buf();
    start_ephemeral_dtu_with_log_root(cache_dir.clone(), cache_dir, container_host)
}

pub fn start_ephemeral_dtu_with_log_root(
    cache_dir: impl AsRef<Path>,
    allowed_log_root: impl AsRef<Path>,
    container_host: Option<&str>,
) -> std::io::Result<EphemeralDtu> {
    let cache_dir = cache_dir.as_ref().to_path_buf();
    let allowed_log_root = allowed_log_root.as_ref().to_path_buf();
    fs::create_dir_all(&cache_dir)?;
    fs::create_dir_all(cache_dir.join("artifacts"))?;
    fs::create_dir_all(&allowed_log_root)?;

    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let shutdown = Arc::new(AtomicBool::new(false));
    let control_token = generate_control_token()?;
    let state = Arc::new(DtuState::new(
        cache_dir,
        allowed_log_root,
        control_token.clone(),
    ));
    let thread_shutdown = Arc::clone(&shutdown);
    let thread_state = Arc::clone(&state);

    let thread = thread::spawn(move || accept_loop(listener, thread_state, thread_shutdown));
    let host = container_host.unwrap_or("host.docker.internal");

    Ok(EphemeralDtu {
        url: format!("http://127.0.0.1:{port}"),
        container_url: format!("http://{host}:{port}"),
        port,
        control_token,
        shutdown,
        thread: Some(thread),
        #[cfg(test)]
        state,
    })
}

fn generate_control_token() -> std::io::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| {
        std::io::Error::other(format!("failed to generate DTU control token: {error}"))
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DtuHttpClient {
    base_url: String,
    control_token: Option<String>,
}

impl DtuHttpClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            control_token: None,
        }
    }

    pub fn with_control_token(
        base_url: impl Into<String>,
        control_token: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            control_token: Some(control_token.into()),
        }
    }

    fn post_json(&self, path: &str, body: Value) -> Result<Value, String> {
        self.request_json("POST", path, Some(body))
    }

    fn request_json(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let (host, port) = parse_http_base_url(&self.base_url)?;
        let body_bytes = body
            .map(|value| serde_json::to_vec(&value).map_err(|err| err.to_string()))
            .transpose()?
            .unwrap_or_default();
        let mut stream = TcpStream::connect((host.as_str(), port))
            .map_err(|err| format!("failed to connect to DTU at {}: {err}", self.base_url))?;
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\n"
        )
        .map_err(|err| err.to_string())?;
        if let Some(token) = &self.control_token {
            write!(stream, "X-Agent-CI-DTU-Token: {token}\r\n").map_err(|err| err.to_string())?;
        }
        write!(
            stream,
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            body_bytes.len()
        )
        .map_err(|err| err.to_string())?;
        stream
            .write_all(&body_bytes)
            .map_err(|err| err.to_string())?;

        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .map_err(|err| err.to_string())?;
        parse_json_response(&response)
    }
}

impl DtuControlPlane for DtuHttpClient {
    fn register_runner(&mut self, registration: &DtuRunnerRegistration) -> Result<(), String> {
        self.post_json(
            "/_dtu/start-runner",
            json!({
                "runnerName": registration.runner_name,
                "logDir": registration.log_dir,
                "timelineDir": registration.timeline_dir,
                "virtualCachePatterns": registration.virtual_cache_patterns,
            }),
        )
        .map(|_| ())
    }

    fn seed_job(&mut self, seed: &DtuJobSeed) -> Result<(), String> {
        self.post_json("/_dtu/seed", seed.to_payload()).map(|_| ())
    }
}

fn parse_http_base_url(base_url: &str) -> Result<(String, u16), String> {
    let rest = base_url
        .strip_prefix("http://")
        .ok_or_else(|| format!("DTU URL must start with http://, got {base_url}"))?;
    let authority = rest.split('/').next().unwrap_or(rest);
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| format!("DTU URL must include a port, got {base_url}"))?;
    let port = port
        .parse::<u16>()
        .map_err(|_| format!("DTU URL has an invalid port, got {base_url}"))?;
    Ok((host.to_owned(), port))
}

fn parse_json_response(response: &[u8]) -> Result<Value, String> {
    let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Err("DTU response did not contain HTTP headers".to_owned());
    };
    let headers = String::from_utf8_lossy(&response[..header_end]);
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| "DTU response did not contain a status code".to_owned())?;
    let body = &response[header_end + 4..];
    if !(200..300).contains(&status) {
        return Err(format!(
            "DTU request failed with HTTP {status}: {}",
            String::from_utf8_lossy(body)
        ));
    }
    if body.is_empty() {
        Ok(Value::Null)
    } else {
        serde_json::from_slice(body).map_err(|err| err.to_string())
    }
}

mod artifacts;
mod cache;
mod github;
mod http;
mod job_mapping;
mod logs;
mod routes;
mod runner_api;
mod state;
mod util;

use artifacts::*;
use cache::*;
use github::*;
use http::*;
use job_mapping::*;
use logs::*;
use routes::*;
use runner_api::*;
use state::*;
use util::*;

#[cfg(test)]
mod tests;
