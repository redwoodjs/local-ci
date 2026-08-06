/**
 * Runs-on compatibility classifier.
 *
 * local-ci today runs every job in a Linux Docker container, regardless of
 * the job's `runs-on:` label. For jobs that explicitly target macOS or
 * Windows runners, silently landing them in a Linux container produces
 * confusing failures — typically "command not found" at the first OS-specific
 * step (see https://github.com/redwoodjs/local-ci/issues/254).
 *
 * This module classifies a job's `runs-on:` labels so the caller can skip
 * unsupported jobs with a clear warning instead. Real macOS runner support
 * is tracked separately in https://github.com/redwoodjs/local-ci/issues/258.
 */

export type RunnerOSKind = "linux" | "macos" | "windows" | "other";

/**
 * Classify the OS family implied by a job's `runs-on:` labels.
 *
 * Rules (first match wins):
 *   - Any `macos` or `macos-*` label → "macos"
 *   - Any `windows` or `windows-*` label → "windows"
 *   - Any `ubuntu`, `ubuntu-*`, or `linux` label → "linux"
 *   - Otherwise (empty array, pure `self-hosted`, unknown custom label) → "other"
 *
 * "other" is deliberately permissive — a user with a custom self-hosted label
 * today lands in the Linux container by default, and we don't want to
 * regress them.
 */
export function classifyRunsOn(labels: string[]): RunnerOSKind {
  for (const raw of labels) {
    const l = String(raw).toLowerCase().trim();
    if (l === "macos" || l.startsWith("macos-")) {
      return "macos";
    }
    if (l === "windows" || l.startsWith("windows-")) {
      return "windows";
    }
  }
  for (const raw of labels) {
    const l = String(raw).toLowerCase().trim();
    if (l === "ubuntu" || l.startsWith("ubuntu-") || l === "linux") {
      return "linux";
    }
  }
  return "other";
}

/** Is this OS something local-ci does not yet know how to run? */
export function isUnsupportedOS(kind: RunnerOSKind): boolean {
  return kind === "macos" || kind === "windows";
}

/**
 * Format a user-facing warning for a job skipped because its `runs-on:`
 * targets an OS local-ci can't execute locally. Written for stderr.
 *
 * For macOS, `hostCapability` (from `checkMacosVmHost`) lets us say *why* the
 * host can't run the VM — e.g. "tart not installed" vs "Intel Mac" vs
 * "not macOS" — plus an install hint when relevant.
 */
export function formatUnsupportedOSWarning(
  taskName: string,
  labels: string[],
  kind: RunnerOSKind,
  hostCapability?: { reason: string; hint?: string },
): string {
  const labelStr = labels.length > 0 ? labels.join(", ") : "(none)";
  const osName = kind === "macos" ? "macOS" : kind === "windows" ? "Windows" : kind;
  const body: (string | undefined)[] =
    kind === "macos"
      ? [
          hostCapability?.reason ?? "This host cannot run macOS VMs.",
          hostCapability?.hint,
          "Tracking: https://github.com/redwoodjs/local-ci/issues/258",
        ]
      : [
          "local-ci currently only runs jobs in a Linux container, so this job",
          "cannot execute locally. Tracking: https://github.com/redwoodjs/local-ci/issues/254",
        ];
  return [
    `[Local CI] Skipping job "${taskName}": runs-on targets ${osName} (${labelStr}).`,
    ...body.filter((l): l is string => Boolean(l)).map((l) => `  ${l}`),
  ].join("\n");
}
