use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageResolution {
    pub image: String,
    pub exact: bool,
    pub matched_label: Option<String>,
}

pub fn resolve_macos_vm_image(labels: &[String], override_image: Option<&str>) -> ImageResolution {
    if let Some(image) = override_image
        .map(str::trim)
        .filter(|image| !image.is_empty())
    {
        return ImageResolution {
            image: image.to_owned(),
            exact: true,
            matched_label: None,
        };
    }
    for label in labels {
        if let Some(mapped) = label_to_image(label) {
            return ImageResolution {
                image: mapped.to_owned(),
                exact: true,
                matched_label: Some(label.clone()),
            };
        }
    }
    let matched_label = labels
        .iter()
        .find(|label| label.to_ascii_lowercase().starts_with("macos"))
        .or_else(|| labels.first())
        .cloned();
    ImageResolution {
        image: DEFAULT_MACOS_IMAGE.to_owned(),
        exact: false,
        matched_label,
    }
}

fn label_to_image(label: &str) -> Option<&'static str> {
    match label.to_ascii_lowercase().as_str() {
        "macos-13" => Some("ghcr.io/cirruslabs/macos-ventura-xcode:latest"),
        "macos-14" => Some("ghcr.io/cirruslabs/macos-sonoma-xcode:latest"),
        "macos-15" => Some("ghcr.io/cirruslabs/macos-sequoia-xcode:latest"),
        "macos-26" => Some("ghcr.io/cirruslabs/macos-tahoe-xcode:latest"),
        "macos-latest" | "macos" => Some("ghcr.io/cirruslabs/macos-sonoma-xcode:latest"),
        _ => None,
    }
}
