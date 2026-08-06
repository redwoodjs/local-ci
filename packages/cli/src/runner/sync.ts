import path from "path";
import fs from "fs";
import { execSync, spawnSync } from "child_process";

// ─── Retry workspace sync ─────────────────────────────────────────────────────

/**
 * Resolve the repo root by walking up from `cwd` to find `.git`.
 */
function resolveRepoRoot(): string {
  let dir = process.cwd();
  while (dir !== "/" && !fs.existsSync(path.join(dir, ".git"))) {
    dir = path.dirname(dir);
  }
  return dir === "/" ? process.cwd() : dir;
}

/**
 * Discover the workspace directory inside a run directory.
 *
 * The structure is: `<runDir>/work/<repoName>/<repoName>/`
 */
function findWorkspaceDir(runDir: string): string | null {
  const workDir = path.join(runDir, "work");
  if (!fs.existsSync(workDir)) {
    return null;
  }
  for (const entry of fs.readdirSync(workDir)) {
    const nested = path.join(workDir, entry, entry);
    if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
      return nested;
    }
  }
  return null;
}

/**
 * Sync source files from the local repo into the run's workspace directory.
 *
 * Uses `rsync --delete` to mirror changes (including deleted files), while
 * preserving `node_modules` and `.git` so installed dependencies and the
 * fake git repo remain intact.
 *
 * Called before sending the `retry` signal so the container sees local edits.
 */
export function syncWorkspaceForRetry(runDir: string): void {
  const workspaceDir = findWorkspaceDir(runDir);
  if (!workspaceDir) {
    return;
  }

  const repoRoot = resolveRepoRoot();

  // Get tracked + untracked (respecting .gitignore) file list — same as
  // copyWorkspace uses for the initial clone.
  const files = execSync("git ls-files --cached --others --exclude-standard -z", {
    stdio: "pipe",
    cwd: repoRoot,
  })
    .toString()
    .split("\0")
    .filter(Boolean);

  // Sync via rsync on all platforms (we need --delete semantics).
  // Pass the file list via stdin to avoid shell injection.
  const input = files.join("\0");
  const result = spawnSync(
    "rsync",
    ["-a", "--delete", "--files-from=-", "--from0", "./", workspaceDir + "/"],
    {
      input,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: repoRoot,
    },
  );

  if (result.status !== 0) {
    // Fallback: copy files individually
    for (const file of files) {
      const src = path.join(repoRoot, file);
      const dest = path.join(workspaceDir, file);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      } catch {
        // Skip files that can't be copied
      }
    }
  }

  console.log(`[Local CI] Synced workspace from ${repoRoot}`);
}
