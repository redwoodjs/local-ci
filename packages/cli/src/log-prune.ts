import fs from "node:fs";
import path from "node:path";
import { resolveLogsDir, resolveStateDir } from "./run-result-writer.ts";

/** Default: keep runs whose mtime is younger than this many days. */
const DEFAULT_RETAIN_DAYS = 7;
/** Default: keep at most this many runs after age-based filtering. */
const DEFAULT_RETAIN_RUNS = 20;
/** Default: don't run more than once per this many ms unless forced. */
const DEFAULT_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

export interface PruneOptions {
  logsDir?: string;
  stateDir?: string;
  retainDays?: number;
  retainRuns?: number;
  /** Bypass the throttle and the LOCAL_CI_LOG_PRUNE=0 disable. Used by `local-ci clean`. */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Override "now" for tests. */
  now?: () => number;
}

export interface PruneResult {
  skipped: boolean;
  reason?: "disabled" | "throttled" | "locked" | "missing" | "error";
  removed: string[];
  kept: number;
  protected: string[];
}

const LOCK_BASENAME = ".prune.lock";
const STAMP_BASENAME = ".prune.stamp";

/**
 * Prune old per-run log directories under `<logsDir>/`.
 *
 * Policy: never delete a run dir referenced by any branch's checks JSON
 * (those are "current" results consumers might still be reading), then
 * keep the newest `retainRuns` by mtime, then drop anything older than
 * `retainDays` days. Runs opportunistically on `local-ci run` startup.
 *
 * Never throws — a failed prune must not fail the run.
 */
export function pruneLogs(opts: PruneOptions = {}): PruneResult {
  const env = opts.env ?? process.env;
  const force = opts.force ?? false;

  if (!force && env.LOCAL_CI_LOG_PRUNE === "0") {
    return { skipped: true, reason: "disabled", removed: [], kept: 0, protected: [] };
  }

  const logsDir = opts.logsDir ?? resolveLogsDir(env as Parameters<typeof resolveLogsDir>[0]);
  const stateDir = opts.stateDir ?? resolveStateDir(env as Parameters<typeof resolveStateDir>[0]);
  const retainDays =
    opts.retainDays ?? readPositiveInt(env.LOCAL_CI_LOG_RETAIN_DAYS) ?? DEFAULT_RETAIN_DAYS;
  const retainRuns =
    opts.retainRuns ?? readPositiveInt(env.LOCAL_CI_LOG_RETAIN_RUNS) ?? DEFAULT_RETAIN_RUNS;
  const now = opts.now ? opts.now() : Date.now();

  if (!fs.existsSync(logsDir)) {
    return { skipped: true, reason: "missing", removed: [], kept: 0, protected: [] };
  }

  if (!force && isThrottled(logsDir, now)) {
    return { skipped: true, reason: "throttled", removed: [], kept: 0, protected: [] };
  }

  const lockPath = path.join(logsDir, LOCK_BASENAME);
  let lockFd: number | null = null;
  try {
    try {
      lockFd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return { skipped: true, reason: "locked", removed: [], kept: 0, protected: [] };
      }
      throw err;
    }

    const protectedNames = collectProtectedRunNames(stateDir, logsDir);

    const entries = listRunDirs(logsDir);
    // Newest first
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
    const removed: string[] = [];
    let kept = 0;

    for (const entry of entries) {
      const isProtected = protectedNames.has(entry.name);
      const tooOld = entry.mtimeMs < cutoff;
      const overCount = kept >= retainRuns;

      if (isProtected || (!tooOld && !overCount)) {
        kept++;
        continue;
      }

      try {
        fs.rmSync(entry.path, { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        // Skip dirs we can't remove — try again next time.
      }
    }

    writeStamp(logsDir, now);
    return { skipped: false, removed, kept, protected: [...protectedNames] };
  } catch {
    return { skipped: true, reason: "error", removed: [], kept: 0, protected: [] };
  } finally {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {
        /* noop */
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* noop */
      }
    }
  }
}

function readPositiveInt(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

interface RunDirEntry {
  name: string;
  path: string;
  mtimeMs: number;
}

function listRunDirs(logsDir: string): RunDirEntry[] {
  const out: RunDirEntry[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith(".")) {
      continue; // skip lock/stamp/etc.
    }
    const dirPath = path.join(logsDir, entry.name);
    try {
      const stat = fs.statSync(dirPath);
      out.push({ name: entry.name, path: dirPath, mtimeMs: stat.mtimeMs });
    } catch {
      // Skip unstatable dirs.
    }
  }
  return out;
}

/**
 * Walk every per-branch checks JSON under `stateDir` and collect the names of
 * any log directories they reference (via `logPath` / `debugLogPath`). Only
 * names whose parent directory equals `logsDir` are returned — references that
 * point elsewhere (e.g. an old workDir path) are not protected here.
 */
function collectProtectedRunNames(stateDir: string, logsDir: string): Set<string> {
  const protectedNames = new Set<string>();
  if (!fs.existsSync(stateDir)) {
    return protectedNames;
  }

  const resolvedLogsDir = path.resolve(logsDir);

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip our own logs subtree and dotfiles.
        if (entry.name.startsWith(".")) {
          continue;
        }
        if (path.resolve(full) === resolvedLogsDir) {
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".json")) {
        continue;
      }
      try {
        const json = JSON.parse(fs.readFileSync(full, "utf8"));
        for (const job of Array.isArray(json?.jobs) ? json.jobs : []) {
          maybeAdd(job?.debugLogPath, resolvedLogsDir, protectedNames);
          for (const step of Array.isArray(job?.steps) ? job.steps : []) {
            maybeAdd(step?.logPath, resolvedLogsDir, protectedNames);
          }
        }
      } catch {
        // Ignore malformed JSON.
      }
    }
  };

  walk(stateDir);
  return protectedNames;
}

function maybeAdd(p: unknown, resolvedLogsDir: string, sink: Set<string>): void {
  if (typeof p !== "string" || !p) {
    return;
  }
  // The run-name is the directory immediately under logsDir. e.g.
  //   /<logsDir>/local-ci-redwoodjssdk-15/output.log → "local-ci-redwoodjssdk-15"
  //   /<logsDir>/local-ci-redwoodjssdk-15/steps/2.log → "local-ci-redwoodjssdk-15"
  const resolved = path.resolve(p);
  const rel = path.relative(resolvedLogsDir, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return;
  }
  const first = rel.split(path.sep)[0];
  if (first) {
    sink.add(first);
  }
}

function isThrottled(logsDir: string, nowMs: number): boolean {
  const stampPath = path.join(logsDir, STAMP_BASENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(stampPath, "utf8");
  } catch {
    return false;
  }
  const last = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(last)) {
    return false;
  }
  return nowMs - last < DEFAULT_THROTTLE_MS;
}

function writeStamp(logsDir: string, nowMs: number): void {
  try {
    fs.writeFileSync(path.join(logsDir, STAMP_BASENAME), `${nowMs}\n`);
  } catch {
    // Throttle is a best-effort optimization; skipping the stamp just means
    // the next call may prune again — harmless.
  }
}
