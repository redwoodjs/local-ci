use super::*;

pub fn hash_files(repo_path: &Path, patterns: &[String]) -> String {
    let mut included = BTreeSet::new();
    for pattern in patterns {
        if let Some(negative) = pattern.strip_prefix('!') {
            for file in find_files(repo_path, negative) {
                included.remove(&file);
            }
        } else {
            included.extend(find_files(repo_path, pattern));
        }
    }

    if included.is_empty() {
        return ZERO_SHA.to_owned();
    }

    let mut hasher = Sha256::new();
    for file in included {
        if let Ok(bytes) = fs::read(file) {
            hasher.update(bytes);
        }
    }
    format!("{:x}", hasher.finalize())
}

pub(super) fn find_files(root_dir: &Path, pattern: &str) -> BTreeSet<PathBuf> {
    let pattern = pattern.strip_prefix("./").unwrap_or(pattern);
    let matcher = Glob::new(pattern).ok().map(|glob| glob.compile_matcher());
    let mut results = BTreeSet::new();
    walk_files(root_dir, Path::new(""), matcher.as_ref(), &mut results);
    results
}

pub(super) fn walk_files(
    root_dir: &Path,
    relative: &Path,
    matcher: Option<&globset::GlobMatcher>,
    results: &mut BTreeSet<PathBuf>,
) {
    let dir = root_dir.join(relative);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        if name == "node_modules" {
            continue;
        }
        let relative_child = relative.join(&name);
        if entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            walk_files(root_dir, &relative_child, matcher, results);
        } else if matcher.is_some_and(|matcher| matcher.is_match(&relative_child)) {
            results.insert(root_dir.join(relative_child));
        }
    }
}
