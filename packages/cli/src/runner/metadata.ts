import path from "path";
import fs from "fs";
import type { Job } from "../types.ts";

// ─── Repo root detection ──────────────────────────────────────────────────────

/**
 * Walk up from `startPath` looking for a `.git` directory.
 * Returns the repo root, or `undefined` if none found.
 */
export function findRepoRoot(startPath: string): string | undefined {
  let dir = path.dirname(startPath);
  while (dir !== "/" && !fs.existsSync(path.join(dir, ".git"))) {
    dir = path.dirname(dir);
  }
  return dir !== "/" ? dir : undefined;
}

// ─── Workflow run ID derivation ───────────────────────────────────────────────

/**
 * Derive workflowRunId (group key) by stripping job/matrix/retry suffixes.
 * e.g. local-ci-redwoodjssdk-14-j1-m2-r2 → local-ci-redwoodjssdk-14
 */
export function deriveWorkflowRunId(containerName: string): string {
  return containerName.replace(/(-j\d+)?(-m\d+)?(-r\d+)?$/, "");
}

// ─── Metadata writing ─────────────────────────────────────────────────────────

export interface WriteJobMetadataOpts {
  logDir: string;
  containerName: string;
  job: Job;
}

/**
 * Write (or merge into) `metadata.json` in the log directory.
 *
 * Preserves orchestrator-written fields like matrixContext, warmCache, etc.
 * while adding/updating fields derived from the job and container name.
 */
export function writeJobMetadata(opts: WriteJobMetadataOpts): void {
  const { logDir, containerName, job } = opts;
  if (!job.workflowPath) {
    return;
  }

  const metadataPath = path.join(logDir, "metadata.json");

  // Derive repoPath from the workflow file (walk up to find .git)
  const repoPath = findRepoRoot(job.workflowPath) ?? "";

  // If the orchestrator (or retryRun) already wrote a metadata.json with the
  // correct workflowRunId, honour it. This is critical for retries of multi-job
  // runs (e.g. local-ci-runner-125-001-001) where a naive regex would strip only a
  // single suffix and produce the wrong group key.
  let workflowRunId: string | undefined;
  let attempt: number | undefined;
  // Preserve the jobName written by the orchestrator (e.g. "Shard (1/3)") so
  // human-readable labels aren't overwritten with the raw taskId on process start.
  let existingJobName: string | null = null;
  if (fs.existsSync(metadataPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      workflowRunId = existing.workflowRunId;
      attempt = existing.attempt;
      if (existing.jobName !== undefined) {
        existingJobName = existing.jobName;
      }
    } catch {
      // Fall through to derivation
    }
  }
  if (!workflowRunId) {
    workflowRunId = deriveWorkflowRunId(containerName);
  }

  // Build our fields; we'll merge them ON TOP of whatever the orchestrator wrote
  // so that matrixContext, warmCache, repoPath, etc. are preserved.
  const freshFields: Record<string, any> = {
    workflowPath: job.workflowPath,
    workflowName: path.basename(job.workflowPath, path.extname(job.workflowPath)),
    // Prefer the orchestrator-written label; fall back to raw taskId
    jobName: existingJobName !== null ? existingJobName : (job.taskId ?? null),
    workflowRunId,
    commitId: job.headSha || "WORKING_TREE",
    date: Date.now(),
    taskId: job.taskId,
    attempt: attempt ?? 1,
  };
  // Only overwrite repoPath if we actually found a .git root; otherwise keep
  // the orchestrator's value (which is always correct for temp-dir tests too).
  if (repoPath) {
    freshFields.repoPath = repoPath;
  }
  // Read back existing metadata to preserve orchestrator-written fields
  // like matrixContext, warmCache, etc.
  let existingMeta: Record<string, any> = {};
  if (fs.existsSync(metadataPath)) {
    try {
      existingMeta = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    } catch {}
  }
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({ ...existingMeta, ...freshFields }, null, 2),
    "utf-8",
  );
}
