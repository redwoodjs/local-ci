// ─── State Renderer ───────────────────────────────────────────────────────────
// Pure function: RunState → string.
// The render loop in cli.ts calls this on every tick and passes the result to
// logUpdate. No side effects, no I/O — fully testable in isolation.

import path from "path";
import { renderTree, type TreeNode } from "./tree-renderer.ts";
import type { RunState, JobState, StepState } from "./run-state.ts";

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const RED = `${String.fromCharCode(27)}[31m`;
const YELLOW = `${String.fromCharCode(27)}[33m`;
const DIM = `${String.fromCharCode(27)}[2m`;
const RESET = `${String.fromCharCode(27)}[0m`;

// ─── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getSpinnerFrame(): string {
  return SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length];
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

// ─── Step node builder ────────────────────────────────────────────────────────

function buildStepNode(step: StepState, job: JobState, padW: number): TreeNode {
  const pad = (n: number) => String(n).padStart(padW);
  const dur = step.durationMs !== undefined ? ` (${Math.round(step.durationMs / 1000)}s)` : "";

  switch (step.status) {
    case "running": {
      const elapsed = step.startedAt
        ? Math.round((Date.now() - new Date(step.startedAt).getTime()) / 1000)
        : 0;
      const frame = getSpinnerFrame();
      // Retrying (was paused, now running again on same step)
      if ((job.attempt ?? 0) > 0 && job.pausedAtStep === step.name) {
        return {
          label: `${frame} ${pad(step.index)}. ${step.name} — retrying (${elapsed}s...)`,
        };
      }
      return {
        label: `${frame} ${pad(step.index)}. ${step.name} (${elapsed}s...)`,
      };
    }

    case "paused": {
      const frozenElapsed =
        job.pausedAtMs && step.startedAt
          ? Math.round(
              (new Date(job.pausedAtMs).getTime() - new Date(step.startedAt).getTime()) / 1000,
            )
          : step.startedAt
            ? Math.round((Date.now() - new Date(step.startedAt).getTime()) / 1000)
            : 0;
      return {
        label: `⏸ ${pad(step.index)}. ${step.name} (${frozenElapsed}s)`,
        children: [
          {
            label: `${YELLOW}Step failed attempt #${job.attempt ?? 1}${RESET}`,
          },
        ],
      };
    }

    case "failed":
      return { label: `✗ ${pad(step.index)}. ${step.name}${dur}` };

    case "skipped":
      return { label: `⊘ ${pad(step.index)}. ${step.name}${dur}` };

    case "completed":
      return { label: `✓ ${pad(step.index)}. ${step.name}${dur}` };

    case "pending":
    default:
      return { label: `○ ${pad(step.index)}. ${step.name}` };
  }
}

// ─── Job node builder ─────────────────────────────────────────────────────────

/**
 * Build the TreeNode(s) for a job.
 *
 * - `singleJobMode`: true when there is exactly one job across all workflows.
 *   In this mode the "Starting runner" node is shown alongside the job node,
 *   matching the pre-refactor single-workflow rendering.
 */
function buildJobNodes(job: JobState, singleJobMode: boolean): TreeNode[] {
  const degradedTag = job.classification === "degraded" ? " [degraded]" : "";
  const degradedNode =
    job.classification === "degraded" && job.classificationSummary
      ? [{ label: `${YELLOW}${job.classificationSummary}${RESET}` }]
      : [];

  // ── Booting (container starting, no timeline yet) ──────────────────────────
  if (job.status === "booting") {
    const elapsed = job.startedAt
      ? Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000)
      : 0;
    const bootNode: TreeNode = {
      label: `${getSpinnerFrame()} Starting runner ${job.runnerId}${degradedTag} (${elapsed}s)`,
    };
    const children: TreeNode[] = [];
    if (job.pullProgress) {
      const { phase, currentBytes, totalBytes } = job.pullProgress;
      const pct = totalBytes > 0 ? Math.round((currentBytes / totalBytes) * 100) : 0;
      const label = phase === "extracting" ? "Extracting" : "Downloading";
      children.push({
        label: `${DIM}${label}: ${fmtBytes(currentBytes)} / ${fmtBytes(totalBytes)} (${pct}%)${RESET}`,
      });
    }
    if (job.logDir) {
      const shortLogDir = job.logDir.replace(/^.*?(local-ci\/)/, "$1");
      children.push({ label: `${DIM}Logs: ${shortLogDir}${RESET}` });
    }
    if (degradedNode.length > 0) {
      children.push(...degradedNode);
    }
    if (children.length > 0) {
      bootNode.children = children;
    }
    return [bootNode];
  }

  // ── Completed / failed in multi-job mode → collapse to one line ────────────
  if (!singleJobMode && (job.status === "completed" || job.status === "failed")) {
    const dur = job.durationMs !== undefined ? ` (${Math.round(job.durationMs / 1000)}s)` : "";
    if (job.failedStep) {
      return [
        {
          label: `${RED}✗ ${job.id}${degradedTag} ${DIM}${job.runnerId}${RESET}${dur}`,
          children: degradedNode,
        },
      ];
    }
    return [
      {
        label: `✓ ${job.id}${degradedTag} ${DIM}${job.runnerId}${RESET}${dur}`,
        children: degradedNode,
      },
    ];
  }

  // ── Build step nodes ───────────────────────────────────────────────────────
  const padW = String(job.steps.length).length;
  const stepNodes = job.steps.map((step) => buildStepNode(step, job, padW));

  // Retry hint in multi-job paused mode (shown as a child node)
  if (!singleJobMode && job.status === "paused" && job.pausedAtStep) {
    stepNodes.push({
      label: `${YELLOW}↻ retry: local-ci retry --runner ${job.runnerId}${RESET}`,
    });
  }

  // ── Single-job mode: show "Starting runner" alongside job node ─────────────
  if (singleJobMode) {
    const bootLabel =
      job.bootDurationMs !== undefined
        ? `Starting runner ${job.runnerId} (${fmtMs(job.bootDurationMs)})`
        : `Starting runner ${job.runnerId}`;
    const bootNode: TreeNode = { label: bootLabel };
    if (job.logDir) {
      bootNode.children = [{ label: `${DIM}Logs: ${job.logDir}${RESET}` }];
    }
    return [
      bootNode,
      { label: `${job.id}${degradedTag}`, children: [...degradedNode, ...stepNodes] },
    ];
  }

  // ── Multi-job mode: show job name with steps as children ──────────────────
  return [
    {
      label: `${job.id}${degradedTag} ${DIM}${job.runnerId}${RESET}`,
      children: [...degradedNode, ...stepNodes],
    },
  ];
}

// ─── Running step hint (multi-workflow mode) ─────────────────────────────────

/**
 * Build a compact one-line hint for a single job's current status.
 * Used in multi-workflow mode to show each job with its active step.
 */
function getJobStepHint(job: JobState): string {
  if (job.status === "booting") {
    return ` ${DIM}— booting${RESET}`;
  }
  const runningStep = job.steps.find((s) => s.status === "running");
  if (runningStep) {
    const elapsed = runningStep.startedAt
      ? Math.round((Date.now() - new Date(runningStep.startedAt).getTime()) / 1000)
      : 0;
    return ` ${DIM}— step ${runningStep.index}/${job.steps.length} "${runningStep.name}" (${elapsed}s...)${RESET}`;
  }
  return "";
}

/**
 * Build a compact TreeNode for a job in multi-workflow mode.
 * Each job is one line: icon + name + step hint or duration.
 */
function buildCompactJobNode(job: JobState): TreeNode {
  const dur = job.durationMs !== undefined ? ` (${Math.round(job.durationMs / 1000)}s)` : "";
  const degradedTag = job.classification === "degraded" ? " [degraded]" : "";
  // Append matrix values to distinguish matrix-expanded jobs
  const matrix =
    job.matrixValues && Object.keys(job.matrixValues).length > 0
      ? ` ${DIM}(${Object.values(job.matrixValues).join(", ")})${RESET}`
      : "";
  switch (job.status) {
    case "completed":
      return { label: `✓ ${job.id}${degradedTag}${matrix}${dur}` };
    case "failed":
      return { label: `${RED}✗ ${job.id}${degradedTag}${RESET}${matrix}${dur}` };
    case "booting":
    case "running":
      return {
        label: `${getSpinnerFrame()} ${job.id}${degradedTag}${matrix}${getJobStepHint(job)}`,
      };
    case "queued":
    default:
      return { label: `○ ${job.id}${degradedTag}${matrix}` };
  }
}

// ─── Main renderer ────────────────────────────────────────────────────────────

/**
 * Render the full run state into a string for display via logUpdate.
 *
 * This is a pure function: given the same RunState and the same wall-clock time
 * it always produces the same output. Spinner frames are derived from Date.now().
 */
export function renderRunState(state: RunState): string {
  const totalJobs = state.workflows.reduce((sum, wf) => sum + wf.jobs.length, 0);
  const singleJobMode = state.workflows.length === 1 && totalJobs === 1;
  const multiWorkflowMode = state.workflows.length > 1;

  const roots: TreeNode[] = [];
  let pausedJob: JobState | undefined;

  // Sort workflows alphabetically in multi-workflow mode for stable output
  const workflows = multiWorkflowMode
    ? [...state.workflows].sort((a, b) =>
        path.basename(a.path).localeCompare(path.basename(b.path)),
      )
    : state.workflows;

  for (const wf of workflows) {
    const wfName = path.basename(wf.path);
    const hasPausedJob = wf.jobs.some((j) => j.status === "paused");

    // ── Multi-workflow: compact GitHub Checks style ──────────────────────
    if (multiWorkflowMode) {
      // Paused workflows expand with full step detail for retry hints
      if (hasPausedJob) {
        const children: TreeNode[] = [];
        for (const job of wf.jobs) {
          children.push(...buildJobNodes(job, singleJobMode));
          if (job.status === "paused" && !pausedJob) {
            pausedJob = job;
          }
        }
        roots.push({ label: `${getSpinnerFrame()} ${wfName}`, children });
        continue;
      }

      // Build the workflow label (icon + name + optional duration)
      let wfLabel: string;
      if (wf.status === "completed" || wf.status === "failed") {
        const durationMs =
          wf.startedAt && wf.completedAt
            ? new Date(wf.completedAt).getTime() - new Date(wf.startedAt).getTime()
            : undefined;
        const dur = durationMs !== undefined ? ` (${fmtDuration(durationMs)})` : "";
        if (wf.status === "failed") {
          wfLabel = `${RED}✗ ${wfName}${RESET}${dur}`;
        } else {
          wfLabel = `✓ ${wfName}${dur}`;
        }
      } else if (wf.status === "running") {
        wfLabel = `${getSpinnerFrame()} ${wfName}`;
      } else {
        wfLabel = `○ ${wfName}`;
      }

      // Always show job children so they're visible from the start
      // and never disappear (queued, running, completed, or failed).
      if (wf.jobs.length > 1) {
        const children = wf.jobs.map((job) => buildCompactJobNode(job));
        roots.push({ label: wfLabel, children });
      } else if (wf.jobs.length === 1) {
        // Single-job: append step hint inline
        roots.push({ label: `${wfLabel}${getJobStepHint(wf.jobs[0])}` });
      } else {
        roots.push({ label: wfLabel });
      }
      continue;
    }

    // ── Single-workflow mode: full expansion with job/step detail ──────────
    const children: TreeNode[] = [];
    for (const job of wf.jobs) {
      children.push(...buildJobNodes(job, singleJobMode));

      // Capture the first paused job for trailing output
      if (job.status === "paused" && !pausedJob) {
        pausedJob = job;
      }
    }

    roots.push({ label: wfName, children });
  }

  let output = renderTree(roots);

  // ── Paused job: append last output + retry/abort hints below tree ──────────
  if (pausedJob) {
    const { lastOutputLines, runnerId } = pausedJob;
    if (lastOutputLines && lastOutputLines.length > 0) {
      output += `\n\n  ${DIM}Last output:${RESET}`;
      for (const line of lastOutputLines) {
        const trimmed = line.trimEnd();
        if (trimmed) {
          output += `\n    ${DIM}${trimmed}${RESET}`;
        }
      }
    }
    output += `\n\n  ${YELLOW}↻ To retry:  local-ci retry --runner ${runnerId} [enter]${RESET}`;
    output += `\n  ${YELLOW}■ To abort:  local-ci abort --runner ${runnerId}${RESET}`;
  }

  return output;
}
