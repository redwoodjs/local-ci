import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Logger utilities", () => {
  let tmpDir: string;
  let logsDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-logger-test-"));
    logsDir = path.join(tmpDir, "logs-root");
    vi.resetModules();
    const { setLogsDirectory } = await import("./logs-directory.ts");
    setLogsDirectory(logsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("ensureLogDirs", () => {
    it("creates the runs/ directory", async () => {
      const { setWorkingDirectory } = await import("./working-directory.ts");
      const { ensureLogDirs } = await import("./logger.ts");
      setWorkingDirectory(tmpDir);
      ensureLogDirs();
      expect(fs.existsSync(path.join(tmpDir, "runs"))).toBe(true);
    });
  });

  describe("getNextLogNum", () => {
    it("returns 1 when runs/ dir is empty or absent", async () => {
      const { setWorkingDirectory } = await import("./working-directory.ts");
      const { getNextLogNum } = await import("./logger.ts");
      setWorkingDirectory(tmpDir);
      expect(getNextLogNum("local-ci")).toBe(1);
    });

    it("returns next number after existing local-ci-* entries", async () => {
      const { setWorkingDirectory } = await import("./working-directory.ts");
      const { getNextLogNum } = await import("./logger.ts");
      setWorkingDirectory(tmpDir);
      fs.mkdirSync(path.join(tmpDir, "runs", "local-ci-1"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "local-ci-2"), { recursive: true });
      expect(getNextLogNum("local-ci")).toBe(3);
    });

    it("counts only the base run number from multi-job names", async () => {
      const { setWorkingDirectory } = await import("./working-directory.ts");
      const { getNextLogNum } = await import("./logger.ts");
      setWorkingDirectory(tmpDir);
      // Multi-job run: local-ci-15 with -j1-m2 suffix — base is 15
      fs.mkdirSync(path.join(tmpDir, "runs", "local-ci-redwoodjssdk-14"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "local-ci-redwoodjssdk-15-j1"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "local-ci-redwoodjssdk-15-j2-m1"), {
        recursive: true,
      });
      expect(getNextLogNum("local-ci")).toBe(16);
    });

    it("does not reuse a run number while a stable log dir still exists (issue #341)", async () => {
      const { setWorkingDirectory } = await import("./working-directory.ts");
      const { setLogsDirectory } = await import("./logs-directory.ts");
      const { getNextLogNum } = await import("./logger.ts");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      // Reproduction for #341: workspace pruning removed `<workDir>/runs/local-ci-15-j1`,
      // but the stable log dir still has timeline.json. Reusing 15 would make
      // the DTU merge a fresh passing timeline into stale failed records.
      const staleLogDir = path.join(logsDir, "local-ci-15-j1");
      fs.mkdirSync(staleLogDir, { recursive: true });
      fs.writeFileSync(
        path.join(staleLogDir, "timeline.json"),
        JSON.stringify([
          {
            id: "old-task",
            type: "Task",
            name: "Check API.md is up to date",
            result: "Failed",
          },
        ]),
      );

      expect(getNextLogNum("local-ci")).toBe(16);
    });
  });

  describe("createLogContext", () => {
    it("creates runDir under workingDir and logDir under logsDir", async () => {
      const { setWorkingDirectory } = await import("./working-directory.ts");
      const { setLogsDirectory } = await import("./logs-directory.ts");
      const { createLogContext } = await import("./logger.ts");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      const ctx = createLogContext("local-ci");
      expect(ctx.name).toMatch(/^local-ci-\d+$/);
      expect(ctx.runDir.startsWith(path.join(tmpDir, "runs"))).toBe(true);
      expect(ctx.logDir.startsWith(logsDir)).toBe(true);
      expect(fs.existsSync(ctx.runDir)).toBe(true);
      expect(fs.existsSync(ctx.logDir)).toBe(true);
      expect(ctx.outputLogPath).toBe(path.join(ctx.logDir, "output.log"));
      expect(ctx.debugLogPath).toBe(path.join(ctx.logDir, "debug.log"));
    });

    it("uses preferredName when provided", async () => {
      const { setWorkingDirectory } = await import("./working-directory.ts");
      const { setLogsDirectory } = await import("./logs-directory.ts");
      const { createLogContext } = await import("./logger.ts");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      const ctx = createLogContext("local-ci", "local-ci-redwoodjssdk-42");
      expect(ctx.name).toBe("local-ci-redwoodjssdk-42");
      expect(ctx.runDir).toBe(path.join(tmpDir, "runs", "local-ci-redwoodjssdk-42"));
      expect(ctx.logDir).toBe(path.join(logsDir, "local-ci-redwoodjssdk-42"));
    });

    it("clears stale per-run log artifacts when a preferred log name is reused", async () => {
      const { setWorkingDirectory } = await import("./working-directory.ts");
      const { setLogsDirectory } = await import("./logs-directory.ts");
      const { createLogContext } = await import("./logger.ts");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      const staleLogDir = path.join(logsDir, "local-ci-redwoodjssdk-42");
      fs.mkdirSync(path.join(staleLogDir, "steps"), { recursive: true });
      fs.writeFileSync(path.join(staleLogDir, "timeline.json"), "[]");
      fs.writeFileSync(path.join(staleLogDir, "outputs.json"), "{}");
      fs.writeFileSync(path.join(staleLogDir, "metadata.json"), "{}");
      fs.writeFileSync(path.join(staleLogDir, "steps", "old.log"), "stale");

      const ctx = createLogContext("local-ci", "local-ci-redwoodjssdk-42");

      expect(ctx.logDir).toBe(staleLogDir);
      expect(fs.existsSync(path.join(staleLogDir, "timeline.json"))).toBe(false);
      expect(fs.existsSync(path.join(staleLogDir, "outputs.json"))).toBe(false);
      expect(fs.existsSync(path.join(staleLogDir, "metadata.json"))).toBe(false);
      expect(fs.existsSync(path.join(staleLogDir, "steps"))).toBe(false);
    });

    it("auto-increments when no preferredName given", async () => {
      const { setWorkingDirectory } = await import("./working-directory.ts");
      const { setLogsDirectory } = await import("./logs-directory.ts");
      const { createLogContext } = await import("./logger.ts");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      const first = createLogContext("local-ci");
      const second = createLogContext("local-ci");
      expect(second.num).toBe(first.num + 1);
    });

    it("skips over a directory that already exists (race condition)", async () => {
      const { setWorkingDirectory } = await import("./working-directory.ts");
      const { setLogsDirectory } = await import("./logs-directory.ts");
      const { createLogContext } = await import("./logger.ts");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      // Pre-create runs/local-ci-1 to simulate another process winning the race
      fs.mkdirSync(path.join(tmpDir, "runs", "local-ci-1"), { recursive: true });

      const ctx = createLogContext("local-ci");
      // Should have skipped 1 and landed on 2
      expect(ctx.num).toBe(2);
      expect(ctx.name).toBe("local-ci-2");
      expect(fs.existsSync(ctx.runDir)).toBe(true);
    });

    it("handles multiple consecutive collisions", async () => {
      const { setWorkingDirectory } = await import("./working-directory.ts");
      const { setLogsDirectory } = await import("./logs-directory.ts");
      const { createLogContext } = await import("./logger.ts");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      // Pre-create 1, 2, and 3 to simulate several concurrent processes
      fs.mkdirSync(path.join(tmpDir, "runs", "local-ci-1"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "local-ci-2"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "local-ci-3"), { recursive: true });

      const ctx = createLogContext("local-ci");
      expect(ctx.num).toBe(4);
      expect(ctx.name).toBe("local-ci-4");
      expect(fs.existsSync(ctx.runDir)).toBe(true);
    });

    it("concurrent calls each get a unique directory", async () => {
      const { setWorkingDirectory } = await import("./working-directory.ts");
      const { setLogsDirectory } = await import("./logs-directory.ts");
      const { createLogContext } = await import("./logger.ts");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      // Call createLogContext many times synchronously — each should get a unique dir
      const results = Array.from({ length: 10 }, () => createLogContext("local-ci"));

      const names = results.map((r) => r.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(10);

      // All directories should exist
      for (const r of results) {
        expect(fs.existsSync(r.runDir)).toBe(true);
        expect(fs.existsSync(r.logDir)).toBe(true);
      }
    });
  });
});
