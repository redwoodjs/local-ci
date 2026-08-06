import path from "path";
import fs from "fs";
import { getWorkingDirectory } from "./working-directory.ts";
import { getLogsDirectory } from "./logs-directory.ts";

/** Root of all run directories: `<workingDir>/runs/` */
function getRunsDir(): string {
  return path.join(getWorkingDirectory(), "runs");
}

export function ensureLogDirs(): void {
  fs.mkdirSync(getRunsDir(), { recursive: true });
}

function runNumberFromDirName(prefix: string, name: string): number | null {
  if (!name.startsWith(`${prefix}-`)) {
    return null;
  }

  // Extract the trailing numeric run counter from a name like:
  //   local-ci-redwoodjssdk-14        → 14
  //   local-ci-redwoodjssdk-15-j1     → 15
  //   local-ci-redwoodjssdk-15-j1-m2  → 15
  // Strategy: strip any -j<N>, -m<N>, -r<N> suffixes first, then grab the last number.
  const baseName = name
    .replace(/-j\d+(-m\d+)?(-r\d+)?$/, "")
    .replace(/-m\d+(-r\d+)?$/, "")
    .replace(/-r\d+$/, "");
  const match = baseName.match(/-(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

function collectRunNums(dir: string, prefix: string): number[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => runNumberFromDirName(prefix, item.name))
    .filter((num): num is number => num !== null);
}

export function getNextLogNum(prefix: string): number {
  const nums = [
    ...collectRunNums(getRunsDir(), prefix),
    // Stable log dirs outlive temporary run dirs. Count them too so a pruned
    // `<workDir>/runs/local-ci-N-*` cannot be reused while
    // `<logsDir>/local-ci-N-*/timeline.json` still exists. Otherwise the DTU
    // appends the new run's timeline to stale records and the result builder can
    // replay an old failure as the current run's outcome. See issue #341.
    ...collectRunNums(getLogsDirectory(), prefix),
  ];

  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

/**
 * Atomically allocate a numbered run directory under `runs/`.
 * Uses mkdirSync without `recursive` so that EEXIST signals a
 * collision — the caller just increments and retries.
 */
function allocateRunDir(prefix: string): { num: number; name: string; runDir: string } {
  const runsDir = getRunsDir();
  let num = getNextLogNum(prefix);

  for (;;) {
    const name = `${prefix}-${num}`;
    const runDir = path.join(runsDir, name);
    try {
      fs.mkdirSync(runDir); // atomic — fails with EEXIST on collision
      return { num, name, runDir };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        num++;
        continue;
      }
      throw err;
    }
  }
}

function resetPerRunLogArtifacts(logDir: string): void {
  // A stable log dir may outlive the temporary run dir. If a runner name is
  // ever reused, stale timeline/output/step files must not be visible to the
  // new run. Debug/output logs are opened with truncating streams elsewhere,
  // but remove them here too so the directory is clean from the start.
  for (const entry of [
    "timeline.json",
    "outputs.json",
    "metadata.json",
    "output.log",
    "debug.log",
  ]) {
    fs.rmSync(path.join(logDir, entry), { force: true });
  }
  fs.rmSync(path.join(logDir, "steps"), { recursive: true, force: true });
}

export function createLogContext(prefix: string, preferredName?: string) {
  ensureLogDirs();

  let num: number;
  let name: string;
  let runDir: string;

  if (preferredName) {
    num = 0;
    name = preferredName;
    runDir = path.join(getRunsDir(), name);
    fs.mkdirSync(runDir, { recursive: true });
  } else {
    ({ num, name, runDir } = allocateRunDir(prefix));
  }

  // Run logs live under a stable, local-ci-owned directory (default `<stateDir>/logs/`),
  // not next to the runner's working dir which lands in `os.tmpdir()` and gets pruned
  // by the OS. Keeps log paths in run-result JSON resolvable after the OS cleans tmp.
  // See issue #312.
  const logDir = path.join(getLogsDirectory(), name);
  fs.mkdirSync(logDir, { recursive: true });
  resetPerRunLogArtifacts(logDir);

  return {
    num,
    name,
    runDir,
    logDir,
    outputLogPath: path.join(logDir, "output.log"),
    debugLogPath: path.join(logDir, "debug.log"),
  };
}

export function finalizeLog(
  logPath: string,
  _exitCode: number,
  _commitSha?: string,
  _preferredName?: string,
): string {
  // Log file stays in place; just return the path as-is.
  return logPath;
}
