import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getWorkingDirectory, LEGACY_WORKING_DIR } from "../output/working-directory.ts";
import { syncWorkspaceForRetry } from "../runner/sync.ts";
import { readDetachedMarker, tailRetryUntilOutcome } from "../launcher.ts";

function findSignalsDir(runnerName: string): string | null {
  const workDirs = [getWorkingDirectory(), LEGACY_WORKING_DIR];
  for (const workDir of new Set(workDirs)) {
    const runsDir = path.resolve(workDir, "runs");
    if (!fs.existsSync(runsDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(runsDir)) {
      if (entry === runnerName || entry.endsWith(runnerName)) {
        const signalsDir = path.join(runsDir, entry, "signals");
        if (fs.existsSync(signalsDir)) {
          return signalsDir;
        }
      }
    }
  }
  return null;
}

export default async function retryAbort(
  command: "retry" | "abort",
  args: string[],
): Promise<never> {
  let runnerName: string | undefined;
  let fromStep: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if ((args[i] === "--name" || args[i] === "-n" || args[i] === "--runner") && args[i + 1]) {
      runnerName = args[i + 1];
      i++;
    } else if (args[i] === "--from-step" && args[i + 1]) {
      fromStep = args[i + 1];
      i++;
    } else if (args[i] === "--from-start") {
      fromStep = "*";
    }
  }
  if (!runnerName) {
    console.error(`[Local CI] Error: --name <name> is required for '${command}'`);
    process.exit(1);
  }
  if (fromStep && fromStep !== "*" && (isNaN(Number(fromStep)) || Number(fromStep) < 1)) {
    console.error(`[Local CI] Error: --from-step must be a positive step number`);
    process.exit(1);
  }
  const signalsDir = findSignalsDir(runnerName);
  if (!signalsDir) {
    console.error(`[Local CI] Error: No runner '${runnerName}' found. It may have already exited.`);
    process.exit(1);
  }
  const pausedFile = path.join(signalsDir, "paused");
  if (!fs.existsSync(pausedFile)) {
    fs.rmSync(signalsDir, { recursive: true, force: true });
    console.error(
      `[Local CI] Error: Runner '${runnerName}' is not currently paused. It may have already exited.`,
    );
    process.exit(1);
  }
  try {
    const status = execSync(`docker inspect -f '{{.State.Running}}' ${runnerName} 2>/dev/null`, {
      encoding: "utf-8",
    }).trim();
    if (status !== "true") {
      throw new Error("not running");
    }
  } catch {
    fs.rmSync(signalsDir, { recursive: true, force: true });
    console.error(`[Local CI] Error: Runner '${runnerName}' is no longer running.`);
    process.exit(1);
  }
  if (command === "retry") {
    const runDir = path.dirname(signalsDir);
    syncWorkspaceForRetry(runDir);
    if (fromStep) {
      fs.writeFileSync(path.join(signalsDir, "from-step"), fromStep);
    }
  }
  // ── Detached-worker tail (issue #315) ───────────────────────────────────
  // If the original run was launched via the detached launcher, tail the
  // worker's log starting at the current end-of-file so that a re-failure
  // surfaces as another exit-77 in the retrying shell — matching the
  // launcher's behavior on the initial pause. Snapshot the offset BEFORE
  // writing the signal file so we don't miss a paused/completed sentinel
  // that the worker emits between the signal write and our first poll.
  const runDir = path.dirname(signalsDir);
  const marker = command === "retry" ? readDetachedMarker(runDir) : null;
  let tailStartOffset = 0;
  if (marker) {
    try {
      tailStartOffset = fs.statSync(marker.workerLogPath).size;
    } catch {
      // log missing — fall back to no tail
    }
  }
  fs.writeFileSync(path.join(signalsDir, command), "");
  const extra = fromStep ? ` (from step ${fromStep === "*" ? "1" : fromStep})` : "";
  console.log(`[Local CI] Sent '${command}' signal to ${runnerName}${extra}`);
  if (marker && command === "retry") {
    const result = await tailRetryUntilOutcome(marker, tailStartOffset);
    process.exit(result.exitCode);
  }
  process.exit(0);
}
