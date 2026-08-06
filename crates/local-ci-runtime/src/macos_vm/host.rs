use super::*;

pub fn check_macos_vm_host(
    platform: &str,
    arch: &str,
    has_tart: bool,
    has_sshpass: bool,
) -> HostCapability {
    if !matches!(platform, "darwin" | "macos") {
        return HostCapability::Unsupported {
            reason: format!("macOS VM runner requires a macOS host (got {platform})."),
            hint: None,
        };
    }
    if !matches!(arch, "arm64" | "aarch64") {
        return HostCapability::Unsupported {
            reason: format!("macOS VM runner requires an Apple Silicon host (got {arch})."),
            hint: Some(
                "Apple's Virtualization.framework does not support macOS guests on Intel Macs."
                    .to_owned(),
            ),
        };
    }
    if !has_tart {
        return HostCapability::Unsupported {
            reason: "macOS VM runner requires `tart` to be installed.".to_owned(),
            hint: Some("Install with: brew install cirruslabs/cli/tart".to_owned()),
        };
    }
    if !has_sshpass {
        return HostCapability::Unsupported {
            reason: "macOS VM runner requires `sshpass` to be installed.".to_owned(),
            hint: Some("Install with: brew install hudochenkov/sshpass/sshpass".to_owned()),
        };
    }
    HostCapability::Supported
}
