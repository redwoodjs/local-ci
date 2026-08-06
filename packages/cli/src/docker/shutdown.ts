import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// ─── Docker container cleanup ─────────────────────────────────────────────────

const RESOURCE_PREFIXES = ["local-ci", "agent-ci"] as const;

/**
 * Force-kill a specific runner and its associated service containers + network.
 * Used when stopping a single workflow run.
 */
export function killRunnerContainers(runnerName: string): void {
  // 1. Force-remove the runner container itself
  try {
    execSync(`docker rm -f ${runnerName}`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // already gone
  }

  // 2. Force-remove any svc-* sidecars for this runner
  try {
    const ids = execSync(`docker ps -aq --filter "name=${runnerName}-svc-"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (ids) {
      execSync(`docker rm -f ${ids.split("\n").join(" ")}`, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  } catch {
    // no sidecars or Docker not reachable
  }

  // 3. Remove the shared bridge network, including the legacy name.
  for (const prefix of RESOURCE_PREFIXES) {
    try {
      execSync(`docker network rm ${prefix}-net-${runnerName}`, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // network doesn't exist or already removed
    }
  }
}

/**
 * Remove orphaned Docker resources left behind by previous runs:
 *   1. Stopped `local-ci-*` containers (runners + sidecars)
 *   2. `local-ci-net-*` networks with no connected containers
 *   3. Dangling volumes (anonymous volumes from service containers like MySQL)
 *
 * Stopped containers must be removed first so their network references are
 * released, allowing the network prune in step 2 to reclaim address pool capacity.
 *
 * Call this proactively before creating new resources to prevent Docker from
 * exhausting its address pool ("all predefined address pools have been fully subnetted").
 */
export function pruneOrphanedDockerResources(): void {
  // Skip when running inside a Docker container — we share the host's
  // Docker socket, so pruning would remove the host's containers/networks.
  if (fs.existsSync("/.dockerenv")) {
    return;
  }

  // 1. Remove stopped/stale local-ci-* containers (runners + sidecars) so their
  //    network references are released before we try to prune networks.
  //    Includes both "exited" and "created" (never started) containers.
  for (const prefix of RESOURCE_PREFIXES) {
    try {
      const stoppedIds = execSync(
        `docker ps -aq --filter "name=${prefix}-" --filter "status=exited" --filter "status=created"`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      if (stoppedIds) {
        execSync(`docker rm -f ${stoppedIds.split("\n").join(" ")}`, {
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
    } catch {
      // Docker not reachable or no stopped containers — skip
    }
  }

  // 2. Remove orphaned Local CI and legacy Agent CI networks.
  for (const prefix of RESOURCE_PREFIXES) {
    try {
      const nets = execSync(`docker network ls -q --filter "name=${prefix}-net-"`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (nets) {
        for (const netId of nets.split("\n")) {
          try {
            // docker network rm fails if containers are still attached — that's fine.
            execSync(`docker network rm ${netId}`, {
              stdio: ["pipe", "pipe", "pipe"],
            });
          } catch {
            // Network still in use — skip
          }
        }
      }
    } catch {
      // Docker not reachable — skip
    }
  }

  // 3. Remove dangling volumes (anonymous volumes from service containers)
  try {
    execSync(`docker volume prune -f`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Docker not reachable — skip
  }
}

// ─── Orphaned container cleanup ───────────────────────────────────────────────

/**
 * Find and kill running `local-ci-*` containers whose parent process is dead.
 *
 * Every container created by `executeLocalJob` (and its service containers)
 * is labelled with `local-ci.pid=<PID>`. If the process that spawned the
 * container is no longer alive, the container is an orphan and should be
 * killed — along with its svc-* sidecars and bridge network (via
 * `killRunnerContainers`).
 *
 * Containers without the label are also cleaned up — they're either pre-label
 * containers or service containers created before the label was added.
 */
export function killOrphanedContainers(): void {
  // Skip when running inside a Docker container (e.g. nested local-ci or
  // integration tests inside a runner container). The pid labels reference
  // host PIDs which don't exist in the container's PID namespace — every
  // container would look like an orphan, including our own parent.
  if (fs.existsSync("/.dockerenv")) {
    return;
  }

  const lines: string[] = [];
  for (const prefix of RESOURCE_PREFIXES) {
    try {
      // Format: "containerId containerName pid-label"
      const raw = execSync(
        `docker ps --filter "name=${prefix}-" --filter "status=running" --format "{{.ID}} {{.Names}} {{.Label \\"${prefix}.pid\\"}}"`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      if (raw) {
        lines.push(...raw.split("\n"));
      }
    } catch {
      // Docker not reachable — skip this namespace.
    }
  }
  if (lines.length === 0) {
    return;
  }

  // Track runner names we've already cleaned up to avoid double-cleaning
  const cleaned = new Set<string>();

  for (const line of lines) {
    const [, containerName, pidStr] = line.split(" ");
    if (!containerName) {
      continue;
    }

    // Containers with the pid label: check if the parent is still alive
    if (pidStr) {
      const pid = Number(pidStr);
      if (!Number.isFinite(pid) || pid <= 0) {
        continue;
      }

      try {
        process.kill(pid, 0); // signal 0 = liveness check, throws if dead
        continue; // Parent alive — not an orphan
      } catch {
        // Parent is dead — this container is an orphan.
      }
    }

    // Derive the runner name: for svc containers (e.g. "local-ci-2307-j2-svc-cache-db"),
    // extract the runner prefix before "-svc-"; for runner containers, use the name as-is.
    const svcIdx = containerName.indexOf("-svc-");
    const runnerName = svcIdx !== -1 ? containerName.substring(0, svcIdx) : containerName;

    if (!cleaned.has(runnerName)) {
      cleaned.add(runnerName);
      killRunnerContainers(runnerName);
    }
  }
}

// ─── Workspace pruning ────────────────────────────────────────────────────────

/**
 * Remove stale `local-ci-*` run directories older than `maxAgeMs` from
 * `<workDir>/runs/`. Each run dir contains logs, work, shims, and diag
 * co-located, so a single rm removes everything for that run.
 *
 * Returns an array of directory names that were pruned.
 */
export function pruneStaleWorkspaces(workDir: string, maxAgeMs: number): string[] {
  const runsPath = path.join(workDir, "runs");
  if (!fs.existsSync(runsPath)) {
    return [];
  }

  const now = Date.now();
  const pruned: string[] = [];

  for (const entry of fs.readdirSync(runsPath, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !RESOURCE_PREFIXES.some((prefix) => entry.name.startsWith(`${prefix}-`))
    ) {
      continue;
    }

    const dirPath = path.join(runsPath, entry.name);
    try {
      const stat = fs.statSync(dirPath);
      const ageMs = now - stat.mtimeMs;
      if (ageMs > maxAgeMs) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        pruned.push(entry.name);
      }
    } catch {
      // Skip dirs we can't stat
    }
  }

  return pruned;
}
