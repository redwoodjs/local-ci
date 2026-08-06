use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSnapshot {
    pub source: PathBuf,
    pub destination: PathBuf,
    pub copied_files: Vec<PathBuf>,
}

pub fn sync_worktree_to_workspace(
    repo_root: &Path,
    destination: &Path,
) -> Result<WorkspaceSnapshot, String> {
    let repo_root = canonicalize_existing(repo_root)?;
    let destination = normalize_destination(destination)?;
    if destination.starts_with(&repo_root) {
        return Err("workspace destination must not be inside the source repository".to_owned());
    }

    let files = git_ls_files(&repo_root)?;
    if destination.exists() {
        fs::remove_dir_all(&destination).map_err(|err| err.to_string())?;
    }
    fs::create_dir_all(&destination).map_err(|err| err.to_string())?;

    let mut copied_files = Vec::new();
    for relative in files {
        let source = repo_root.join(&relative);
        if !source.exists() && fs::symlink_metadata(&source).is_err() {
            continue;
        }
        let target = destination.join(&relative);
        copy_path(&source, &target)?;
        copied_files.push(relative);
    }
    copied_files.sort();

    Ok(WorkspaceSnapshot {
        source: repo_root,
        destination,
        copied_files,
    })
}

fn canonicalize_existing(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|err| format!("failed to resolve {}: {err}", path.display()))
}

fn normalize_destination(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return canonicalize_existing(path);
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let parent = canonicalize_existing(parent)?;
    Ok(path
        .file_name()
        .map_or(parent.clone(), |name| parent.join(name)))
}

fn git_ls_files(repo_root: &Path) -> Result<Vec<PathBuf>, String> {
    let output = Command::new("git")
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .current_dir(repo_root)
        .output()
        .map_err(|err| format!("failed to list workspace files: {err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| PathBuf::from(String::from_utf8_lossy(entry).into_owned()))
        .collect())
}

fn copy_path(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|err| err.to_string())?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    if metadata.file_type().is_symlink() {
        let link_target = fs::read_link(source).map_err(|err| err.to_string())?;
        create_symlink(&link_target, target)
    } else if metadata.is_file() {
        fs::copy(source, target).map_err(|err| err.to_string())?;
        Ok(())
    } else if metadata.is_dir() {
        fs::create_dir_all(target).map_err(|err| err.to_string())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn create_symlink(source: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(source, target).map_err(|err| err.to_string())
}

#[cfg(windows)]
fn create_symlink(source: &Path, target: &Path) -> Result<(), String> {
    std::os::windows::fs::symlink_file(source, target).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!(
            "local-ci-rust-workspace-{name}-{pid}-{nonce}-{counter}"
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_ok(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo() -> PathBuf {
        let repo = temp_dir("repo");
        git_ok(&repo, &["init"]);
        fs::write(repo.join("tracked.txt"), "old\n").unwrap();
        fs::write(repo.join(".gitignore"), "ignored.txt\nnode_modules/\n").unwrap();
        git_ok(&repo, &["add", "tracked.txt", ".gitignore"]);
        git_ok(
            &repo,
            &[
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test User",
                "commit",
                "-m",
                "init",
            ],
        );
        repo
    }

    #[test]
    fn sync_includes_tracked_modifications_and_untracked_files() {
        let repo = init_repo();
        fs::write(repo.join("tracked.txt"), "new\n").unwrap();
        fs::write(repo.join("untracked.txt"), "hello\n").unwrap();
        let dest = temp_dir("dest");

        let snapshot = sync_worktree_to_workspace(&repo, &dest).unwrap();

        assert_eq!(
            fs::read_to_string(dest.join("tracked.txt")).unwrap(),
            "new\n"
        );
        assert_eq!(
            fs::read_to_string(dest.join("untracked.txt")).unwrap(),
            "hello\n"
        );
        assert!(
            snapshot
                .copied_files
                .contains(&PathBuf::from("tracked.txt"))
        );
        assert!(
            snapshot
                .copied_files
                .contains(&PathBuf::from("untracked.txt"))
        );
    }

    #[test]
    fn sync_excludes_ignored_files() {
        let repo = init_repo();
        fs::write(repo.join("ignored.txt"), "ignore me\n").unwrap();
        fs::create_dir_all(repo.join("node_modules/pkg")).unwrap();
        fs::write(repo.join("node_modules/pkg/index.js"), "ignore me\n").unwrap();
        let dest = temp_dir("ignored-dest");

        let snapshot = sync_worktree_to_workspace(&repo, &dest).unwrap();

        assert!(!dest.join("ignored.txt").exists());
        assert!(!dest.join("node_modules").exists());
        assert!(
            !snapshot
                .copied_files
                .contains(&PathBuf::from("ignored.txt"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn sync_preserves_tracked_symlinks() {
        let repo = init_repo();
        std::os::unix::fs::symlink("tracked.txt", repo.join("link.txt")).unwrap();
        git_ok(&repo, &["add", "link.txt"]);
        let dest = temp_dir("symlink-dest");

        sync_worktree_to_workspace(&repo, &dest).unwrap();

        let link = fs::read_link(dest.join("link.txt")).unwrap();
        assert_eq!(link, PathBuf::from("tracked.txt"));
    }

    #[test]
    fn refuses_to_sync_into_source_repository() {
        let repo = init_repo();
        let err = sync_worktree_to_workspace(&repo, &repo.join("nested")).unwrap_err();

        assert!(err.contains("must not be inside"));
    }
}
