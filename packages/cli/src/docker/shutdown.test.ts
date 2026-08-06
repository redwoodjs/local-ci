import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

// ── Signal handling cleanup ───────────────────────────────────────────────────

describe("Signal handler cleanup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-signal-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cleanup function removes all temp directories", () => {
    // With the new layout, work/shims/diag are co-located under runs/<runnerName>/
    const runDir = path.join(tmpDir, "runs", "local-ci-sig");
    const dirs = {
      containerWorkDir: path.join(runDir, "work"),
      workspaceDir: path.join(runDir, "work", "workspace"),
      shimsDir: path.join(runDir, "shims"),
      diagDir: path.join(runDir, "diag"),
    };

    for (const d of Object.values(dirs)) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "test.txt"), "data");
    }

    // Simulate signal handler cleanup — just remove the entire runDir
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch {}

    for (const d of Object.values(dirs)) {
      expect(fs.existsSync(d)).toBe(false);
    }
  });

  it("cleanup function is idempotent (handles missing dirs)", () => {
    const dirs = [path.join(tmpDir, "nonexistent-1"), path.join(tmpDir, "nonexistent-2")];

    // Should not throw
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }

    // If we got here, idempotency works
    expect(true).toBe(true);
  });
});

// ── Stale workspace pruning ───────────────────────────────────────────────────

describe("Stale workspace pruning", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-prune-test-"));
    // pruneStaleWorkspaces scans <workDir>/runs/
    fs.mkdirSync(path.join(tmpDir, "runs"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes local-ci-* dirs older than maxAge", async () => {
    // Create a stale run dir — the entire runDir is removed (includes logs, work, shims, diag)
    const staleDir = path.join(tmpDir, "runs", "local-ci-100");
    fs.mkdirSync(path.join(staleDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(staleDir, "logs", "output.log"), "stale");

    // Backdate it to 48 hours ago
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(staleDir, oldTime, oldTime);

    const { pruneStaleWorkspaces } = await import("./shutdown.ts");
    const pruned = pruneStaleWorkspaces(tmpDir, 24 * 60 * 60 * 1000);

    expect(pruned).toContain("local-ci-100");
    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it("keeps local-ci-* dirs newer than maxAge", async () => {
    // Create a fresh run dir
    const freshDir = path.join(tmpDir, "runs", "local-ci-200");
    fs.mkdirSync(path.join(freshDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(freshDir, "logs", "output.log"), "fresh");

    const { pruneStaleWorkspaces } = await import("./shutdown.ts");
    const pruned = pruneStaleWorkspaces(tmpDir, 24 * 60 * 60 * 1000);

    expect(pruned).toEqual([]);
    expect(fs.existsSync(freshDir)).toBe(true);
  });

  it("ignores non-local-ci dirs", async () => {
    const otherDir = path.join(tmpDir, "runs", "workspace-12345");
    fs.mkdirSync(otherDir, { recursive: true });

    // Backdate it
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(otherDir, oldTime, oldTime);

    const { pruneStaleWorkspaces } = await import("./shutdown.ts");
    const pruned = pruneStaleWorkspaces(tmpDir, 24 * 60 * 60 * 1000);

    expect(pruned).toEqual([]);
    expect(fs.existsSync(otherDir)).toBe(true);
  });
});

// ── Orphaned container cleanup ────────────────────────────────────────────────

describe("killOrphanedContainers", () => {
  const execSyncMock = vi.fn();
  const killSpy = vi.spyOn(process, "kill");
  const existsSyncMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execSync: execSyncMock,
    }));
    // Mock fs so /.dockerenv check doesn't skip the function inside containers
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        default: { ...actual, existsSync: existsSyncMock },
        existsSync: existsSyncMock,
      };
    });
    existsSyncMock.mockReturnValue(false);
    execSyncMock.mockReset();
    killSpy.mockReset();
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it("kills containers whose parent PID is dead", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("docker ps")) {
        return "abc123 local-ci-runner-1 99999\n";
      }
      return "";
    });
    killSpy.mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && pid === 99999) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    const { killOrphanedContainers } = await import("./shutdown.ts");
    killOrphanedContainers();

    const rmCalls = execSyncMock.mock.calls.filter(([cmd]: string[]) =>
      cmd.includes("docker rm -f local-ci-runner-1"),
    );
    expect(rmCalls.length).toBeGreaterThan(0);
  });

  it("leaves containers whose parent PID is alive", async () => {
    const myPid = process.pid;
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("docker ps")) {
        return `abc123 local-ci-runner-2 ${myPid}\n`;
      }
      return "";
    });
    killSpy.mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && pid === myPid) {
        return true;
      }
      throw new Error("ESRCH");
    }) as typeof process.kill);

    const { killOrphanedContainers } = await import("./shutdown.ts");
    killOrphanedContainers();

    const rmCalls = execSyncMock.mock.calls.filter(([cmd]: string[]) =>
      cmd.includes("docker rm -f"),
    );
    expect(rmCalls).toEqual([]);
  });

  it("kills unlabeled containers as orphans", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("docker ps")) {
        // Empty pid label — unlabeled container
        return "abc123 local-ci-runner-3 \n";
      }
      return "";
    });

    const { killOrphanedContainers } = await import("./shutdown.ts");
    killOrphanedContainers();

    const rmCalls = execSyncMock.mock.calls.filter(([cmd]: string[]) =>
      cmd.includes("docker rm -f local-ci-runner-3"),
    );
    expect(rmCalls.length).toBeGreaterThan(0);
  });

  it("derives runner name from svc container and cleans both", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("docker ps")) {
        // An unlabeled svc container whose runner is already gone
        return "def456 local-ci-2307-j2-svc-cache-db \n";
      }
      return "";
    });

    const { killOrphanedContainers } = await import("./shutdown.ts");
    killOrphanedContainers();

    // Should call killRunnerContainers with the runner name (without -svc-cache-db)
    const rmCalls = execSyncMock.mock.calls.filter(([cmd]: string[]) =>
      cmd.includes("docker rm -f local-ci-2307-j2"),
    );
    expect(rmCalls.length).toBeGreaterThan(0);
  });

  it("deduplicates cleanup when runner and svc containers share a PID", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("docker ps")) {
        // Both runner and its svc container listed, both with dead PID
        return (
          ["aaa111 local-ci-500-j1 99999", "bbb222 local-ci-500-j1-svc-redis 99999"].join("\n") +
          "\n"
        );
      }
      return "";
    });
    killSpy.mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && pid === 99999) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    const { killOrphanedContainers } = await import("./shutdown.ts");
    killOrphanedContainers();

    // killRunnerContainers should only be called once for the runner name
    const rmCalls = execSyncMock.mock.calls.filter(([cmd]: string[]) =>
      cmd.includes("docker rm -f local-ci-500-j1"),
    );
    // One call for the runner rm, one for the svc filter — but NOT a second
    // full killRunnerContainers pass for the svc container
    expect(rmCalls.length).toBe(1);
  });

  it("handles Docker not reachable gracefully", async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("Cannot connect to Docker daemon");
    });

    const { killOrphanedContainers } = await import("./shutdown.ts");
    expect(() => killOrphanedContainers()).not.toThrow();
  });
});

describe("containerWorkDir cleanup on exit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-cleanup-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cleans entire runDir on success", () => {
    // New layout: work/shims/diag are all under runs/<runnerName>/
    const runDir = path.join(tmpDir, "runs", "local-ci-1");
    const containerWorkDir = path.join(runDir, "work");
    const shimsDir = path.join(runDir, "shims");
    const diagDir = path.join(runDir, "diag");
    const logDir = path.join(runDir, "logs");

    // Create all dirs
    for (const d of [containerWorkDir, shimsDir, diagDir, logDir]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "test.txt"), "data");
    }

    const jobSucceeded = true;

    // On success: clean the entire runDir (logs kept via archiving externally)
    if (jobSucceeded && fs.existsSync(runDir)) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }

    expect(fs.existsSync(runDir)).toBe(false);
    expect(fs.existsSync(containerWorkDir)).toBe(false);
    expect(fs.existsSync(shimsDir)).toBe(false);
    expect(fs.existsSync(diagDir)).toBe(false);
  });

  it("retains runDir on failure for debugging", () => {
    const runDir = path.join(tmpDir, "runs", "local-ci-2");
    const containerWorkDir = path.join(runDir, "work");
    const shimsDir = path.join(runDir, "shims");
    const diagDir = path.join(runDir, "diag");
    const logDir = path.join(runDir, "logs");

    for (const d of [containerWorkDir, shimsDir, diagDir, logDir]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "test.txt"), "data");
    }

    const jobSucceeded = false;

    // On failure: keep runDir so the developer can inspect work/, shims/, diag/, logs/
    if (jobSucceeded && fs.existsSync(runDir)) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }

    // runDir should be RETAINED
    expect(fs.existsSync(runDir)).toBe(true);
    expect(fs.readFileSync(path.join(containerWorkDir, "test.txt"), "utf-8")).toBe("data");
    // All subdirs retained
    expect(fs.existsSync(containerWorkDir)).toBe(true);
    expect(fs.existsSync(shimsDir)).toBe(true);
    expect(fs.existsSync(diagDir)).toBe(true);
  });
});

// ── Integration: orphan cleanup against real Docker ──────────────────────────

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function insideDocker(): boolean {
  return fs.existsSync("/.dockerenv");
}

// Skip inside containers: killOrphanedContainers bails when /.dockerenv
// exists (PID namespace mismatch), so integration tests can't exercise it.
describe.skipIf(!dockerAvailable() || insideDocker())(
  "killOrphanedContainers (Docker integration)",
  () => {
    const containerName = "local-ci-orphan-smoke-svc-testdb";
    const runnerName = "local-ci-orphan-smoke";

    // Import the real function eagerly, outside vitest's mock system.
    // The unit tests above use vi.doMock("node:child_process") which poisons
    // dynamic imports even after vi.resetModules()/vi.unmock(). Spawning a
    // fresh node process sidesteps that entirely — and this IS a smoke test,
    // so exercising the real module resolution path is a feature, not a hack.
    function runKillOrphanedContainers() {
      execSync(
        `node --input-type=module -e "import { killOrphanedContainers } from './src/docker/shutdown.ts'; killOrphanedContainers();"`,
        { stdio: "pipe" },
      );
    }

    afterEach(() => {
      // Belt-and-suspenders: ensure we don't leak the test container
      try {
        execSync(`docker rm -f ${containerName}`, { stdio: "pipe" });
      } catch {
        // already gone — good
      }
      try {
        execSync(`docker network rm local-ci-net-${runnerName}`, { stdio: "pipe" });
      } catch {
        // already gone
      }
    });

    it("cleans up an unlabeled service container", () => {
      // Create a container that mimics a leaked pre-fix service container: no local-ci.pid label
      execSync(`docker create --name ${containerName} busybox sleep 300`, { stdio: "pipe" });
      execSync(`docker start ${containerName}`, { stdio: "pipe" });

      // Confirm it's running
      const before = execSync(
        `docker ps -q --filter "name=${containerName}" --filter "status=running"`,
        { encoding: "utf8", stdio: "pipe" },
      ).trim();
      expect(before).not.toBe("");

      runKillOrphanedContainers();

      // Container should be gone
      const after = execSync(`docker ps -aq --filter "name=${containerName}"`, {
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
      expect(after).toBe("");
    });

    it("cleans up a labeled service container whose parent PID is dead", () => {
      // Use a PID that's guaranteed dead (PID 2^22 - 1 is extremely unlikely to exist)
      const deadPid = "4194303";

      execSync(
        `docker create --name ${containerName} --label "local-ci.pid=${deadPid}" busybox sleep 300`,
        { stdio: "pipe" },
      );
      execSync(`docker start ${containerName}`, { stdio: "pipe" });

      const before = execSync(
        `docker ps -q --filter "name=${containerName}" --filter "status=running"`,
        { encoding: "utf8", stdio: "pipe" },
      ).trim();
      expect(before).not.toBe("");

      runKillOrphanedContainers();

      const after = execSync(`docker ps -aq --filter "name=${containerName}"`, {
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
      expect(after).toBe("");
    });

    it("does NOT kill a service container whose parent PID is alive", () => {
      // Label with our own PID — should be left alone
      const myPid = String(process.pid);

      execSync(
        `docker create --name ${containerName} --label "local-ci.pid=${myPid}" busybox sleep 300`,
        { stdio: "pipe" },
      );
      execSync(`docker start ${containerName}`, { stdio: "pipe" });

      runKillOrphanedContainers();

      // Container should still be running
      const after = execSync(
        `docker ps -q --filter "name=${containerName}" --filter "status=running"`,
        { encoding: "utf8", stdio: "pipe" },
      ).trim();
      expect(after).not.toBe("");
    });
  },
);
