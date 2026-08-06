import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DETACHED_ENV,
  DETACHED_MARKER_FILENAME,
  EVENT_SCHEMA_VERSION,
  formatEvent,
  isDetachedWorker,
  isForceDetachedRequested,
  parseLogEvent,
  PAUSED_EXIT_CODE,
  readDetachedMarker,
  shouldLaunchDetached,
  writeDetachedMarker,
} from "./launcher.ts";

describe("formatEvent / parseLogEvent — run.paused", () => {
  it("round-trips a paused event", () => {
    const event = {
      event: "run.paused" as const,
      runner: "local-ci-1-job",
      step: "build",
      attempt: 2,
      workflow: "ci.yml",
      retry_cmd: "local-ci retry --name local-ci-1-job",
    };
    expect(parseLogEvent(formatEvent(event))).toEqual(event);
  });

  it("returns null for plain text log lines", () => {
    expect(parseLogEvent("hello world")).toBeNull();
    expect(parseLogEvent("")).toBeNull();
    expect(parseLogEvent("[Local CI] Step failed: build")).toBeNull();
  });

  it("returns null for incidental JSON without an `event` discriminator", () => {
    expect(parseLogEvent(`{"foo":1}`)).toBeNull();
    expect(parseLogEvent(`{"event":"unknown"}`)).toBeNull();
  });

  it("returns null when JSON is malformed", () => {
    expect(parseLogEvent("{not-json")).toBeNull();
  });

  it("returns null for JSON arrays / primitives", () => {
    expect(parseLogEvent("[1,2,3]")).toBeNull();
    expect(parseLogEvent("null")).toBeNull();
    expect(parseLogEvent("42")).toBeNull();
  });

  it("matches whole-line objects only — no embedded matches", () => {
    expect(parseLogEvent(`prefix {"event":"run.paused"}`)).toBeNull();
  });
});

describe("formatEvent / parseLogEvent — run.finish", () => {
  it("round-trips a passed event", () => {
    const e = {
      event: "run.finish" as const,
      ts: "2026-04-28T00:00:00.000Z",
      status: "passed" as const,
    };
    expect(parseLogEvent(formatEvent(e))).toEqual(e);
  });

  it("round-trips a failed event", () => {
    const e = { event: "run.finish" as const, status: "failed" as const, durationMs: 18210 };
    expect(parseLogEvent(formatEvent(e))).toEqual(e);
  });
});

describe("formatEvent / parseLogEvent — #289 lifecycle events", () => {
  it("round-trips run.start with schemaVersion", () => {
    const e = {
      event: "run.start" as const,
      ts: "2026-04-28T00:00:00.000Z",
      schemaVersion: EVENT_SCHEMA_VERSION,
      runId: "run-1",
      repo: "redwoodjs/local-ci",
      branch: "main",
    };
    expect(parseLogEvent(formatEvent(e))).toEqual(e);
  });

  it("round-trips job.start / job.finish", () => {
    const start = {
      event: "job.start" as const,
      ts: "2026-04-28T00:00:01.000Z",
      job: "lint",
      runner: "local-ci-1-job",
      workflow: "ci.yml",
    };
    const finish = {
      event: "job.finish" as const,
      ts: "2026-04-28T00:00:09.000Z",
      job: "lint",
      runner: "local-ci-1-job",
      workflow: "ci.yml",
      status: "passed" as const,
      durationMs: 8000,
    };
    expect(parseLogEvent(formatEvent(start))).toEqual(start);
    expect(parseLogEvent(formatEvent(finish))).toEqual(finish);
  });

  it("round-trips step.start / step.finish across all status values", () => {
    for (const status of ["passed", "failed", "skipped"] as const) {
      const finish = {
        event: "step.finish" as const,
        ts: "2026-04-28T00:00:05.000Z",
        job: "lint",
        runner: "local-ci-1-job",
        step: "eslint",
        index: 3,
        status,
        durationMs: 4123,
      };
      expect(parseLogEvent(formatEvent(finish))).toEqual(finish);
    }
    const start = {
      event: "step.start" as const,
      ts: "2026-04-28T00:00:04.000Z",
      job: "lint",
      runner: "local-ci-1-job",
      step: "eslint",
      index: 3,
    };
    expect(parseLogEvent(formatEvent(start))).toEqual(start);
  });

  it("round-trips diagnostic events", () => {
    const e = {
      event: "diagnostic" as const,
      ts: "2026-04-28T00:00:02.000Z",
      level: "warning" as const,
      message: "could not resolve workflow path; falling back to default",
      code: "prewarm_recommended",
      details: { selector: ".github/workflows/ci.yml:test:install" },
    };
    expect(parseLogEvent(formatEvent(e))).toEqual(e);
  });

  it("EVENT_SCHEMA_VERSION starts at 1", () => {
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });
});

describe("shouldLaunchDetached", () => {
  const base = {
    pauseOnFailure: true,
    stdoutIsTTY: false,
    agentMode: false,
    alreadyWorker: false,
  };

  it("launches when pause-on-failure + non-TTY", () => {
    expect(shouldLaunchDetached(base)).toBe(true);
  });

  it("skips in agent mode — the harness tails live output across retry", () => {
    expect(shouldLaunchDetached({ ...base, agentMode: true })).toBe(false);
  });

  it("skips when --pause-on-failure is not set", () => {
    expect(shouldLaunchDetached({ ...base, pauseOnFailure: false })).toBe(false);
  });

  it("skips in interactive TTY mode", () => {
    expect(shouldLaunchDetached({ ...base, stdoutIsTTY: true })).toBe(false);
  });

  it("skips even when both TTY + agent-mode are set", () => {
    expect(shouldLaunchDetached({ ...base, stdoutIsTTY: true, agentMode: true })).toBe(false);
  });

  it("never re-launches inside the worker process", () => {
    expect(shouldLaunchDetached({ ...base, alreadyWorker: true })).toBe(false);
  });

  it("forceDetached overrides the TTY check", () => {
    expect(shouldLaunchDetached({ ...base, stdoutIsTTY: true, forceDetached: true })).toBe(true);
  });

  it("forceDetached still respects alreadyWorker / agentMode / no-pause", () => {
    expect(shouldLaunchDetached({ ...base, alreadyWorker: true, forceDetached: true })).toBe(false);
    expect(shouldLaunchDetached({ ...base, agentMode: true, forceDetached: true })).toBe(false);
    expect(shouldLaunchDetached({ ...base, pauseOnFailure: false, forceDetached: true })).toBe(
      false,
    );
  });
});

describe("LOCAL_CI_DETACHED — value distinguishes worker from force-launch", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[DETACHED_ENV];
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env[DETACHED_ENV];
    } else {
      process.env[DETACHED_ENV] = original;
    }
  });

  it("absolute path means I am the worker", () => {
    process.env[DETACHED_ENV] = "/tmp/worker.log";
    expect(isDetachedWorker()).toBe(true);
    expect(isForceDetachedRequested()).toBe(false);
  });

  it("`1` means caller wants to force-launch (and is not the worker)", () => {
    process.env[DETACHED_ENV] = "1";
    expect(isDetachedWorker()).toBe(false);
    expect(isForceDetachedRequested()).toBe(true);
  });

  it("unset means neither", () => {
    delete process.env[DETACHED_ENV];
    expect(isDetachedWorker()).toBe(false);
    expect(isForceDetachedRequested()).toBe(false);
  });
});

describe("PAUSED_EXIT_CODE", () => {
  it("uses BSD EX_NOPERM (77) as the paused-but-not-failed code", () => {
    expect(PAUSED_EXIT_CODE).toBe(77);
  });
});

describe("writeDetachedMarker / readDetachedMarker", () => {
  let tmpDir: string;
  let originalDetached: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-launcher-test-"));
    originalDetached = process.env[DETACHED_ENV];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalDetached === undefined) {
      delete process.env[DETACHED_ENV];
    } else {
      process.env[DETACHED_ENV] = originalDetached;
    }
  });

  it("writes the marker when running detached", () => {
    process.env[DETACHED_ENV] = "/tmp/fake-worker.log";

    writeDetachedMarker(tmpDir);

    const marker = readDetachedMarker(tmpDir);
    expect(marker).not.toBeNull();
    expect(marker?.workerLogPath).toBe("/tmp/fake-worker.log");
    expect(marker?.workerPid).toBe(process.pid);
  });

  it("is a no-op when not running detached", () => {
    delete process.env[DETACHED_ENV];

    writeDetachedMarker(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, DETACHED_MARKER_FILENAME))).toBe(false);
    expect(readDetachedMarker(tmpDir)).toBeNull();
  });

  it("returns null when the marker file is missing or malformed", () => {
    expect(readDetachedMarker(tmpDir)).toBeNull();
    fs.writeFileSync(path.join(tmpDir, DETACHED_MARKER_FILENAME), "{not-json");
    expect(readDetachedMarker(tmpDir)).toBeNull();
    fs.writeFileSync(path.join(tmpDir, DETACHED_MARKER_FILENAME), JSON.stringify({ x: 1 }));
    expect(readDetachedMarker(tmpDir)).toBeNull();
  });
});
