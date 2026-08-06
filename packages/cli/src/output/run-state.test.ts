import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { RunStateStore, type RunState } from "./run-state.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-state-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeStore(runId = "test-run-1"): RunStateStore {
  return new RunStateStore(runId, path.join(tmpDir, runId, "run-state.json"));
}

describe("RunStateStore", () => {
  it("initialises with an empty running state", () => {
    const store = makeStore();
    const state = store.getState();
    expect(state.status).toBe("running");
    expect(state.workflows).toEqual([]);
    expect(state.runId).toBe("test-run-1");
    expect(state.startedAt).toMatch(/^\d{4}-/); // ISO date
  });

  it("addJob creates a workflow entry and adds a job", () => {
    const store = makeStore();
    store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1");
    const state = store.getState();
    expect(state.workflows).toHaveLength(1);
    expect(state.workflows[0].id).toBe("ci.yml");
    expect(state.workflows[0].jobs).toHaveLength(1);
    expect(state.workflows[0].jobs[0].id).toBe("test");
    expect(state.workflows[0].jobs[0].runnerId).toBe("local-ci-1");
    expect(state.workflows[0].jobs[0].status).toBe("queued");
  });

  it("addJob appends to an existing workflow", () => {
    const store = makeStore();
    store.addJob("/repo/.github/workflows/ci.yml", "lint", "local-ci-1-j1");
    store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1-j2");
    const wf = store.getState().workflows[0];
    expect(wf.jobs).toHaveLength(2);
    expect(wf.jobs[0].id).toBe("lint");
    expect(wf.jobs[1].id).toBe("test");
  });

  it("addJob ignores duplicate runnerId when no metadata changes", () => {
    const store = makeStore();
    store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1");
    store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1");
    expect(store.getState().workflows[0].jobs).toHaveLength(1);
  });

  it("addJob merges metadata for duplicate runnerId", () => {
    const store = makeStore();
    store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1");
    store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1", {
      logDir: "/tmp/logs",
      classification: "degraded",
      classificationSummary: "summary",
      classificationReasons: ["reason"],
    });
    expect(store.getState().workflows[0].jobs).toHaveLength(1);
    expect(store.getState().workflows[0].jobs[0]).toMatchObject({
      logDir: "/tmp/logs",
      classification: "degraded",
      classificationSummary: "summary",
      classificationReasons: ["reason"],
    });
  });

  it("updateJob updates the correct job", () => {
    const store = makeStore();
    store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1");
    store.updateJob("local-ci-1", { status: "booting", startedAt: "2024-01-01T00:00:00Z" });
    const job = store.getState().workflows[0].jobs[0];
    expect(job.status).toBe("booting");
    expect(job.startedAt).toBe("2024-01-01T00:00:00Z");
  });

  it("updateJob syncs workflow status to running when a job boots", () => {
    const store = makeStore();
    store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1");
    store.updateJob("local-ci-1", { status: "booting" });
    expect(store.getState().workflows[0].status).toBe("running");
  });

  it("updateJob syncs workflow status to completed when all jobs complete", () => {
    const store = makeStore();
    store.addJob("/repo/.github/workflows/ci.yml", "lint", "local-ci-1-j1");
    store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1-j2");
    store.updateJob("local-ci-1-j1", { status: "completed" });
    store.updateJob("local-ci-1-j2", { status: "completed" });
    expect(store.getState().workflows[0].status).toBe("completed");
  });

  it("updateJob syncs workflow status to failed when any job fails", () => {
    const store = makeStore();
    store.addJob("/repo/.github/workflows/ci.yml", "lint", "local-ci-1-j1");
    store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1-j2");
    store.updateJob("local-ci-1-j1", { status: "failed" });
    store.updateJob("local-ci-1-j2", { status: "completed" });
    expect(store.getState().workflows[0].status).toBe("failed");
  });

  it("updateJob handles pause state", () => {
    const store = makeStore();
    store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1");
    store.updateJob("local-ci-1", {
      status: "paused",
      pausedAtStep: "Run tests",
      pausedAtMs: "2024-01-01T00:01:00Z",
      attempt: 1,
      lastOutputLines: ["Error: test failed"],
    });
    const job = store.getState().workflows[0].jobs[0];
    expect(job.status).toBe("paused");
    expect(job.pausedAtStep).toBe("Run tests");
    expect(job.attempt).toBe(1);
    expect(job.lastOutputLines).toEqual(["Error: test failed"]);
  });

  it("complete marks the run as completed", () => {
    const store = makeStore();
    store.complete("completed");
    const state = store.getState();
    expect(state.status).toBe("completed");
    expect(state.completedAt).toBeDefined();
  });

  it("complete marks the run as failed", () => {
    const store = makeStore();
    store.complete("failed");
    expect(store.getState().status).toBe("failed");
  });

  describe("atomic persistence", () => {
    it("save writes a valid JSON file", async () => {
      const store = makeStore("persist-test");
      store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1");
      await store.save();

      const filePath = path.join(tmpDir, "persist-test", "run-state.json");
      expect(fs.existsSync(filePath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as RunState;
      expect(parsed.runId).toBe("persist-test");
      expect(parsed.workflows).toHaveLength(1);
    });

    it("load round-trips the state from disk", async () => {
      const store = makeStore("roundtrip");
      store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1");
      store.updateJob("local-ci-1", { status: "running" });
      await store.save();

      const filePath = path.join(tmpDir, "roundtrip", "run-state.json");
      const loaded = RunStateStore.load(filePath);
      expect(loaded.runId).toBe("roundtrip");
      expect(loaded.workflows[0].jobs[0].status).toBe("running");
    });

    it("save does not leave .tmp files behind", async () => {
      const store = makeStore("no-tmp");
      await store.save();
      const dir = path.join(tmpDir, "no-tmp");
      const files = fs.readdirSync(dir);
      expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    });
  });

  describe("matrix jobs", () => {
    it("supports multiple matrix combinations under one workflow", () => {
      const store = makeStore();
      store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1-j1-m1", {
        matrixValues: { node: "18" },
      });
      store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1-j1-m2", {
        matrixValues: { node: "20" },
      });
      const wf = store.getState().workflows[0];
      expect(wf.jobs).toHaveLength(2);
      expect(wf.jobs[0].matrixValues).toEqual({ node: "18" });
      expect(wf.jobs[1].matrixValues).toEqual({ node: "20" });
    });
  });

  describe("step state", () => {
    it("can update job with steps array", () => {
      const store = makeStore();
      store.addJob("/repo/.github/workflows/ci.yml", "test", "local-ci-1");
      store.updateJob("local-ci-1", {
        steps: [
          { name: "Set up job", index: 1, status: "completed", durationMs: 1000 },
          { name: "Run tests", index: 2, status: "running", startedAt: new Date().toISOString() },
        ],
      });
      const job = store.getState().workflows[0].jobs[0];
      expect(job.steps).toHaveLength(2);
      expect(job.steps[0].status).toBe("completed");
      expect(job.steps[1].status).toBe("running");
    });
  });
});
