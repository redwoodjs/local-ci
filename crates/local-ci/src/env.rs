use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const DOCKER_HOST_ERROR: &str = "[Local CI] Error: DOCKER_HOST is no longer supported.\n  Rename it to LOCAL_CI_DOCKER_HOST (shell env or .env.local-ci).";

static BOOTSTRAPPED_LOCAL_CI_ENV: OnceLock<BTreeMap<String, String>> = OnceLock::new();

pub fn set_bootstrapped_local_ci_env(values: &BTreeMap<String, String>) {
    let _ = BOOTSTRAPPED_LOCAL_CI_ENV.set(values.clone());
}

pub fn effective_process_env() -> BTreeMap<String, String> {
    let mut result = std::env::vars().collect::<BTreeMap<_, _>>();
    if let Some(values) = BOOTSTRAPPED_LOCAL_CI_ENV.get() {
        result.extend(values.clone());
    }
    result
}

pub fn effective_var(key: &str) -> Option<String> {
    BOOTSTRAPPED_LOCAL_CI_ENV
        .get()
        .and_then(|values| values.get(key).cloned())
        .or_else(|| std::env::var(key).ok())
}

pub fn effective_var_os(key: &str) -> Option<OsString> {
    effective_var(key)
        .map(OsString::from)
        .or_else(|| std::env::var_os(key))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeEnv {
    pub repo_root: PathBuf,
    pub local_ci: BTreeMap<String, String>,
    pub docker_host: Option<String>,
}

pub fn bootstrap_env(
    start_dir: &Path,
    current_env: &BTreeMap<String, String>,
) -> Result<RuntimeEnv, String> {
    if current_env.contains_key("DOCKER_HOST") {
        return Err(DOCKER_HOST_ERROR.to_owned());
    }

    let repo_root = resolve_repo_root(start_dir);
    let env_file = resolve_machine_env_path(&repo_root);
    let file_values = parse_env_file(&env_file)?;
    let local_ci = effective_local_ci_env(&file_values, current_env);
    let docker_host = local_ci.get("LOCAL_CI_DOCKER_HOST").cloned();

    Ok(RuntimeEnv {
        repo_root,
        local_ci,
        docker_host,
    })
}

pub fn resolve_repo_root(start_dir: &Path) -> PathBuf {
    let original = start_dir.to_path_buf();
    let mut dir = original.clone();

    loop {
        if dir.join(".git").exists() {
            return dir;
        }
        if !dir.pop() {
            return original;
        }
    }
}

pub fn parse_env_file(file_path: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut result = BTreeMap::new();
    if !file_path.exists() {
        return Ok(result);
    }

    let content = fs::read_to_string(file_path)
        .map_err(|err| format!("failed to read {}: {err}", file_path.display()))?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some(eq_index) = trimmed.find('=') else {
            continue;
        };
        if eq_index == 0 {
            continue;
        }

        let key = trimmed[..eq_index].trim();
        if key.is_empty() {
            continue;
        }

        let value = strip_wrapping_quotes(trimmed[eq_index + 1..].trim());
        result.insert(key.to_owned(), value.to_owned());
    }

    Ok(result)
}

pub fn load_machine_secrets(
    base_dir: &Path,
    env_fallback_keys: &[String],
    current_env: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut secrets = parse_env_file(&resolve_machine_env_path(base_dir))?;

    for key in env_fallback_keys {
        let should_fill = secrets.get(key).is_none_or(String::is_empty);
        if should_fill {
            if let Some(value) = current_env.get(key).filter(|value| !value.is_empty()) {
                secrets.insert(key.clone(), value.clone());
            }
        }
    }

    Ok(secrets)
}

pub fn resolve_machine_env_path(base_dir: &Path) -> PathBuf {
    let local = base_dir.join(".env.local-ci");
    if local.exists() {
        local
    } else {
        base_dir.join(".env.agent-ci")
    }
}

fn canonical_env_key(key: &str) -> Option<String> {
    if key.starts_with("LOCAL_CI_") {
        Some(key.to_owned())
    } else {
        key.strip_prefix("AGENT_CI_")
            .map(|suffix| format!("LOCAL_CI_{suffix}"))
    }
}

fn effective_local_ci_env(
    file_values: &BTreeMap<String, String>,
    current_env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();

    for (key, value) in current_env {
        if key.starts_with("LOCAL_CI_") {
            result.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in current_env {
        if let Some(canonical) = canonical_env_key(key) {
            result.entry(canonical).or_insert_with(|| value.clone());
        }
    }
    for (key, value) in file_values {
        if let Some(canonical) = canonical_env_key(key) {
            result.entry(canonical).or_insert_with(|| value.clone());
        }
    }

    result
}

fn strip_wrapping_quotes(value: &str) -> &str {
    let quoted_with_double = value.starts_with('"') && value.ends_with('"');
    let quoted_with_single = value.starts_with('\'') && value.ends_with('\'');
    if value.len() >= 2 && (quoted_with_double || quoted_with_single) {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("local-ci-rust-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_env_local_ci_syntax() {
        let dir = temp_dir("parse-env");
        let env_file = dir.join(".env.local-ci");
        fs::write(
            &env_file,
            "\n# comment\nFOO=bar\nSPACED = value \nDOUBLE=\"quoted\"\nSINGLE='quoted too'\nNO_EQUALS\n=bad\n",
        )
        .unwrap();

        let parsed = parse_env_file(&env_file).unwrap();

        assert_eq!(parsed.get("FOO"), Some(&"bar".to_owned()));
        assert_eq!(parsed.get("SPACED"), Some(&"value".to_owned()));
        assert_eq!(parsed.get("DOUBLE"), Some(&"quoted".to_owned()));
        assert_eq!(parsed.get("SINGLE"), Some(&"quoted too".to_owned()));
        assert!(!parsed.contains_key("NO_EQUALS"));
    }

    #[test]
    fn applies_only_local_ci_keys_and_preserves_shell_precedence() {
        let dir = temp_dir("bootstrap");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(
            dir.join(".env.local-ci"),
            "LOCAL_CI_DOCKER_HOST=unix:///file.sock\nLOCAL_CI_JSON=1\nPLAIN_SECRET=secret\n",
        )
        .unwrap();
        let current_env = BTreeMap::from([(
            "LOCAL_CI_DOCKER_HOST".to_owned(),
            "unix:///shell.sock".to_owned(),
        )]);

        let runtime = bootstrap_env(&dir, &current_env).unwrap();

        assert_eq!(runtime.repo_root, dir);
        assert_eq!(runtime.docker_host, Some("unix:///shell.sock".to_owned()));
        assert_eq!(
            runtime.local_ci.get("LOCAL_CI_DOCKER_HOST"),
            Some(&"unix:///shell.sock".to_owned())
        );
        assert_eq!(runtime.local_ci.get("LOCAL_CI_JSON"), Some(&"1".to_owned()));
        assert!(!runtime.local_ci.contains_key("PLAIN_SECRET"));
    }

    #[test]
    fn supports_legacy_environment_file_and_variable_names() {
        let dir = temp_dir("legacy-env");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(
            dir.join(".env.agent-ci"),
            "AGENT_CI_DOCKER_HOST=unix:///legacy.sock\nAGENT_CI_JSON=1\n",
        )
        .unwrap();

        let runtime = bootstrap_env(&dir, &BTreeMap::new()).unwrap();

        assert_eq!(runtime.docker_host, Some("unix:///legacy.sock".to_owned()));
        assert_eq!(runtime.local_ci.get("LOCAL_CI_JSON"), Some(&"1".to_owned()));
    }

    #[test]
    fn canonical_environment_names_take_precedence_over_legacy_aliases() {
        let file_values = BTreeMap::from([
            ("AGENT_CI_JSON".to_owned(), "legacy".to_owned()),
            ("LOCAL_CI_JSON".to_owned(), "canonical-file".to_owned()),
        ]);
        let current_env = BTreeMap::from([
            ("AGENT_CI_JSON".to_owned(), "legacy-shell".to_owned()),
            ("LOCAL_CI_JSON".to_owned(), "canonical-shell".to_owned()),
        ]);

        let effective = effective_local_ci_env(&file_values, &current_env);

        assert_eq!(
            effective.get("LOCAL_CI_JSON"),
            Some(&"canonical-shell".to_owned())
        );
    }

    #[test]
    fn rejects_shell_docker_host() {
        let dir = temp_dir("docker-host");
        let current_env = BTreeMap::from([(
            "DOCKER_HOST".to_owned(),
            "unix:///var/run/docker.sock".to_owned(),
        )]);

        let err = bootstrap_env(&dir, &current_env).unwrap_err();

        assert_eq!(err, DOCKER_HOST_ERROR);
    }

    #[test]
    fn loads_machine_secrets_with_env_fallbacks() {
        let dir = temp_dir("secrets");
        fs::write(dir.join(".env.local-ci"), "TOKEN=file\nEMPTY=\n").unwrap();
        let env = BTreeMap::from([
            ("TOKEN".to_owned(), "shell".to_owned()),
            ("EMPTY".to_owned(), "fallback".to_owned()),
            ("OTHER".to_owned(), "other".to_owned()),
        ]);
        let keys = vec!["TOKEN".to_owned(), "EMPTY".to_owned(), "OTHER".to_owned()];

        let secrets = load_machine_secrets(&dir, &keys, &env).unwrap();

        assert_eq!(secrets.get("TOKEN"), Some(&"file".to_owned()));
        assert_eq!(secrets.get("EMPTY"), Some(&"fallback".to_owned()));
        assert_eq!(secrets.get("OTHER"), Some(&"other".to_owned()));
    }

    #[test]
    fn resolves_repo_root_by_walking_to_git_directory() {
        let dir = temp_dir("repo-root");
        let nested = dir.join("a/b/c");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(&nested).unwrap();

        assert_eq!(resolve_repo_root(&nested), dir);
    }
}
