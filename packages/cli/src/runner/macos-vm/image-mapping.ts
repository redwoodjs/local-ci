// Map GitHub Actions `runs-on` macOS labels to cirruslabs tart image tags.
// Reference: https://github.com/orgs/cirruslabs/packages?repo_name=macos-image-templates

export const DEFAULT_MACOS_IMAGE = "ghcr.io/cirruslabs/macos-sequoia-xcode:latest";

const LABEL_TO_IMAGE: Record<string, string> = {
  "macos-13": "ghcr.io/cirruslabs/macos-ventura-xcode:latest",
  "macos-14": "ghcr.io/cirruslabs/macos-sonoma-xcode:latest",
  "macos-15": "ghcr.io/cirruslabs/macos-sequoia-xcode:latest",
  "macos-26": "ghcr.io/cirruslabs/macos-tahoe-xcode:latest",
  // GitHub's `macos-latest` alias rolls forward over time. Tracking GitHub's
  // published default (currently macos-14) would require a network lookup per
  // run, so we pin to the same version GitHub points the alias at today.
  "macos-latest": "ghcr.io/cirruslabs/macos-sonoma-xcode:latest",
  // Alias-only forms occasionally seen in older workflows.
  macos: "ghcr.io/cirruslabs/macos-sonoma-xcode:latest",
};

export interface ImageResolution {
  image: string;
  /** True when we recognized a specific label; false when we fell back. */
  exact: boolean;
  /** The label we matched on (or the first one we considered when falling back). */
  matchedLabel: string | null;
}

export function resolveMacosVmImage(labels: string[]): ImageResolution {
  const override = process.env.LOCAL_CI_MACOS_VM_IMAGE?.trim();
  if (override) {
    return { image: override, exact: true, matchedLabel: null };
  }
  for (const label of labels) {
    const mapped = LABEL_TO_IMAGE[label.toLowerCase()];
    if (mapped) {
      return { image: mapped, exact: true, matchedLabel: label };
    }
  }
  // Couldn't recognize any label (e.g. `self-hosted, macos, arm64`). Fall back
  // to the most recent stable image we know about so the job still runs.
  const firstMacLike = labels.find((l) => /^macos/i.test(l)) ?? labels[0] ?? null;
  return { image: DEFAULT_MACOS_IMAGE, exact: false, matchedLabel: firstMacLike };
}
