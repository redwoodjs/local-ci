#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeTarget {
    pub name: &'static str,
    pub rust_target: &'static str,
    pub runner: &'static str,
    pub npm_package_suffix: &'static str,
    pub binary_name: &'static str,
    pub notarize: bool,
}

pub const NATIVE_TARGETS: &[NativeTarget] = &[
    NativeTarget {
        name: "linux-x64",
        rust_target: "x86_64-unknown-linux-gnu",
        runner: "ubuntu-latest",
        npm_package_suffix: "linux-x64",
        binary_name: "local-ci",
        notarize: false,
    },
    NativeTarget {
        name: "linux-arm64",
        rust_target: "aarch64-unknown-linux-gnu",
        runner: "ubuntu-24.04-arm",
        npm_package_suffix: "linux-arm64",
        binary_name: "local-ci",
        notarize: false,
    },
    NativeTarget {
        name: "macos-x64",
        rust_target: "x86_64-apple-darwin",
        runner: "macos-13",
        npm_package_suffix: "darwin-x64",
        binary_name: "local-ci",
        notarize: true,
    },
    NativeTarget {
        name: "macos-arm64",
        rust_target: "aarch64-apple-darwin",
        runner: "macos-15",
        npm_package_suffix: "darwin-arm64",
        binary_name: "local-ci",
        notarize: true,
    },
];

pub fn native_targets() -> &'static [NativeTarget] {
    NATIVE_TARGETS
}

pub fn release_archive_name(version: &str, target: &NativeTarget) -> String {
    format!("local-ci-{version}-{}.tar.gz", target.name)
}

pub fn checksum_name(version: &str, target: &NativeTarget) -> String {
    format!("{}.sha256", release_archive_name(version, target))
}

pub fn npm_optional_package_name(target: &NativeTarget) -> String {
    format!("@redwoodjs/local-ci-{}", target.npm_package_suffix)
}

pub fn platform_package_suffix(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("linux", "x64" | "x86_64" | "amd64") => Some("linux-x64"),
        ("linux", "arm64" | "aarch64") => Some("linux-arm64"),
        ("darwin", "x64" | "x86_64" | "amd64") => Some("darwin-x64"),
        ("darwin", "arm64" | "aarch64") => Some("darwin-arm64"),
        _ => None,
    }
}

pub fn direct_download_url(base_url: &str, version: &str, target: &NativeTarget) -> String {
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        release_archive_name(version, target)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_release_matrix_covers_required_targets() {
        let names = native_targets()
            .iter()
            .map(|target| target.name)
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec!["linux-x64", "linux-arm64", "macos-x64", "macos-arm64"]
        );
        assert!(
            native_targets()
                .iter()
                .any(|target| target.rust_target == "x86_64-unknown-linux-gnu")
        );
        assert!(
            native_targets()
                .iter()
                .any(|target| target.rust_target == "aarch64-unknown-linux-gnu")
        );
        assert!(
            native_targets()
                .iter()
                .any(|target| target.rust_target == "x86_64-apple-darwin")
        );
        assert!(
            native_targets()
                .iter()
                .any(|target| target.rust_target == "aarch64-apple-darwin")
        );
    }

    #[test]
    fn archive_and_checksum_names_are_stable() {
        let linux = &native_targets()[0];

        assert_eq!(
            release_archive_name("v1.2.3", linux),
            "local-ci-v1.2.3-linux-x64.tar.gz"
        );
        assert_eq!(
            checksum_name("v1.2.3", linux),
            "local-ci-v1.2.3-linux-x64.tar.gz.sha256"
        );
    }

    #[test]
    fn npm_package_names_and_platform_suffixes_match_node_platforms() {
        assert_eq!(
            npm_optional_package_name(&native_targets()[0]),
            "@redwoodjs/local-ci-linux-x64"
        );
        assert_eq!(platform_package_suffix("linux", "x64"), Some("linux-x64"));
        assert_eq!(
            platform_package_suffix("darwin", "arm64"),
            Some("darwin-arm64")
        );
        assert_eq!(platform_package_suffix("win32", "x64"), None);
    }

    #[test]
    fn direct_download_url_joins_base_version_and_target() {
        let url = direct_download_url(
            "https://example.com/releases/v1.2.3/",
            "v1.2.3",
            &native_targets()[3],
        );

        assert_eq!(
            url,
            "https://example.com/releases/v1.2.3/local-ci-v1.2.3-macos-arm64.tar.gz"
        );
    }

    #[test]
    fn npm_platform_packages_stage_bin_entrypoints_in_tree() {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = manifest.parent().unwrap().parent().unwrap();
        for target in native_targets() {
            let package_dir = root
                .join("packages")
                .join(format!("local-ci-{}", target.npm_package_suffix));
            assert!(
                package_dir.join("bin/local-ci").exists(),
                "{} should include bin/local-ci",
                package_dir.display()
            );
            let package_json = std::fs::read_to_string(package_dir.join("package.json")).unwrap();
            assert!(package_json.contains("\"bin\""));
            assert!(package_json.contains("\"local-ci\": \"bin/local-ci\""));
        }
    }

    #[test]
    fn macos_targets_are_notarization_candidates() {
        for target in native_targets() {
            assert_eq!(target.notarize, target.name.starts_with("macos-"));
        }
    }
}
