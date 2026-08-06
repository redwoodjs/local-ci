use super::*;

pub fn resolve_macos_runner_version(env_value: Option<&str>) -> String {
    env_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_MACOS_RUNNER_VERSION)
        .to_owned()
}

pub fn macos_runner_tarball_url(version: &str) -> String {
    format!(
        "https://github.com/actions/runner/releases/download/v{version}/actions-runner-osx-arm64-{version}.tar.gz"
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedRunner {
    pub version: String,
    pub dir: PathBuf,
}

pub trait RunnerBinaryIo {
    fn download_to_file(&mut self, url: &str, dst: &Path) -> Result<(), String>;
    fn extract_tarball(&mut self, tarball: &Path, dst: &Path) -> Result<(), String>;
}

#[derive(Debug, Default)]
pub struct CommandRunnerBinaryIo;

impl RunnerBinaryIo for CommandRunnerBinaryIo {
    fn download_to_file(&mut self, url: &str, dst: &Path) -> Result<(), String> {
        let status = Command::new("curl")
            .args(["-fsSL", "-o"])
            .arg(dst)
            .arg(url)
            .status()
            .map_err(|err| format!("failed to run curl: {err}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("curl failed while downloading {url}"))
        }
    }

    fn extract_tarball(&mut self, tarball: &Path, dst: &Path) -> Result<(), String> {
        let status = Command::new("tar")
            .arg("-xzf")
            .arg(tarball)
            .arg("-C")
            .arg(dst)
            .status()
            .map_err(|err| format!("failed to run tar: {err}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("tar failed while extracting {}", tarball.display()))
        }
    }
}

pub fn ensure_macos_runner_binary(
    io: &mut impl RunnerBinaryIo,
    cache_root: &Path,
    version: &str,
) -> Result<CachedRunner, String> {
    let dir = cache_root.join(version);
    let marker = dir.join(".extracted");
    if marker.exists() && dir.join("run.sh").exists() {
        return Ok(CachedRunner {
            version: version.to_owned(),
            dir,
        });
    }

    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let tarball = dir.join(format!("actions-runner-osx-arm64-{version}.tar.gz"));
    if !tarball.exists() {
        io.download_to_file(&macos_runner_tarball_url(version), &tarball)?;
    }
    io.extract_tarball(&tarball, &dir)?;
    if !dir.join("run.sh").exists() {
        return Err(format!(
            "Extracted runner at {} does not contain run.sh — tarball structure changed?",
            dir.display()
        ));
    }
    fs::write(marker, "extracted\n").map_err(|err| err.to_string())?;
    Ok(CachedRunner {
        version: version.to_owned(),
        dir,
    })
}
