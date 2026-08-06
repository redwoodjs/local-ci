import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execFileP = promisify(execFile);

/**
 * Compute a SHA that represents the current dirty working-tree state, as if
 * it were committed.  Uses a temporary index + `git write-tree` /
 * `git commit-tree` so no refs are moved and real history is untouched.
 *
 * Returns `undefined` when the tree is clean (no uncommitted changes).
 */
export async function computeDirtySha(repoRoot: string): Promise<string | undefined> {
  const git = async (env: NodeJS.ProcessEnv | undefined, ...args: string[]): Promise<string> => {
    const { stdout } = await execFileP("git", args, { cwd: repoRoot, encoding: "utf-8", env });
    return stdout.trim();
  };
  try {
    // Quick check: anything dirty?
    const status = await git(undefined, "status", "--porcelain");
    if (!status) {
      return undefined;
    }

    const gitDir = await git(undefined, "rev-parse", "--git-dir");
    const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir);
    const tmpIndex = path.join(absoluteGitDir, `index-local-ci-${Date.now()}`);

    try {
      // Seed the temp index from the real one so we start from the current staging area.
      fs.copyFileSync(path.join(absoluteGitDir, "index"), tmpIndex);

      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

      // Stage everything (tracked + untracked, respecting .gitignore) into the temp index.
      await git(env, "add", "-A");

      // Write a tree object from the temp index.
      const tree = await git(env, "write-tree");

      // Create an ephemeral commit object parented on HEAD — no ref is updated.
      return await git(
        undefined,
        "commit-tree",
        tree,
        "-p",
        "HEAD",
        "-m",
        "local-ci: dirty working tree",
      );
    } finally {
      try {
        fs.unlinkSync(tmpIndex);
      } catch {}
    }
  } catch {
    return undefined;
  }
}
