import { exec, execSync } from "child_process";
import { promisify } from "util";
import { copyWorkspace } from "../output/cleanup.ts";
import { findRepoRoot } from "./metadata.ts";

const execAsync = promisify(exec);

// ─── Workspace preparation ────────────────────────────────────────────────────

export interface PrepareWorkspaceOpts {
  workflowPath?: string;
  headSha?: string;
  githubRepo?: string;
  workspaceDir: string;
}

/**
 * Copy source files into the workspace directory, then initialise a fake
 * git repo so `actions/checkout` finds a valid workspace.
 */
export async function prepareWorkspace(opts: PrepareWorkspaceOpts): Promise<void> {
  const { workflowPath, headSha, githubRepo, workspaceDir } = opts;

  // Resolve repo root — needed for both archive and rsync paths.
  // Derive from the workflow path (which lives inside the target repo) so we copy
  // from the correct repo, not from the CLI's CWD (which is local-ci).
  let repoRoot: string | undefined;
  if (workflowPath) {
    repoRoot = findRepoRoot(workflowPath);
  }
  if (!repoRoot) {
    repoRoot = execSync(`git rev-parse --show-toplevel`).toString().trim();
  }

  if (headSha && headSha !== "HEAD") {
    // Specific SHA requested — use git archive (clean snapshot)
    await execAsync(`git archive ${headSha} | tar -x -C ${workspaceDir}`, {
      cwd: repoRoot,
    });
  } else {
    // Default: copy the working directory as-is, including dirty/untracked files.
    // Uses git ls-files to respect .gitignore (avoids copying node_modules, _/, etc.)
    // On macOS: per-file APFS CoW clones. On Linux: rsync. Fallback: fs.cpSync.
    copyWorkspace(repoRoot, workspaceDir);
  }

  if (githubRepo) {
    await initFakeGitRepo(workspaceDir, githubRepo);
  }
}

// ─── Fake git init ────────────────────────────────────────────────────────────

/**
 * Initialise a fake git repository in `dir` so that `actions/checkout`
 * finds a valid workspace with a remote origin and detached HEAD.
 *
 * Each command is awaited individually so the event loop can service the
 * render timer between git process spawns (avoids freezing all spinners).
 */
async function initFakeGitRepo(dir: string, githubRepo: string): Promise<void> {
  const opts = { cwd: dir };
  // The remote URL must exactly match what actions/checkout computes via URL.origin.
  // Node.js URL.origin strips the default port (80), so we must NOT include :80.
  await execAsync(`git init`, opts);
  await execAsync(`git config user.name "local-ci"`, opts);
  await execAsync(`git config user.email "local-ci@example.com"`, opts);
  await execAsync(`git remote add origin http://127.0.0.1/${githubRepo}`, opts);
  await execAsync(`git add . && git commit -m "workspace" || true`, opts);
  // Create main and refs/remotes/origin/main pointing to this commit
  await execAsync(`git branch -M main`, opts);
  await execAsync(`git update-ref refs/remotes/origin/main HEAD`, opts);
  // Detach HEAD so checkout can freely delete ALL branches (it can't delete the current branch)
  await execAsync(`git checkout --detach HEAD`, opts);
}
