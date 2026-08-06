use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

pub const UPSTREAM_RUNNER_IMAGE: &str = "ghcr.io/actions/actions-runner:latest";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerImageSource {
    Env,
    DockerfileDir,
    DockerfileFile,
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRunnerImage {
    pub image: String,
    pub source: RunnerImageSource,
    pub source_label: String,
    pub needs_build: bool,
    pub dockerfile_path: Option<PathBuf>,
    pub context_dir: Option<PathBuf>,
}

pub fn discover_runner_image(repo_root: &Path, env_image: Option<&str>) -> ResolvedRunnerImage {
    if let Some(image) = env_image.map(str::trim).filter(|image| !image.is_empty()) {
        return ResolvedRunnerImage {
            image: image.to_owned(),
            source: RunnerImageSource::Env,
            source_label: "LOCAL_CI_RUNNER_IMAGE".to_owned(),
            needs_build: false,
            dockerfile_path: None,
            context_dir: None,
        };
    }

    let dir_dockerfile = repo_root.join(".github/local-ci/Dockerfile");
    if dir_dockerfile.exists() {
        let context_dir = dir_dockerfile.parent().unwrap_or(repo_root).to_path_buf();
        let hash = hash_dockerfile_and_context(&dir_dockerfile, &context_dir)
            .unwrap_or_else(|_| "unknown".to_owned());
        return ResolvedRunnerImage {
            image: format!("local-ci-runner:{hash}"),
            source: RunnerImageSource::DockerfileDir,
            source_label: path_relative(repo_root, &dir_dockerfile),
            needs_build: true,
            dockerfile_path: Some(dir_dockerfile),
            context_dir: Some(context_dir),
        };
    }

    let simple_dockerfile = repo_root.join(".github/local-ci.Dockerfile");
    if simple_dockerfile.exists() {
        let hash = hash_file(&simple_dockerfile).unwrap_or_else(|_| "unknown".to_owned());
        return ResolvedRunnerImage {
            image: format!("local-ci-runner:{hash}"),
            source: RunnerImageSource::DockerfileFile,
            source_label: path_relative(repo_root, &simple_dockerfile),
            needs_build: true,
            dockerfile_path: Some(simple_dockerfile),
            context_dir: None,
        };
    }

    let legacy_dir_dockerfile = repo_root.join(".github/agent-ci/Dockerfile");
    if legacy_dir_dockerfile.exists() {
        let context_dir = legacy_dir_dockerfile
            .parent()
            .unwrap_or(repo_root)
            .to_path_buf();
        let hash = hash_dockerfile_and_context(&legacy_dir_dockerfile, &context_dir)
            .unwrap_or_else(|_| "unknown".to_owned());
        return ResolvedRunnerImage {
            image: format!("local-ci-runner:{hash}"),
            source: RunnerImageSource::DockerfileDir,
            source_label: path_relative(repo_root, &legacy_dir_dockerfile),
            needs_build: true,
            dockerfile_path: Some(legacy_dir_dockerfile),
            context_dir: Some(context_dir),
        };
    }

    let legacy_simple_dockerfile = repo_root.join(".github/agent-ci.Dockerfile");
    if legacy_simple_dockerfile.exists() {
        let hash = hash_file(&legacy_simple_dockerfile).unwrap_or_else(|_| "unknown".to_owned());
        return ResolvedRunnerImage {
            image: format!("local-ci-runner:{hash}"),
            source: RunnerImageSource::DockerfileFile,
            source_label: path_relative(repo_root, &legacy_simple_dockerfile),
            needs_build: true,
            dockerfile_path: Some(legacy_simple_dockerfile),
            context_dir: None,
        };
    }

    ResolvedRunnerImage {
        image: UPSTREAM_RUNNER_IMAGE.to_owned(),
        source: RunnerImageSource::Default,
        source_label: "built-in default".to_owned(),
        needs_build: false,
        dockerfile_path: None,
        context_dir: None,
    }
}

pub trait ImageOps {
    fn image_exists(&mut self, image: &str) -> Result<bool, String>;
    fn pull_image(&mut self, image: &str) -> Result<(), String>;
    fn build_image(
        &mut self,
        image: &str,
        dockerfile: &Path,
        context: Option<&Path>,
    ) -> Result<(), String>;
}

pub fn ensure_runner_image(
    ops: &mut impl ImageOps,
    resolved: &ResolvedRunnerImage,
) -> Result<String, String> {
    if !resolved.needs_build {
        if !ops.image_exists(&resolved.image)? {
            ops.pull_image(&resolved.image)?;
        }
        return Ok(resolved.image.clone());
    }

    if ops.image_exists(&resolved.image)? {
        return Ok(resolved.image.clone());
    }

    ops.pull_image(UPSTREAM_RUNNER_IMAGE)?;
    let dockerfile = resolved
        .dockerfile_path
        .as_deref()
        .ok_or_else(|| "runner image build requires a Dockerfile path".to_owned())?;
    ops.build_image(&resolved.image, dockerfile, resolved.context_dir.as_deref())?;
    Ok(resolved.image.clone())
}

pub fn docker_build_command(resolved: &ResolvedRunnerImage) -> Option<Vec<String>> {
    if !resolved.needs_build {
        return None;
    }
    let dockerfile = resolved.dockerfile_path.as_ref()?;
    if let Some(context_dir) = &resolved.context_dir {
        Some(vec![
            "docker".to_owned(),
            "build".to_owned(),
            "-t".to_owned(),
            resolved.image.clone(),
            "-f".to_owned(),
            dockerfile.to_string_lossy().into_owned(),
            context_dir.to_string_lossy().into_owned(),
        ])
    } else {
        Some(vec![
            "docker".to_owned(),
            "build".to_owned(),
            "-t".to_owned(),
            resolved.image.clone(),
            "-".to_owned(),
        ])
    }
}

pub fn detect_missing_tool_hint(
    error_content: &str,
    resolved: &ResolvedRunnerImage,
) -> Option<String> {
    if resolved.source != RunnerImageSource::Default {
        return None;
    }
    let tool = find_missing_tool(error_content)?;
    Some(format_missing_tool_hint(&tool))
}

pub fn detect_toolcache_hint(error_content: &str, tool_cache_dir: Option<&str>) -> Option<String> {
    let tool_cache_dir = tool_cache_dir?;
    if !error_content.contains("tar: ") || !error_content.contains("Cannot open: Permission denied")
    {
        return None;
    }
    Some(
        [
            "Hint: extraction under /opt/hostedtoolcache failed because files from a".to_owned(),
            "previous run are owned by a user this run can't overwrite. Delete the".to_owned(),
            "host-side toolcache and re-run:".to_owned(),
            String::new(),
            format!("    sudo rm -rf {}", shell_quote(tool_cache_dir)),
        ]
        .join("\n"),
    )
}

fn find_missing_tool(error_content: &str) -> Option<String> {
    for line in error_content.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("command not found") || lower.contains(": not found") {
            let not_found_at = lower.find("not found")?;
            let before = &line[..not_found_at];
            let tool = before.split(':').rev().map(str::trim).find_map(|segment| {
                if segment.is_empty() || segment.parse::<u32>().is_ok() {
                    return None;
                }
                let candidate = segment.trim_end_matches("command").trim();
                (!candidate.is_empty()).then(|| candidate.to_owned())
            })?;
            return Some(tool);
        }
        if let Some(after) = lower.split("linker ").nth(1) {
            let tool = after
                .trim_matches(|ch: char| ch == '`' || ch == '\'' || ch == '"')
                .split_whitespace()
                .next()?;
            return Some(
                tool.trim_matches(|ch: char| ch == '`' || ch == '\'' || ch == '"')
                    .to_owned(),
            );
        }
        if let Some(after) = lower.split("you do not have '").nth(1) {
            return after.split('\'').next().map(ToOwned::to_owned);
        }
    }
    None
}

fn format_missing_tool_hint(tool: &str) -> String {
    [
        format!("Hint: `{tool}` is not in local-ci's default runner image."),
        String::new(),
        "The default image (ghcr.io/actions/actions-runner:latest) is a minimal".to_owned(),
        "container and does not ship system build tools — unlike GitHub's hosted".to_owned(),
        "ubuntu-latest, which is a full VM image that is not published as a".to_owned(),
        "container and cannot be pulled.".to_owned(),
        String::new(),
        "To fix this, create a .github/local-ci.Dockerfile in your repo that".to_owned(),
        "installs the missing tool. See the runner image docs for recipes:".to_owned(),
        "https://github.com/redwoodjs/local-ci/blob/main/packages/cli/runner-image.md".to_owned(),
    ]
    .join("\n")
}

fn hash_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize())[..12].to_owned())
}

fn hash_dockerfile_and_context(dockerfile: &Path, context_dir: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(fs::read(dockerfile).map_err(|err| err.to_string())?);
    let mut entries = BTreeSet::new();
    walk_context(context_dir, context_dir, &mut entries).map_err(|err| err.to_string())?;
    for rel in entries {
        hasher.update(b"\0");
        hasher.update(rel.as_bytes());
        hasher.update(b"\0");
        hasher.update(fs::read(context_dir.join(&rel)).map_err(|err| err.to_string())?);
    }
    Ok(format!("{:x}", hasher.finalize())[..12].to_owned())
}

fn walk_context(base: &Path, dir: &Path, out: &mut BTreeSet<String>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            walk_context(base, &path, out)?;
        } else if entry.file_type()?.is_file() {
            out.insert(
                path.strip_prefix(base)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    Ok(())
}

fn path_relative(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
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
        let dir = std::env::temp_dir().join(format!("local-ci-rust-runner-image-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[derive(Default)]
    struct FakeOps {
        existing: BTreeSet<String>,
        calls: Vec<String>,
    }

    impl ImageOps for FakeOps {
        fn image_exists(&mut self, image: &str) -> Result<bool, String> {
            self.calls.push(format!("inspect {image}"));
            Ok(self.existing.contains(image))
        }

        fn pull_image(&mut self, image: &str) -> Result<(), String> {
            self.calls.push(format!("pull {image}"));
            Ok(())
        }

        fn build_image(
            &mut self,
            image: &str,
            dockerfile: &Path,
            context: Option<&Path>,
        ) -> Result<(), String> {
            self.calls.push(format!(
                "build {image} {} {}",
                dockerfile.display(),
                context.map_or("-".to_owned(), |path| path.display().to_string())
            ));
            self.existing.insert(image.to_owned());
            Ok(())
        }
    }

    #[test]
    fn env_image_wins() {
        let repo = temp_dir("env");
        let resolved = discover_runner_image(&repo, Some("custom:tag"));

        assert_eq!(resolved.image, "custom:tag");
        assert_eq!(resolved.source, RunnerImageSource::Env);
        assert!(!resolved.needs_build);
    }

    #[test]
    fn discovers_directory_dockerfile_and_hashes_context() {
        let repo = temp_dir("dir");
        let dir = repo.join(".github/local-ci");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Dockerfile"), "FROM base\nCOPY file /file\n").unwrap();
        fs::write(dir.join("file"), "hello").unwrap();

        let resolved = discover_runner_image(&repo, None);

        assert_eq!(resolved.source, RunnerImageSource::DockerfileDir);
        assert!(resolved.image.starts_with("local-ci-runner:"));
        assert_eq!(resolved.context_dir, Some(dir));
        assert_eq!(resolved.source_label, ".github/local-ci/Dockerfile");
    }

    #[test]
    fn discovers_simple_dockerfile_without_context() {
        let repo = temp_dir("simple");
        fs::create_dir_all(repo.join(".github")).unwrap();
        fs::write(repo.join(".github/local-ci.Dockerfile"), "FROM base\n").unwrap();

        let resolved = discover_runner_image(&repo, None);

        assert_eq!(resolved.source, RunnerImageSource::DockerfileFile);
        assert!(resolved.context_dir.is_none());
    }

    #[test]
    fn defaults_to_upstream_image() {
        let repo = temp_dir("default");
        let resolved = discover_runner_image(&repo, None);

        assert_eq!(resolved.image, UPSTREAM_RUNNER_IMAGE);
        assert_eq!(resolved.source, RunnerImageSource::Default);
    }

    #[test]
    fn ensure_pulls_missing_non_build_images() {
        let mut ops = FakeOps::default();
        let resolved = ResolvedRunnerImage {
            image: "custom:tag".to_owned(),
            source: RunnerImageSource::Env,
            source_label: "env".to_owned(),
            needs_build: false,
            dockerfile_path: None,
            context_dir: None,
        };

        let image = ensure_runner_image(&mut ops, &resolved).unwrap();

        assert_eq!(image, "custom:tag");
        assert_eq!(ops.calls, vec!["inspect custom:tag", "pull custom:tag"]);
    }

    #[test]
    fn ensure_reuses_existing_non_build_images_without_pulling() {
        let mut ops = FakeOps::default();
        ops.existing.insert("custom:tag".to_owned());
        let resolved = ResolvedRunnerImage {
            image: "custom:tag".to_owned(),
            source: RunnerImageSource::Env,
            source_label: "env".to_owned(),
            needs_build: false,
            dockerfile_path: None,
            context_dir: None,
        };

        let image = ensure_runner_image(&mut ops, &resolved).unwrap();

        assert_eq!(image, "custom:tag");
        assert_eq!(ops.calls, vec!["inspect custom:tag"]);
    }

    #[test]
    fn ensure_builds_missing_dockerfile_image_after_pulling_upstream() {
        let repo = temp_dir("build");
        let dockerfile = repo.join("Dockerfile");
        fs::write(&dockerfile, "FROM base\n").unwrap();
        let resolved = ResolvedRunnerImage {
            image: "local-ci-runner:abc".to_owned(),
            source: RunnerImageSource::DockerfileFile,
            source_label: "Dockerfile".to_owned(),
            needs_build: true,
            dockerfile_path: Some(dockerfile.clone()),
            context_dir: None,
        };
        let mut ops = FakeOps::default();

        let image = ensure_runner_image(&mut ops, &resolved).unwrap();

        assert_eq!(image, "local-ci-runner:abc");
        assert_eq!(ops.calls[0], "inspect local-ci-runner:abc");
        assert_eq!(ops.calls[1], format!("pull {UPSTREAM_RUNNER_IMAGE}"));
        assert!(ops.calls[2].starts_with("build local-ci-runner:abc"));
    }

    #[test]
    fn skips_build_when_hash_tag_exists() {
        let resolved = ResolvedRunnerImage {
            image: "local-ci-runner:abc".to_owned(),
            source: RunnerImageSource::DockerfileFile,
            source_label: "Dockerfile".to_owned(),
            needs_build: true,
            dockerfile_path: Some(PathBuf::from("Dockerfile")),
            context_dir: None,
        };
        let mut ops = FakeOps::default();
        ops.existing.insert("local-ci-runner:abc".to_owned());

        ensure_runner_image(&mut ops, &resolved).unwrap();

        assert_eq!(ops.calls, vec!["inspect local-ci-runner:abc"]);
    }

    #[test]
    fn docker_build_command_uses_context_when_available() {
        let resolved = ResolvedRunnerImage {
            image: "local-ci-runner:abc".to_owned(),
            source: RunnerImageSource::DockerfileDir,
            source_label: "Dockerfile".to_owned(),
            needs_build: true,
            dockerfile_path: Some(PathBuf::from("/repo/.github/local-ci/Dockerfile")),
            context_dir: Some(PathBuf::from("/repo/.github/local-ci")),
        };

        let command = docker_build_command(&resolved).unwrap();

        assert_eq!(
            command,
            vec![
                "docker",
                "build",
                "-t",
                "local-ci-runner:abc",
                "-f",
                "/repo/.github/local-ci/Dockerfile",
                "/repo/.github/local-ci"
            ]
        );
    }

    #[test]
    fn missing_tool_hint_only_applies_to_default_image() {
        let default = discover_runner_image(&temp_dir("hint-default"), None);
        let hint = detect_missing_tool_hint("sh: 1: cargo: not found", &default).unwrap();
        assert!(hint.contains("`cargo`"));
        let custom = ResolvedRunnerImage {
            source: RunnerImageSource::Env,
            ..default
        };
        assert!(detect_missing_tool_hint("cargo: not found", &custom).is_none());
    }

    #[test]
    fn toolcache_hint_points_at_host_dir() {
        let hint = detect_toolcache_hint(
            "tar: bin/npm: Cannot open: Permission denied",
            Some("/tmp/tool cache"),
        )
        .unwrap();
        assert!(hint.contains("sudo rm -rf '/tmp/tool cache'"));
    }
}
