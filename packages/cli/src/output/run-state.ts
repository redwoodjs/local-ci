import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import type { ResourceFidelity } from "../workflow/resource-classifier.ts";

// ─── Status types ─────────────────────────────────────────────────────────────

export type RunStatus = "running" | "completed" | "failed";
export type WorkflowStatus = "queued" | "running" | "completed" | "failed";
export type JobStatus = "queued" | "booting" | "running" | "completed" | "failed" | "paused";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "paused";

// ─── State interfaces ─────────────────────────────────────────────────────────

export interface StepState {
  name: string;
  /** 1-based display index */
  index: number;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface JobState {
  /** Task name, e.g. "test", "lint" */
  id: string;
  /** Container name, e.g. "local-ci-5-j1" */
  runnerId: string;
  status: JobStatus;
  startedAt?: string;
  completedAt?: string;
  /** Total job wall-clock duration in ms */
  durationMs?: number;
  /** Time from container start to first timeline entry */
  bootDurationMs?: number;
  matrixValues?: Record<string, string>;
  /** Dependency wave index */
  wave?: number;
  steps: StepState[];
  failedStep?: string;
  failedExitCode?: number;
  /** Last N output lines of the failed step (shown when paused) */
  lastOutputLines?: string[];
  /** Step name that triggered the current pause */
  pausedAtStep?: string;
  /** ISO timestamp when the pause was detected (for frozen elapsed timer) */
  pausedAtMs?: string;
  /** Current retry attempt number */
  attempt?: number;
  debugLogPath?: string;
  logDir?: string;
  /** Docker image pull progress (bytes downloaded / total) */
  pullProgress?: {
    phase: "downloading" | "extracting";
    currentBytes: number;
    totalBytes: number;
  };
  classification?: ResourceFidelity;
  classificationSummary?: string;
  classificationReasons?: string[];
}

export interface WorkflowState {
  /** Filename, e.g. "ci.yml" */
  id: string;
  /** Absolute path to workflow file */
  path: string;
  status: WorkflowStatus;
  startedAt?: string;
  completedAt?: string;
  jobs: JobState[];
}

export interface RunState {
  runId: string;
  status: RunStatus;
  /** ISO 8601 */
  startedAt: string;
  completedAt?: string;
  workflows: WorkflowState[];
}

// ─── RunStateStore ────────────────────────────────────────────────────────────

/**
 * Single source of truth for a run's progress.
 *
 * - Execution engine (local-job.ts) calls `addJob` / `updateJob` to write progress.
 * - Renderer (state-renderer.ts) reads `getState()` to produce terminal output.
 * - State is persisted atomically to disk (write-tmp + rename) for inspection / resumability.
 */
export type StoreListener = (state: RunState) => void;

export class RunStateStore {
  private state: RunState;
  private filePath: string;
  private listeners: StoreListener[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDirty = false;

  constructor(runId: string, filePath: string) {
    this.state = {
      runId,
      status: "running",
      startedAt: new Date().toISOString(),
      workflows: [],
    };
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  /** Register a callback that fires synchronously on every state change. */
  onUpdate(listener: StoreListener): void {
    this.listeners.push(listener);
  }

  getState(): RunState {
    return this.state;
  }

  /**
   * Pre-register a workflow so it appears in the render loop immediately
   * (e.g. as "queued") before any jobs have been added.
   */
  addWorkflow(workflowPath: string): void {
    if (!this.state.workflows.some((w) => w.path === workflowPath)) {
      this.state.workflows.push({
        id: path.basename(workflowPath),
        path: workflowPath,
        status: "queued",
        jobs: [],
      });
      this.notify();
    }
  }

  /**
   * Register a job under a workflow (creating the workflow entry if needed).
   * Call this before executing the job so the render loop can show it immediately.
   */
  addJob(
    workflowPath: string,
    jobId: string,
    runnerId: string,
    options?: {
      matrixValues?: Record<string, string>;
      wave?: number;
      logDir?: string;
      debugLogPath?: string;
      classification?: ResourceFidelity;
      classificationSummary?: string;
      classificationReasons?: string[];
    },
  ): void {
    let wf = this.state.workflows.find((w) => w.path === workflowPath);
    if (!wf) {
      wf = {
        id: path.basename(workflowPath),
        path: workflowPath,
        status: "queued",
        jobs: [],
      };
      this.state.workflows.push(wf);
    }

    const existingJob = wf.jobs.find((j) => j.runnerId === runnerId);

    if (existingJob) {
      Object.assign(existingJob, options);
    } else {
      wf.jobs.push({
        id: jobId,
        runnerId,
        status: "queued",
        steps: [],
        ...options,
      });
    }
    this.notify();
  }

  /**
   * Update fields on a job (matched by runnerId).
   * Automatically syncs parent workflow status and saves to disk.
   */
  updateJob(runnerId: string, updates: Partial<JobState>): void {
    for (const wf of this.state.workflows) {
      const job = wf.jobs.find((j) => j.runnerId === runnerId);
      if (job) {
        Object.assign(job, updates);
        this.syncWorkflowStatus(wf);
        break;
      }
    }
    this.debouncedSave();
    this.notify();
  }

  /** Mark the overall run complete and persist immediately. */
  complete(status: RunStatus): void {
    this.state.status = status;
    this.state.completedAt = new Date().toISOString();
    // Flush any pending debounced save, then write final state
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  /**
   * Debounced save — coalesces rapid state updates into a single disk write.
   * The in-memory state is always current; only the disk persistence is batched
   * to avoid blocking the event loop (and stalling the render interval).
   */
  private debouncedSave(): void {
    this.saveDirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        if (this.saveDirty) {
          this.saveDirty = false;
          this.save();
        }
      }, 200);
    }
  }

  /**
   * Atomically write state to disk (async, non-blocking).
   * Uses write-tmp-then-rename to prevent corruption on concurrent reads.
   */
  save(): Promise<void> {
    const tmp = this.filePath + ".tmp";
    const data = JSON.stringify(this.state, null, 2);
    return fsp
      .writeFile(tmp, data)
      .then(() => fsp.rename(tmp, this.filePath))
      .catch(() => {
        // Best-effort — rendering uses in-memory state, not disk
      });
  }

  /** Load a previously-written RunState from disk. */
  static load(filePath: string): RunState {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as RunState;
    } catch {
      return JSON.parse(fs.readFileSync(filePath + ".tmp", "utf-8")) as RunState;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // Best-effort — don't let listener errors break state updates
      }
    }
  }

  private syncWorkflowStatus(wf: WorkflowState): void {
    const statuses = wf.jobs.map((j) => j.status);
    if (statuses.length === 0) {
      return;
    }

    if (statuses.every((s) => s === "completed")) {
      wf.status = "completed";
      if (!wf.completedAt) {
        wf.completedAt = new Date().toISOString();
      }
    } else if (statuses.some((s) => s === "failed")) {
      wf.status = "failed";
    } else if (statuses.some((s) => s === "running" || s === "booting" || s === "paused")) {
      wf.status = "running";
      if (!wf.startedAt) {
        wf.startedAt = new Date().toISOString();
      }
    }
  }
}
