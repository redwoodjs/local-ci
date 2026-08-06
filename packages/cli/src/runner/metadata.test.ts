import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── findRepoRoot ──────────────────────────────────────────────────────────────

describe("findRepoRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-root-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds the .git root from a deeply nested path", async () => {
    const { findRepoRoot } = await import("./metadata.ts");
    // Create .git at root level
    fs.mkdirSync(path.join(tmpDir, ".git"));
    // Create a deeply nested file
    const nested = path.join(tmpDir, "a", "b", "c", "file.txt");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "test");

    expect(findRepoRoot(nested)).toBe(tmpDir);
  });

  it("returns undefined when no .git exists", async () => {
    const { findRepoRoot } = await import("./metadata.ts");
    const file = path.join(tmpDir, "file.txt");
    fs.writeFileSync(file, "test");

    expect(findRepoRoot(file)).toBeUndefined();
  });
});

// ── deriveWorkflowRunId ───────────────────────────────────────────────────────

describe("deriveWorkflowRunId", () => {
  it("strips job/matrix/retry suffixes", async () => {
    const { deriveWorkflowRunId } = await import("./metadata.ts");

    expect(deriveWorkflowRunId("local-ci-redwoodjssdk-14-j1-m2-r2")).toBe(
      "local-ci-redwoodjssdk-14",
    );
    expect(deriveWorkflowRunId("local-ci-redwoodjssdk-14-j1")).toBe("local-ci-redwoodjssdk-14");
    expect(deriveWorkflowRunId("local-ci-redwoodjssdk-14")).toBe("local-ci-redwoodjssdk-14");
  });

  it("handles names without suffixes", async () => {
    const { deriveWorkflowRunId } = await import("./metadata.ts");

    expect(deriveWorkflowRunId("simple-runner")).toBe("simple-runner");
  });
});

// ── writeJobMetadata ──────────────────────────────────────────────────────────

describe("writeJobMetadata", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-write-test-"));
    // Create a fake repo root so findRepoRoot works
    repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".github", "workflows"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes metadata.json with expected fields", async () => {
    const { writeJobMetadata } = await import("./metadata.ts");
    const logDir = path.join(tmpDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const workflowPath = path.join(repoDir, ".github", "workflows", "ci.yml");
    fs.writeFileSync(workflowPath, "name: CI");

    writeJobMetadata({
      logDir,
      containerName: "local-ci-test-1",
      job: {
        deliveryId: "d1",
        eventType: "push",
        login: "test",
        workflowPath,
        taskId: "build",
        headSha: "abc123",
      },
    });

    const meta = JSON.parse(fs.readFileSync(path.join(logDir, "metadata.json"), "utf-8"));
    expect(meta.workflowPath).toBe(workflowPath);
    expect(meta.workflowName).toBe("ci");
    expect(meta.workflowRunId).toBe("local-ci-test-1");
    expect(meta.commitId).toBe("abc123");
    expect(meta.taskId).toBe("build");
    expect(meta.attempt).toBe(1);
    expect(meta.repoPath).toBe(repoDir);
  });

  it("preserves orchestrator-written fields on merge", async () => {
    const { writeJobMetadata } = await import("./metadata.ts");
    const logDir = path.join(tmpDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const workflowPath = path.join(repoDir, ".github", "workflows", "ci.yml");
    fs.writeFileSync(workflowPath, "name: CI");

    // Pre-write orchestrator metadata
    fs.writeFileSync(
      path.join(logDir, "metadata.json"),
      JSON.stringify({
        workflowRunId: "custom-run-id",
        matrixContext: { shard: 1 },
        jobName: "Shard (1/3)",
        attempt: 2,
      }),
    );

    writeJobMetadata({
      logDir,
      containerName: "local-ci-test-1-j1-m1",
      job: {
        deliveryId: "d1",
        eventType: "push",
        login: "test",
        workflowPath,
        taskId: "build",
      },
    });

    const meta = JSON.parse(fs.readFileSync(path.join(logDir, "metadata.json"), "utf-8"));
    // Orchestrator fields preserved
    expect(meta.workflowRunId).toBe("custom-run-id");
    expect(meta.matrixContext).toEqual({ shard: 1 });
    expect(meta.jobName).toBe("Shard (1/3)");
    expect(meta.attempt).toBe(2);
  });

  it("does nothing when workflowPath is not set", async () => {
    const { writeJobMetadata } = await import("./metadata.ts");
    const logDir = path.join(tmpDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });

    writeJobMetadata({
      logDir,
      containerName: "test",
      job: { deliveryId: "d1", eventType: "push", login: "test" },
    });

    expect(fs.existsSync(path.join(logDir, "metadata.json"))).toBe(false);
  });
});
