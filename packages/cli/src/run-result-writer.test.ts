import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobResult } from "./output/reporter.ts";
import {
  buildRunResultJson,
  resolveRunResultPath,
  resolveStateDir,
  RUN_RESULT_SCHEMA_VERSION,
  worktreePathHash,
  writeRunResult,
} from "./run-result-writer.ts";

function job(overrides: Partial<JobResult> = {}): JobResult {
  return {
    name: "job",
    workflow: "test.yml",
    taskId: "task",
    succeeded: true,
    durationMs: 1000,
    debugLogPath: "/tmp/local-ci-missing-debug.log",
    ...overrides,
  };
}

describe("resolveStateDir", () => {
  it("honors LOCAL_CI_STATE_DIR verbatim", () => {
    expect(resolveStateDir({ LOCAL_CI_STATE_DIR: "/custom/path" }, "linux")).toBe("/custom/path");
    expect(resolveStateDir({ LOCAL_CI_STATE_DIR: "/custom/path" }, "darwin")).toBe("/custom/path");
  });

  it("uses Library/Application Support on macOS", () => {
    expect(resolveStateDir({ HOME: "/Users/alice" }, "darwin")).toBe(
      "/Users/alice/Library/Application Support/local-ci",
    );
  });

  it("uses $XDG_STATE_HOME/local-ci on Linux when set", () => {
    expect(resolveStateDir({ HOME: "/home/alice", XDG_STATE_HOME: "/state" }, "linux")).toBe(
      "/state/local-ci",
    );
  });

  it("falls back to ~/.local/state/local-ci on Linux", () => {
    expect(resolveStateDir({ HOME: "/home/alice" }, "linux")).toBe(
      "/home/alice/.local/state/local-ci",
    );
  });
});

describe("worktreePathHash", () => {
  it("is deterministic for the same path", () => {
    expect(worktreePathHash("/a/b")).toBe(worktreePathHash("/a/b"));
  });

  it("differs across paths", () => {
    expect(worktreePathHash("/a/b")).not.toBe(worktreePathHash("/a/c"));
  });

  it("is 8 hex chars", () => {
    expect(worktreePathHash("/a/b")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("resolveRunResultPath", () => {
  it("disambiguates two worktrees on the same branch", () => {
    const a = resolveRunResultPath("/state", "org/repo", "main", "/wt/a");
    const b = resolveRunResultPath("/state", "org/repo", "main", "/wt/b");
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe("/state/org/repo");
  });

  it("sanitizes slashes in branch names into dashes", () => {
    const p = resolveRunResultPath("/state", "org/repo", "feat/foo", "/wt");
    expect(path.basename(p)).toMatch(/^feat-foo\.[0-9a-f]{8}\.json$/);
  });
});

describe("buildRunResultJson", () => {
  const base = {
    repo: "org/repo",
    branch: "main",
    worktreePath: "/wt",
    headSha: "abc123",
    startedAt: new Date("2026-04-20T10:15:00Z"),
    finishedAt: new Date("2026-04-20T10:17:42Z"),
  };

  it("marks run passed only when every job passed", () => {
    const r1 = buildRunResultJson({ ...base, results: [job(), job()] });
    expect(r1.status).toBe("passed");
    const r2 = buildRunResultJson({ ...base, results: [job(), job({ succeeded: false })] });
    expect(r2.status).toBe("failed");
  });

  it("emits the documented schema shape", () => {
    const out = buildRunResultJson({
      ...base,
      results: [
        job({ name: "lint", succeeded: true, durationMs: 4123 }),
        job({ name: "test", succeeded: false, durationMs: 18210, failedStep: "run tests" }),
      ],
    });
    expect(out).toEqual({
      schemaVersion: RUN_RESULT_SCHEMA_VERSION,
      repo: "org/repo",
      branch: "main",
      worktreePath: "/wt",
      headSha: "abc123",
      startedAt: "2026-04-20T10:15:00.000Z",
      finishedAt: "2026-04-20T10:17:42.000Z",
      status: "failed",
      jobs: [
        { name: "lint", workflow: "test.yml", status: "passed", durationMs: 4123 },
        {
          name: "test",
          workflow: "test.yml",
          status: "failed",
          durationMs: 18210,
          failingStep: "run tests",
        },
      ],
    });
  });

  it("omits failingStep when none is set", () => {
    const out = buildRunResultJson({ ...base, results: [job({ succeeded: false })] });
    expect(out.jobs[0]).not.toHaveProperty("failingStep");
  });

  it("emits steps[] with per-step logPath when the file exists", () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-logs-"));
    try {
      const stepsDir = path.join(logDir, "steps");
      fs.mkdirSync(stepsDir, { recursive: true });
      const setupLog = path.join(stepsDir, "Setup.log");
      const buildLog = path.join(stepsDir, "Build.log");
      fs.writeFileSync(setupLog, "ok\n");
      fs.writeFileSync(buildLog, "boom\n");

      const out = buildRunResultJson({
        ...base,
        results: [
          job({
            steps: [
              { name: "Setup", status: "passed", logPath: setupLog },
              { name: "Build", status: "failed", logPath: buildLog },
              { name: "Deploy", status: "skipped" },
            ],
          }),
        ],
      });

      expect(out.jobs[0].steps).toEqual([
        { name: "Setup", status: "passed", logPath: setupLog },
        { name: "Build", status: "failed", logPath: buildLog },
        { name: "Deploy", status: "skipped" },
      ]);
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("drops step logPath when the file has been cleaned up", () => {
    const out = buildRunResultJson({
      ...base,
      results: [
        job({
          steps: [{ name: "Setup", status: "passed", logPath: "/tmp/definitely-missing.log" }],
        }),
      ],
    });
    expect(out.jobs[0].steps).toEqual([{ name: "Setup", status: "passed" }]);
  });

  it("includes debugLogPath when the file exists", () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-logs-"));
    try {
      const debugLog = path.join(logDir, "debug.log");
      fs.writeFileSync(debugLog, "");

      const out = buildRunResultJson({
        ...base,
        results: [
          job({
            succeeded: false,
            debugLogPath: debugLog,
            failedStep: "Build",
          }),
        ],
      });

      expect(out.jobs[0].debugLogPath).toBe(debugLog);
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("omits debugLogPath when the file is gone", () => {
    const out = buildRunResultJson({
      ...base,
      results: [
        job({
          succeeded: false,
          debugLogPath: "/tmp/gone/debug.log",
          failedStep: "Build",
          failedStepLogPath: "/tmp/gone/steps/Build.log",
        }),
      ],
    });
    expect(out.jobs[0]).not.toHaveProperty("debugLogPath");
    expect(out.jobs[0].failingStep).toBe("Build");
  });

  it("omits steps when the job has none", () => {
    const out = buildRunResultJson({ ...base, results: [job()] });
    expect(out.jobs[0]).not.toHaveProperty("steps");
  });
});

describe("writeRunResult", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-state-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes parseable JSON at the expected path", () => {
    const out = writeRunResult(
      {
        repo: "org/repo",
        branch: "main",
        worktreePath: "/wt",
        headSha: "abc",
        startedAt: new Date(0),
        finishedAt: new Date(1000),
        results: [job()],
      },
      { stateDir },
    );
    expect(out).not.toBeNull();
    const parsed = JSON.parse(fs.readFileSync(out!, "utf-8"));
    expect(parsed.schemaVersion).toBe(RUN_RESULT_SCHEMA_VERSION);
    expect(parsed.repo).toBe("org/repo");
    expect(parsed.status).toBe("passed");
  });

  it("overwrites the previous run result for the same worktree", () => {
    const common = {
      repo: "org/repo",
      branch: "main",
      worktreePath: "/wt",
      headSha: "abc",
      startedAt: new Date(0),
      finishedAt: new Date(1000),
    };
    const first = writeRunResult({ ...common, results: [job({ succeeded: false })] }, { stateDir });
    const second = writeRunResult({ ...common, results: [job()] }, { stateDir });
    expect(first).toBe(second);
    const parsed = JSON.parse(fs.readFileSync(second!, "utf-8"));
    expect(parsed.status).toBe("passed");
  });

  it("leaves no tmp file behind on success", () => {
    const out = writeRunResult(
      {
        repo: "org/repo",
        branch: "main",
        worktreePath: "/wt",
        headSha: "abc",
        startedAt: new Date(0),
        finishedAt: new Date(1000),
        results: [job()],
      },
      { stateDir },
    );
    const dir = path.dirname(out!);
    const leftover = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("returns null on write failure without throwing", () => {
    const out = writeRunResult(
      {
        repo: "org/repo",
        branch: "main",
        worktreePath: "/wt",
        headSha: "abc",
        startedAt: new Date(0),
        finishedAt: new Date(1000),
        results: [job()],
      },
      { stateDir: "/nonexistent/\0/invalid" },
    );
    expect(out).toBeNull();
  });
});
