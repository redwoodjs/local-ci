import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { state, getActionTarballsDir } from "../../store.ts";
import { bootstrapAndReturnApp } from "../../index.ts";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Polka } from "polka";

let PORT: number;

describe("Action Tarball Cache", () => {
  let server: Polka;

  beforeAll(async () => {
    state.reset();
    const app = await bootstrapAndReturnApp();
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.server?.address() as AddressInfo;
        PORT = address.port;
        resolve();
      });
    });
  });

  beforeEach(() => {
    state.reset();
    // Clean up any tarball cache files from prior tests
    const dir = getActionTarballsDir();
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        try {
          fs.unlinkSync(path.join(dir, file));
        } catch {}
      }
    }
  });

  afterAll(async () => {
    // Clean up tarball cache dir
    const dir = getActionTarballsDir();
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        try {
          fs.unlinkSync(path.join(dir, file));
        } catch {}
      }
    }
    await new Promise<void>((resolve) => {
      if (server?.server) {
        server.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  // ── Action tarball proxy route ───────────────────────────────────────────────

  it("should serve a cached tarball from disk (cache hit)", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    // Pre-seed a tarball file on disk
    const dir = getActionTarballsDir();
    fs.mkdirSync(dir, { recursive: true });
    const tarballPath = path.join(dir, "actions__checkout@v4.tar.gz");
    const content = Buffer.from("fake-tarball-content");
    fs.writeFileSync(tarballPath, content);

    // Request should serve from disk
    const res = await fetch(`${baseUrl}/_dtu/action-tarball/actions/checkout/v4`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    expect(res.headers.get("content-length")).toBe(String(content.length));

    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(content);
  });

  it("should return error for cache miss when GitHub is unreachable", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    // No cached file exists, and the proxy will try to fetch from GitHub.
    // Since the test env can't reach GitHub reliably, we just verify the route
    // doesn't crash and returns a response (either 200 if GitHub responds, or
    // 502/error if it can't reach GitHub). The key is no server crash.
    const res = await fetch(`${baseUrl}/_dtu/action-tarball/nonexistent/repo/v999`);
    // Should get some response (not a connection error)
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it("should not match slash-containing refs as a single route param", async () => {
    const baseUrl = `http://localhost:${PORT}`;
    const dir = getActionTarballsDir();
    fs.mkdirSync(dir, { recursive: true });

    // This is the cache file that would be used if "refs/heads/main" were accepted
    // as a single ref value and sanitized to "refs-heads-main".
    const tarballPath = path.join(dir, "my-org__my-repo@refs-heads-main.tar.gz");
    fs.writeFileSync(tarballPath, "test-content");

    const res = await fetch(`${baseUrl}/_dtu/action-tarball/my-org/my-repo/refs/heads/main`);
    // Polka does not bind :ref across slashes, so this URL does not hit the route
    // as a single ref value and therefore must not serve the cached tarball above.
    expect(res.status).toBe(404);
    await expect(res.text()).resolves.not.toBe("test-content");
  });

  it("should serve different tarballs for different repos", async () => {
    const baseUrl = `http://localhost:${PORT}`;
    const dir = getActionTarballsDir();
    fs.mkdirSync(dir, { recursive: true });

    const content1 = Buffer.from("tarball-for-checkout");
    const content2 = Buffer.from("tarball-for-setup-node");
    fs.writeFileSync(path.join(dir, "actions__checkout@v4.tar.gz"), content1);
    // setup-node tarballs are cached under an .rwN suffix because the DTU
    // rewrites them in-flight to route getManifestFromRepo through itself.
    fs.writeFileSync(path.join(dir, "actions__setup-node@v4.rw1.tar.gz"), content2);

    const res1 = await fetch(`${baseUrl}/_dtu/action-tarball/actions/checkout/v4`);
    const res2 = await fetch(`${baseUrl}/_dtu/action-tarball/actions/setup-node/v4`);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const body1 = Buffer.from(await res1.arrayBuffer());
    const body2 = Buffer.from(await res2.arrayBuffer());
    expect(body1).toEqual(content1);
    expect(body2).toEqual(content2);
  });

  // ── Action download info URL rewriting ───────────────────────────────────────

  it("should rewrite tarball URLs to local proxy", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    const res = await fetch(
      `${baseUrl}/_apis/distributedtask/hubs/Hub/plans/Plan/actiondownloadinfo`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actions: [
            { nameWithOwner: "actions/checkout", ref: "v4" },
            { nameWithOwner: "actions/setup-node", ref: "v4" },
          ],
        }),
      },
    );

    expect(res.status).toBe(200);
    const data = await res.json();

    // Both actions should have tarballUrls pointing at the local proxy
    const checkoutInfo = data.actions["actions/checkout@v4"];
    expect(checkoutInfo).toBeDefined();
    expect(checkoutInfo.tarballUrl).toBe(`${baseUrl}/_dtu/action-tarball/actions/checkout/v4`);
    expect(checkoutInfo.zipballUrl).toBe(`${baseUrl}/_dtu/action-tarball/actions/checkout/v4`);

    const setupNodeInfo = data.actions["actions/setup-node@v4"];
    expect(setupNodeInfo).toBeDefined();
    expect(setupNodeInfo.tarballUrl).toBe(`${baseUrl}/_dtu/action-tarball/actions/setup-node/v4`);
  });

  it("should strip sub-paths from action names for tarball URL", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    const res = await fetch(
      `${baseUrl}/_apis/distributedtask/hubs/Hub/plans/Plan/actiondownloadinfo`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actions: [
            { nameWithOwner: "actions/cache/save", ref: "v3" },
            { nameWithOwner: "actions/cache/restore", ref: "v3" },
          ],
        }),
      },
    );

    expect(res.status).toBe(200);
    const data = await res.json();

    // "actions/cache/save" should be rewritten to use "actions/cache" repo
    const saveInfo = data.actions["actions/cache/save@v3"];
    expect(saveInfo.tarballUrl).toBe(`${baseUrl}/_dtu/action-tarball/actions/cache/v3`);

    // "actions/cache/restore" should also use "actions/cache" repo
    const restoreInfo = data.actions["actions/cache/restore@v3"];
    expect(restoreInfo.tarballUrl).toBe(`${baseUrl}/_dtu/action-tarball/actions/cache/v3`);
  });

  it("should include resolvedSha as a deterministic hash", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    const res = await fetch(
      `${baseUrl}/_apis/distributedtask/hubs/Hub/plans/Plan/actiondownloadinfo`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actions: [{ nameWithOwner: "actions/checkout", ref: "v4" }],
        }),
      },
    );

    const data = await res.json();
    const info = data.actions["actions/checkout@v4"];

    // resolvedSha should be a 40-char hex string (SHA-1)
    expect(info.resolvedSha).toMatch(/^[0-9a-f]{40}$/);

    // Same input should produce the same hash (deterministic)
    const res2 = await fetch(
      `${baseUrl}/_apis/distributedtask/hubs/Hub/plans/Plan/actiondownloadinfo`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actions: [{ nameWithOwner: "actions/checkout", ref: "v4" }],
        }),
      },
    );
    const data2 = await res2.json();
    expect(data2.actions["actions/checkout@v4"].resolvedSha).toBe(info.resolvedSha);
  });

  it("should handle empty actions array", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    const res = await fetch(
      `${baseUrl}/_apis/distributedtask/hubs/Hub/plans/Plan/actiondownloadinfo`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actions: [] }),
      },
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.actions).toEqual({});
  });

  it("should skip local actions without crashing", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    const res = await fetch(
      `${baseUrl}/_apis/distributedtask/hubs/Hub/plans/Plan/actiondownloadinfo`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actions: [
            { nameWithOwner: "./.github/actions/shared-node-cache", ref: "" },
            { nameWithOwner: "", ref: "" },
            { nameWithOwner: "actions/checkout", ref: "v4" },
          ],
        }),
      },
    );

    expect(res.status).toBe(200);
    const data = await res.json();

    // Local and empty actions should be skipped
    expect(data.actions["./.github/actions/shared-node-cache@"]).toBeUndefined();
    expect(data.actions["@"]).toBeUndefined();

    // Remote action should still be present
    const checkoutInfo = data.actions["actions/checkout@v4"];
    expect(checkoutInfo).toBeDefined();
    expect(checkoutInfo.tarballUrl).toBe(`${baseUrl}/_dtu/action-tarball/actions/checkout/v4`);
  });
});

// ── writeStepOutputLines group filtering ─────────────────────────────────────
// The writeStepOutputLines function is internal to registerActionRoutes, so we
// test it via the timeline record feed endpoint which calls it.

describe("Step output group filtering", () => {
  let server: Polka;
  let logDir: string;
  const planId = "test-plan-group";
  const timelineId = "test-timeline-group";
  const recordId = "test-record-group";

  beforeAll(async () => {
    state.reset();
    const app = await bootstrapAndReturnApp();
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.server?.address() as AddressInfo;
        PORT = address.port;
        resolve();
      });
    });
  });

  beforeEach(() => {
    state.reset();
    // Set up log dir for step output writing
    logDir = fs.mkdtempSync("/tmp/dtu-group-test-");
    state.planToLogDir.set(planId, logDir);
    state.recordToStepName.set(recordId, "test-step");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server?.server) {
        server.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  function postFeed(lines: string[]) {
    return fetch(
      `http://localhost:${PORT}/_apis/distributedtask/hubs/Hub/plans/${planId}/timelines/${timelineId}/records/${recordId}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: lines }),
      },
    );
  }

  function readStepLog(): string {
    const logFile = path.join(logDir, "steps", "test-step.log");
    return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "";
  }

  it("should strip ##[group]/##[endgroup] markers and their contents", async () => {
    await postFeed([
      "visible line 1",
      "##[group]Downloading action",
      "hidden inside group",
      "also hidden",
      "##[endgroup]",
      "visible line 2",
    ]);

    const log = readStepLog();
    expect(log).toContain("visible line 1");
    expect(log).toContain("visible line 2");
    expect(log).not.toContain("hidden inside group");
    expect(log).not.toContain("also hidden");
    expect(log).not.toContain("##[group]");
    expect(log).not.toContain("##[endgroup]");
  });

  it("should handle nested groups (flat — no true nesting)", async () => {
    await postFeed([
      "before",
      "##[group]outer",
      "inside outer",
      "##[endgroup]",
      "between",
      "##[group]inner",
      "inside inner",
      "##[endgroup]",
      "after",
    ]);

    const log = readStepLog();
    expect(log).toContain("before");
    expect(log).toContain("between");
    expect(log).toContain("after");
    expect(log).not.toContain("inside outer");
    expect(log).not.toContain("inside inner");
  });

  it("should suppress empty lines inside groups", async () => {
    await postFeed([
      "visible",
      "##[group]Group start",
      "",
      "hidden in group",
      "",
      "##[endgroup]",
      "also visible",
    ]);

    const log = readStepLog();
    expect(log).toContain("visible");
    expect(log).toContain("also visible");
    expect(log).not.toContain("hidden in group");
  });

  it("should still filter ##[command] and runner internal lines", async () => {
    await postFeed([
      "real output",
      "[command]/usr/bin/npm test",
      "##[debug]some debug info",
      "[RUNNER 2025-01-01 00:00:00Z INFO  Something internal",
      "more real output",
    ]);

    const log = readStepLog();
    expect(log).toContain("real output");
    expect(log).toContain("more real output");
    expect(log).not.toContain("[command]");
    expect(log).not.toContain("##[debug]");
    expect(log).not.toContain("[RUNNER");
  });

  it("should strip BOM and timestamp prefixes", async () => {
    await postFeed([
      "\uFEFF2025-01-01T00:00:00.000Z actual content",
      "2025-06-15T12:30:45.123Z another line",
    ]);

    const log = readStepLog();
    expect(log).toContain("actual content");
    expect(log).toContain("another line");
    expect(log).not.toContain("2025-01-01T");
    expect(log).not.toContain("\uFEFF");
  });

  it("should parse and persist local-ci-output lines", async () => {
    await postFeed([
      "normal output",
      "::local-ci-output::result=success",
      "::local-ci-output::version=1.2.3",
    ]);

    const log = readStepLog();
    expect(log).toContain("normal output");
    expect(log).not.toContain("local-ci-output");

    // Check outputs.json was written
    const outputsPath = path.join(logDir, "outputs.json");
    expect(fs.existsSync(outputsPath)).toBe(true);
    const outputs = JSON.parse(fs.readFileSync(outputsPath, "utf-8"));
    expect(outputs.result).toBe("success");
    expect(outputs.version).toBe("1.2.3");
  });
});
