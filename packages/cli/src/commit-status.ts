import { execSync } from "child_process";
import { config } from "./config.ts";
import type { JobResult } from "./output/reporter.ts";

/**
 * Post a GitHub commit status via the `gh` CLI.
 * Only called when --commit-status is passed. Requires a GitHub token.
 */
export function postCommitStatus(results: JobResult[], sha?: string, githubToken?: string): void {
  if (!githubToken) {
    console.warn(
      "[Local CI] --commit-status requires a GitHub token. Use --github-token or set LOCAL_CI_GITHUB_TOKEN.",
    );
    return;
  }

  // Check if gh CLI is available
  try {
    execSync("which gh", { stdio: "ignore" });
  } catch {
    return;
  }

  const resolvedSha =
    sha ||
    (() => {
      try {
        return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
      } catch {
        return undefined;
      }
    })();

  if (!resolvedSha) {
    return;
  }

  const repo = config.GITHUB_REPO;
  if (!repo) {
    return;
  }

  const passed = results.filter((r) => r.succeeded).length;
  const total = results.length;
  const allPassed = passed === total;

  const state = allPassed ? "success" : "failure";
  const description = allPassed
    ? `"It works on my machine!"`
    : `${passed}/${total} jobs passed, ${total - passed} failed`;

  try {
    execSync(
      `gh api repos/${repo}/statuses/${resolvedSha} ` +
        `-f state=${state} ` +
        `-f context=local-ci ` +
        `-f description=${JSON.stringify(description)} ` +
        `-f target_url=https://local-ci.dev`,
      { stdio: "ignore" },
    );
  } catch {
    // gh command failed (e.g. no auth, no network) — skip silently
  }
}
