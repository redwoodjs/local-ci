/**
 * Background Shell extension for pi
 *
 * Adds two tools the LLM can use to run long-lived commands without blocking
 * a single tool call from start to finish:
 *
 *   - bash_background: spawn a shell command in the background; returns
 *                      `taskId`, `outputFile`, and `pid` immediately.
 *                      stdout+stderr are tee'd to the log file.
 *
 *   - monitor_wait:    block until a regex matches new output from a task's
 *                      log, OR the task exits, OR timeoutMs elapses. Keeps
 *                      per-task byte offsets so repeated calls resume where
 *                      the previous one left off.
 *
 * Designed for workflows like the `local-ci-dev` skill where the LLM needs
 * to react live to a long-running subprocess (CI, builds, servers) without
 * relying on tools that only exist in specific agent runtimes (e.g. Claude
 * Code's `run_in_background` / `Monitor`).
 *
 * No npm dependencies at runtime — only Node built-ins. `ExtensionAPI` is
 * imported as a type (erased by jiti), and parameter schemas are written as
 * plain JSON Schema, so this file runs as-is in any pi install.
 *
 * Install:
 *   - Project-local: `.pi/extensions/background-shell.ts` (this file).
 *   - Global:        `~/.pi/agent/extensions/background-shell.ts`.
 *
 * pi auto-discovers both locations; no manifest or `npm install` required.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type TaskState = "running" | "succeeded" | "failed";

interface Task {
  taskId: string;
  command: string;
  cwd: string;
  pid: number;
  outputFile: string;
  child: ChildProcess;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  startedAt: number;
  endedAt: number | null;
}

const tasks = new Map<string, Task>();
const taskOffsets = new Map<string, number>();

function taskState(task: Task): TaskState {
  if (task.endedAt === null) {
    return "running";
  }
  return task.exitCode === 0 && task.exitSignal === null ? "succeeded" : "failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readNewBytes(path: string, from: number): { chunk: string; newOffset: number } {
  if (!existsSync(path)) {
    return { chunk: "", newOffset: from };
  }
  const size = statSync(path).size;
  if (size <= from) {
    return { chunk: "", newOffset: from };
  }

  const fd = openSync(path, "r");
  try {
    const length = size - from;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, from);
    return { chunk: buf.toString("utf8"), newOffset: size };
  } finally {
    closeSync(fd);
  }
}

// Plain JSON Schema, cast at the registration site. Avoids a runtime
// dep on @sinclair/typebox so the extension has zero npm imports.
const bashBackgroundSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to run (executed via `bash -lc`)." },
    cwd: { type: "string", description: "Working directory. Defaults to pi's cwd." },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

const monitorWaitSchema = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "taskId returned by bash_background." },
    pattern: {
      type: "string",
      description:
        "JavaScript regex (without delimiters) matched per-line against new output. " +
        "If omitted, the call returns only when the task exits or timeoutMs elapses.",
    },
    timeoutMs: {
      type: "number",
      description: "Max milliseconds to block. Default 60000 (1 minute).",
    },
    fromOffset: {
      type: "number",
      description:
        "Byte offset to resume scanning from. Defaults to where the previous monitor_wait " +
        "call on this taskId left off.",
    },
  },
  required: ["taskId"],
  additionalProperties: false,
} as const;

interface BashBackgroundParams {
  command: string;
  cwd?: string;
}

interface MonitorWaitParams {
  taskId: string;
  pattern?: string;
  timeoutMs?: number;
  fromOffset?: number;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bash_background",
    label: "Bash (background)",
    description:
      "Spawn a shell command in the background and return immediately. stdout+stderr are tee'd to a log file. " +
      "Use the returned `taskId` with `monitor_wait` to watch for output patterns or for the process to exit. " +
      "The command runs via `bash -lc`, inheriting pi's environment.",
    promptSnippet:
      "bash_background: start a long-running shell command; returns { taskId, outputFile, pid } without blocking.",
    parameters: bashBackgroundSchema as any,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as BashBackgroundParams;
      const cwd = params.cwd ?? ctx.cwd;
      const taskId = randomUUID();
      const logDir = mkdtempSync(join(tmpdir(), "pi-bg-"));
      const outputFile = join(logDir, "output.log");
      const sink = createWriteStream(outputFile, { flags: "a" });

      const child = spawn("bash", ["-lc", params.command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      child.stdout?.pipe(sink, { end: false });
      child.stderr?.pipe(sink, { end: false });

      const task: Task = {
        taskId,
        command: params.command,
        cwd,
        pid: child.pid ?? -1,
        outputFile,
        child,
        exitCode: null,
        exitSignal: null,
        startedAt: Date.now(),
        endedAt: null,
      };
      tasks.set(taskId, task);
      taskOffsets.set(taskId, 0);

      child.on("exit", (code, signal) => {
        task.exitCode = code;
        task.exitSignal = signal;
        task.endedAt = Date.now();
        sink.end();
      });

      const summary =
        `Started background task\n` +
        `  taskId:     ${taskId}\n` +
        `  pid:        ${task.pid}\n` +
        `  cwd:        ${cwd}\n` +
        `  outputFile: ${outputFile}\n` +
        `  command:    ${params.command}`;

      return {
        content: [{ type: "text", text: summary }],
        details: { taskId, pid: task.pid, cwd, outputFile, command: params.command },
      };
    },
  } as any);

  pi.registerTool({
    name: "monitor_wait",
    label: "Monitor wait",
    description:
      "Watch a `bash_background` task's output for a regex pattern, OR wait for the task to exit, whichever " +
      "happens first (or until timeoutMs elapses). Returns matching lines plus the current task state. Call " +
      "repeatedly in a loop to keep watching — each call resumes from the byte offset where the previous call " +
      "stopped, so you won't re-see matches you've already acted on. Always cover success AND failure signals: " +
      "for a long-running CI job, pass a pattern like `Step failed|Traceback|Error|FAILED` rather than the " +
      "happy-path marker alone, so a crash or hang doesn't look identical to still-running.",
    promptSnippet:
      "monitor_wait: block until a regex matches new output from a bash_background task, or the task exits.",
    parameters: monitorWaitSchema as any,
    async execute(_toolCallId, rawParams, signal, _onUpdate, _ctx) {
      const params = rawParams as MonitorWaitParams;
      const task = tasks.get(params.taskId);
      if (!task) {
        throw new Error(`Unknown taskId: ${params.taskId}`);
      }

      const pattern = params.pattern ? new RegExp(params.pattern) : null;
      const timeoutMs = Math.max(0, params.timeoutMs ?? 60000);
      const deadline = Date.now() + timeoutMs;

      let offset = params.fromOffset ?? taskOffsets.get(task.taskId) ?? 0;
      const matches: string[] = [];
      let carry = "";
      let stoppedBecause: "match" | "exit" | "timeout" | "aborted" = "timeout";

      while (Date.now() < deadline) {
        if (signal?.aborted) {
          stoppedBecause = "aborted";
          break;
        }

        const { chunk, newOffset } = readNewBytes(task.outputFile, offset);
        offset = newOffset;

        if (chunk.length > 0) {
          const lines = (carry + chunk).split("\n");
          carry = lines.pop() ?? "";
          for (const line of lines) {
            if (pattern && pattern.test(line)) {
              matches.push(line);
            }
          }
          if (matches.length > 0) {
            stoppedBecause = "match";
            break;
          }
        }

        if (task.endedAt !== null) {
          // flush any trailing partial line without a newline
          if (pattern && carry && pattern.test(carry)) {
            matches.push(carry);
          }
          stoppedBecause = "exit";
          break;
        }

        await sleep(250);
      }

      taskOffsets.set(task.taskId, offset);

      const state = taskState(task);
      const header =
        `taskId:  ${task.taskId}\n` +
        `state:   ${state}` +
        (task.endedAt !== null
          ? ` (exitCode=${task.exitCode}, signal=${task.exitSignal ?? "-"})`
          : "") +
        `\n` +
        `stopped: ${stoppedBecause}\n` +
        `offset:  ${offset}\n`;

      const body =
        matches.length > 0
          ? `${header}matches (${matches.length}):\n` + matches.map((m) => `  ${m}`).join("\n")
          : `${header}no new matches${task.endedAt === null ? "" : " before exit"}`;

      return {
        content: [{ type: "text", text: body }],
        details: {
          taskId: task.taskId,
          state,
          stoppedBecause,
          exitCode: task.exitCode,
          exitSignal: task.exitSignal,
          matches,
          offset,
        },
      };
    },
  } as any);
}
