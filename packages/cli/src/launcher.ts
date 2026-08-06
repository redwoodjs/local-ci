// ─── Detached-worker launcher ─────────────────────────────────────────────────
//
// Wraps a non-TTY `--pause-on-failure` invocation as a launcher around a
// detached worker child. The launcher proxies the worker's combined output to
// its own stdout and exits 77 the moment the worker emits a `run.paused`
// event — at which point the worker is disowned and keeps running in the
// background, holding the container + DTU + signals dir alive so a sibling
// `local-ci retry --name X` can resume it.
//
// `local-ci retry` reuses the same tail loop: it writes the retry signal,
// then tails the worker's log so a re-failure surfaces as another exit-77 in
// the retrying shell. Successful completion exits 0; failed completion exits
// 1; both are signaled by a `run.completed` event the worker emits at the
// very end. See issue #315.
//
// Event format: NDJSON. Each event is one JSON object per line with an
// `event` discriminator field (e.g. `{"event":"run.paused", ...}`). Non-JSON
// lines pass through as regular log output.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "./run-result-writer.ts";

export const PAUSED_EXIT_CODE = 77;
/** Set by the launcher on the worker child. Presence = detached; value = worker log path. */
export const DETACHED_ENV = "LOCAL_CI_DETACHED";

/** Filename written under each run dir so `retry` can locate the worker by runner name. */
export const DETACHED_MARKER_FILENAME = "detached.json";

/**
 * Event-stream schema version. Bump when an event shape changes
 * incompatibly. Consumers receive this on `run.start` and can version-gate.
 */
export const EVENT_SCHEMA_VERSION = 1;

export interface RunStartEvent {
  event: "run.start";
  ts: string;
  schemaVersion: number;
  runId: string;
  repo?: string;
  branch?: string;
}

export interface RunFinishEvent {
  event: "run.finish";
  ts?: string;
  status: "passed" | "failed";
  durationMs?: number;
}

export interface RunPausedEvent {
  event: "run.paused";
  ts?: string;
  runner: string;
  step?: string;
  attempt?: number;
  workflow?: string;
  retry_cmd: string;
}

export interface JobStartEvent {
  event: "job.start";
  ts: string;
  job: string;
  runner: string;
  workflow?: string;
}

export interface JobFinishEvent {
  event: "job.finish";
  ts: string;
  job: string;
  runner: string;
  workflow?: string;
  status: "passed" | "failed";
  durationMs?: number;
}

export interface StepStartEvent {
  event: "step.start";
  ts: string;
  job: string;
  runner: string;
  step: string;
  index: number;
}

export interface StepFinishEvent {
  event: "step.finish";
  ts: string;
  job: string;
  runner: string;
  step: string;
  index: number;
  status: "passed" | "failed" | "skipped";
  durationMs?: number;
}

export interface DiagnosticEvent {
  event: "diagnostic";
  ts: string;
  level: "info" | "warning" | "error";
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

export type LogEvent =
  | RunStartEvent
  | RunFinishEvent
  | RunPausedEvent
  | JobStartEvent
  | JobFinishEvent
  | StepStartEvent
  | StepFinishEvent
  | DiagnosticEvent;

const KNOWN_EVENTS = new Set<string>([
  "run.start",
  "run.finish",
  "run.paused",
  "job.start",
  "job.finish",
  "step.start",
  "step.finish",
  "diagnostic",
]);

export interface DetachedMarker {
  workerLogPath: string;
  workerPid: number;
}

/**
 * Format a single NDJSON event line. Each emitted event must include an
 * `event` discriminator so the tailer can distinguish it from incidental
 * JSON in normal log output.
 */
export function formatEvent(event: LogEvent): string {
  return JSON.stringify(event);
}

/**
 * Parse `line` as an NDJSON log event. Returns null if the line isn't valid
 * JSON or isn't a known event — both treated as regular log output. Only
 * objects with `event` matching one of our known names are recognized; any
 * other JSON (e.g. a user step that happens to print `{"foo":1}`) passes
 * through unchanged.
 */
export function parseLogEvent(line: string): LogEvent | null {
  // Cheap reject: every event is `{"event":"..."}` so it must start with `{`.
  if (line.length === 0 || line.charCodeAt(0) !== 0x7b /* { */) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const ev = (parsed as { event?: unknown }).event;
  if (typeof ev !== "string" || !KNOWN_EVENTS.has(ev)) {
    return null;
  }
  return parsed as LogEvent;
}

/**
 * `LOCAL_CI_DETACHED` has two roles distinguished by value:
 *   - `=1` (or any non-absolute value) → caller-side opt-in: force the
 *     detached launcher even when stdout is a TTY. Useful for testing.
 *   - `=<absolute path>` → set by the launcher on the worker child; the value
 *     is the worker's own log file path. Marks "I am the worker."
 */
export function isDetachedWorker(): boolean {
  const v = process.env[DETACHED_ENV];
  return v !== undefined && v.startsWith("/");
}

/**
 * Whether the caller asked us to force-launch the detached launcher (even on
 * a TTY). Caller-side opt-in only — the worker child sees an absolute path
 * here, not the `1` sentinel.
 */
export function isForceDetachedRequested(): boolean {
  const v = process.env[DETACHED_ENV];
  return v !== undefined && !v.startsWith("/");
}

/** The worker's own log path, as set by the launcher, or null if not detached. */
export function getDetachedWorkerLogPath(): string | null {
  const v = process.env[DETACHED_ENV];
  return v !== undefined && v.startsWith("/") ? v : null;
}

/**
 * Decide whether to run via the detached launcher.
 *
 * The pause-on-failure CLI is artificially tethered to the container while
 * paused — fine in a TTY (the user reads the message), broken in a pipe
 * (output buffered until EOF, which never comes). The launcher pattern only
 * kicks in when:
 *
 *  - `--pause-on-failure` is set (otherwise pause never happens), AND
 *  - stdout isn't a TTY (a pipe / redirect / bash run_in_background), AND
 *  - we're NOT in agent mode.
 *
 * The agent-mode bypass is deliberate: an LLM harness running with `-q` tails
 * the live output file and expects the CLI to keep streaming across retry. If
 * we exited 77 there, the post-retry output would land in the worker's own
 * log file, not the harness's pipe — breaking the monitor. Plain non-TTY
 * callers (the issue's actual target) have no monitor and need us to exit.
 *
 * Override: `LOCAL_CI_DETACHED=1` forces the launcher path even on a TTY,
 * for manual verification of the pause-then-exit flow.
 */
export function shouldLaunchDetached(opts: {
  pauseOnFailure: boolean;
  stdoutIsTTY: boolean;
  agentMode: boolean;
  alreadyWorker: boolean;
  forceDetached?: boolean;
}): boolean {
  if (opts.alreadyWorker) {
    return false;
  }
  if (!opts.pauseOnFailure) {
    return false;
  }
  if (opts.agentMode) {
    return false;
  }
  if (opts.forceDetached) {
    return true;
  }
  return !opts.stdoutIsTTY;
}

interface LaunchResult {
  exitCode: number;
}

/**
 * Drop the detached marker into a run dir so `retry --name X` can locate the
 * worker. Called from `local-job.ts` once per run dir. No-op when the worker
 * isn't running detached or the launcher didn't set the log-path env var.
 */
export function writeDetachedMarker(runDir: string): void {
  const workerLogPath = getDetachedWorkerLogPath();
  if (!workerLogPath) {
    return;
  }
  try {
    fs.writeFileSync(
      path.join(runDir, DETACHED_MARKER_FILENAME),
      JSON.stringify({ workerLogPath, workerPid: process.pid }),
    );
  } catch {
    // Best-effort: a missing marker only degrades retry's tail behavior.
  }
}

/** Read a run dir's detached marker, or null if it isn't a detached run. */
export function readDetachedMarker(runDir: string): DetachedMarker | null {
  try {
    const raw = fs.readFileSync(path.join(runDir, DETACHED_MARKER_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as DetachedMarker;
    if (typeof parsed.workerLogPath === "string" && typeof parsed.workerPid === "number") {
      return parsed;
    }
  } catch {}
  return null;
}

/**
 * Spawn the worker, proxy its output, and either:
 *   - exit 77 the instant we see the pause sentinel, or
 *   - exit with the worker's own code if it finishes before any pause.
 *
 * The worker's stdio is bound to a log file so it survives the launcher
 * exiting (no EPIPE on later writes). We tail the file by polling.
 */
export async function runDetachedLauncher(args: string[]): Promise<LaunchResult> {
  const stateDir = resolveStateDir();
  const launcherDir = path.join(stateDir, "launchers");
  fs.mkdirSync(launcherDir, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}`;
  const logPath = path.join(launcherDir, `worker-${stamp}.log`);
  fs.writeFileSync(logPath, "");

  // Forward execArgv so the worker keeps the same loader (e.g. `--import
  // tsx/esm` when invoked via `pnpm local-ci-dev`). Without this, the worker
  // would be `node cli.ts`, which Node can't resolve without the TS loader.
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, [DETACHED_ENV]: logPath },
  });
  fs.closeSync(logFd);

  let workerExited = false;
  let workerExitCode: number | null = null;
  child.on("exit", (code, signal) => {
    workerExited = true;
    workerExitCode = code ?? (signal ? 128 : 1);
  });
  child.on("error", () => {
    workerExited = true;
    workerExitCode = 1;
  });

  return await tailLog({
    logPath,
    startOffset: 0,
    isAlive: () => !workerExited,
    onPaused: (e, line) => {
      process.stdout.write(line + "\n");
      writePauseHint(e, logPath);
      try {
        child.unref();
      } catch {}
      return { exitCode: PAUSED_EXIT_CODE };
    },
    onFinish: (e, line) => {
      process.stdout.write(line + "\n");
      return { exitCode: e.status === "passed" ? 0 : 1 };
    },
    onDeath: () => ({ exitCode: workerExitCode ?? 1 }),
  });
}

/**
 * Re-tail the worker's log from the current end-of-file. Used by `retry`
 * after the signal file is written so a re-failure surfaces as another
 * exit-77 in the retrying shell instead of the user having to hunt for the
 * live log.
 */
export async function tailRetryUntilOutcome(
  marker: DetachedMarker,
  startOffset: number,
): Promise<LaunchResult> {
  return await tailLog({
    logPath: marker.workerLogPath,
    startOffset,
    isAlive: () => isPidAlive(marker.workerPid),
    onPaused: (e, line) => {
      process.stdout.write(line + "\n");
      writePauseHint(e, marker.workerLogPath);
      return { exitCode: PAUSED_EXIT_CODE };
    },
    onFinish: (e, line) => {
      process.stdout.write(line + "\n");
      return { exitCode: e.status === "passed" ? 0 : 1 };
    },
    // Worker pid gone without emitting a `run.finish` event. Treat as a crash.
    onDeath: () => ({ exitCode: 1 }),
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePauseHint(e: RunPausedEvent, logPath: string): void {
  process.stdout.write(
    `[Local CI] Job paused. Worker continues in background.\n` +
      `           Resume with: ${e.retry_cmd}\n` +
      `           Or abort with: local-ci abort --name ${e.runner}\n` +
      `           Live log: ${logPath}\n`,
  );
}

interface TailOpts {
  logPath: string;
  startOffset: number;
  isAlive: () => boolean;
  onPaused: (e: RunPausedEvent, line: string) => LaunchResult;
  onFinish: (e: RunFinishEvent, line: string) => LaunchResult;
  onDeath: () => LaunchResult;
}

/**
 * Poll-and-print loop. Reads new bytes from `logPath` starting at
 * `startOffset`, prints each complete line to this process's stdout, and
 * dispatches the first sentinel we see. When `isAlive` flips false we drain
 * one more time to flush any final writes, then call `onDeath`.
 */
async function tailLog(opts: TailOpts): Promise<LaunchResult> {
  let offset = opts.startOffset;
  let buffer = "";
  const POLL_MS = 100;
  let drainedAfterDeath = false;

  while (true) {
    let nextOffset = offset;
    try {
      const stat = fs.statSync(opts.logPath);
      if (stat.size > offset) {
        const fd = fs.openSync(opts.logPath, "r");
        try {
          const len = stat.size - offset;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, offset);
          nextOffset = stat.size;
          buffer += buf.toString("utf-8");
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      // file may not exist yet on the very first tick — keep polling
    }
    offset = nextOffset;

    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const event = parseLogEvent(line);
      if (event?.event === "run.paused") {
        return opts.onPaused(event, line);
      }
      if (event?.event === "run.finish") {
        return opts.onFinish(event, line);
      }
      // Suppress other recognized events — they're consumed in agent mode but
      // shouldn't appear as raw JSON in the human caller's stdout.
      if (event !== null) {
        continue;
      }
      process.stdout.write(line + "\n");
    }

    if (!opts.isAlive()) {
      if (drainedAfterDeath) {
        if (buffer.length > 0) {
          process.stdout.write(buffer);
        }
        return opts.onDeath();
      }
      // One more poll cycle to flush any buffered final writes.
      drainedAfterDeath = true;
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
