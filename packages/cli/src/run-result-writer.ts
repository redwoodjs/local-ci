import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobResult } from "./output/reporter.ts";

export const RUN_RESULT_SCHEMA_VERSION = 1;

export interface RunResultStepEntry {
  name: string;
  status: "passed" | "failed" | "skipped";
  /** Only present when the per-step log file still exists at write time. */
  logPath?: string;
}

export interface RunResultJobEntry {
  name: string;
  workflow: string;
  status: "passed" | "failed";
  durationMs: number;
  failingStep?: string;
  /** Only present when the on-disk file still exists at write time. */
  debugLogPath?: string;
  steps?: RunResultStepEntry[];
}

export interface RunResultFile {
  schemaVersion: number;
  repo: string;
  branch: string;
  worktreePath: string;
  headSha: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed";
  jobs: RunResultJobEntry[];
}

export interface RunResultInput {
  repo: string;
  branch: string;
  worktreePath: string;
  headSha: string;
  startedAt: Date;
  finishedAt: Date;
  results: JobResult[];
}

export type StateDirEnv = Partial<
  Record<"LOCAL_CI_STATE_DIR" | "LOCAL_CI_LOG_DIR" | "XDG_STATE_HOME" | "HOME", string>
>;

/**
 * Resolve the root directory for per-branch run-result JSON files.
 *
 * Priority:
 *   1. `LOCAL_CI_STATE_DIR` override (used as-is)
 *   2. `$XDG_STATE_HOME/local-ci` on Linux (falling back to `~/.local/state/local-ci`)
 *   3. `~/Library/Application Support/local-ci` on macOS
 *   4. Elsewhere: `~/.local/state/local-ci`
 */
export function resolveStateDir(
  env: StateDirEnv = process.env as StateDirEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.LOCAL_CI_STATE_DIR) {
    return env.LOCAL_CI_STATE_DIR;
  }
  const home = env.HOME ?? os.homedir();
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "local-ci");
  }
  const xdgState = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return path.join(xdgState, "local-ci");
}

/**
 * Resolve the root directory for per-run log artifacts (logs, timeline, metadata).
 * Defaults to `<stateDir>/logs/` so log lifetime is co-managed with the run-result
 * JSON that references them. `LOCAL_CI_LOG_DIR` overrides it for users who want
 * logs in a cache-shaped location.
 */
export function resolveLogsDir(
  env: StateDirEnv = process.env as StateDirEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.LOCAL_CI_LOG_DIR) {
    return env.LOCAL_CI_LOG_DIR;
  }
  return path.join(resolveStateDir(env, platform), "logs");
}

/** Hex-ish short hash of the absolute worktree path — disambiguates branches that are checked out in multiple worktrees. */
export function worktreePathHash(worktreePath: string): string {
  return crypto.createHash("sha1").update(path.resolve(worktreePath)).digest("hex").slice(0, 8);
}

/** Replace filesystem-unfriendly characters in a branch segment. Slashes become `-` so `feat/foo` lands in one file. */
function sanitizeBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Absolute path of the JSON file for `{repo, branch, worktreePath}`.
 * Filename is `<branch>.<worktree-hash>.json` to disambiguate multiple worktrees on the same branch.
 */
export function resolveRunResultPath(
  stateDir: string,
  repo: string,
  branch: string,
  worktreePath: string,
): string {
  return path.join(
    stateDir,
    repo,
    `${sanitizeBranch(branch)}.${worktreePathHash(worktreePath)}.json`,
  );
}

/** Include a file path only when the file is still on disk — passing-job logs get cleaned up. */
function pathIfExists(p: string | undefined): string | undefined {
  if (!p) {
    return undefined;
  }
  try {
    return fs.existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

export function buildRunResultJson(input: RunResultInput): RunResultFile {
  const jobs: RunResultJobEntry[] = input.results.map((r) => {
    const entry: RunResultJobEntry = {
      name: r.name,
      workflow: r.workflow,
      status: r.succeeded ? "passed" : "failed",
      durationMs: r.durationMs,
    };
    const debugLogPath = pathIfExists(r.debugLogPath);
    if (debugLogPath) {
      entry.debugLogPath = debugLogPath;
    }
    if (r.failedStep) {
      entry.failingStep = r.failedStep;
    }
    if (r.steps && r.steps.length > 0) {
      entry.steps = r.steps.map((s) => {
        const step: RunResultStepEntry = { name: s.name, status: s.status };
        const logPath = pathIfExists(s.logPath);
        if (logPath) {
          step.logPath = logPath;
        }
        return step;
      });
    }
    return entry;
  });
  const status: "passed" | "failed" = input.results.every((r) => r.succeeded) ? "passed" : "failed";
  return {
    schemaVersion: RUN_RESULT_SCHEMA_VERSION,
    repo: input.repo,
    branch: input.branch,
    worktreePath: path.resolve(input.worktreePath),
    headSha: input.headSha,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    status,
    jobs,
  };
}

/**
 * Write the run-result JSON atomically (write to `*.tmp` then rename).
 * Returns the final file path. Never throws — a failed persist must not fail the run.
 */
export function writeRunResult(
  input: RunResultInput,
  opts: { stateDir?: string } = {},
): string | null {
  try {
    const stateDir = opts.stateDir ?? resolveStateDir();
    const filePath = resolveRunResultPath(stateDir, input.repo, input.branch, input.worktreePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(buildRunResultJson(input), null, 2) + "\n");
    fs.renameSync(tmpPath, filePath);
    return filePath;
  } catch {
    return null;
  }
}
