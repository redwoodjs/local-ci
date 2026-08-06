import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { state } from "./server/store.ts";
import { bootstrapAndReturnApp } from "./server/index.ts";
import { getBaseUrl } from "./server/routes/dtu.ts";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Polka } from "polka";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDtuLogPath } from "./server/logger.ts";

let PORT: number;
const TEST_CONTROL_TOKEN = "local-ci-test-control-token";

function isControlRequestPath(path: string): boolean {
  const cleanPath = path.split("?", 1)[0];
  return (
    cleanPath === "/_dtu/seed" || cleanPath === "/_dtu/start-runner" || cleanPath === "/_dtu/dump"
  );
}

async function requestToPort(
  port: number,
  method: string,
  path: string,
  body?: any,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port,
        path: path,
        method: method,
        headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode || 0,
              body: data ? JSON.parse(data) : null,
            });
          } catch {
            resolve({ status: res.statusCode || 0, body: data });
          }
        });
      },
    );

    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function request(
  method: string,
  path: string,
  body?: any,
  headers: Record<string, string> = {},
) {
  const controlHeaders =
    isControlRequestPath(path) && !headers["X-Agent-CI-DTU-Token"] && !headers.Authorization
      ? { "X-Agent-CI-DTU-Token": TEST_CONTROL_TOKEN }
      : {};
  return requestToPort(PORT, method, path, body, { ...controlHeaders, ...headers });
}

function createCompareFixtureRepo(): { tmpDir: string; repoDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-compare-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir);
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "a.txt"), "one\n");
  execFileSync("git", ["add", "a.txt"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "one"], { cwd: repoDir, stdio: "pipe" });
  fs.writeFileSync(path.join(repoDir, "a.txt"), "two\n");
  execFileSync("git", ["commit", "-am", "two"], { cwd: repoDir, stdio: "pipe" });
  return { tmpDir, repoDir };
}

describe("DTU Server", () => {
  let server: Polka;

  beforeAll(async () => {
    state.reset();
    const app = await bootstrapAndReturnApp({ controlToken: TEST_CONTROL_TOKEN });
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.server?.address() as AddressInfo;
        PORT = address.port;
        resolve();
      });
    });
  });

  beforeEach(() => {
    state.jobs.clear();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server && server.server) {
        server.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  it("should handle health check", async () => {
    const res = await request("GET", "/");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("online");
  });

  it("should seed a job", async () => {
    const job = { id: 123, name: "test-job" };
    const res = await request("POST", "/_dtu/seed", job);
    expect(res.status).toBe(201);
    expect(res.body.jobId).toBe("123");
    const storedJob = state.jobs.get("123");
    expect(storedJob.id).toBe(job.id);
    expect(storedJob.name).toBe(job.name);
  });

  it("should retrieve a seeded job", async () => {
    await request("POST", "/_dtu/seed", { id: 123, name: "test-job" });
    const res = await request("GET", "/repos/owner/repo/actions/jobs/123");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(123);
  });

  it("should handle missing job", async () => {
    const res = await request("GET", "/repos/owner/repo/actions/jobs/999");
    expect(res.status).toBe(404);
  });

  it("should handle installation lookup", async () => {
    const res = await request("GET", "/repos/owner/repo/installation");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(12345678);
    expect(res.body.access_tokens_url).toContain("/app/installations/12345678/access_tokens");
  });

  it("should handle access token exchange", async () => {
    const res = await request("POST", "/app/installations/12345678/access_tokens");
    expect(res.status).toBe(201);
    expect(res.body.token).toContain("ghs_mock_token_12345678");
  });

  it("should handle registration token generation", async () => {
    const res = await request("POST", "/repos/owner/repo/actions/runners/registration-token");
    expect(res.status).toBe(201);
    expect(res.body.token).toContain("ghr_mock_registration_token");
  });

  it("should compare commits without invoking a shell", async () => {
    const { tmpDir, repoDir } = createCompareFixtureRepo();
    try {
      await request("POST", "/_dtu/seed", { id: "compare", repoRoot: repoDir });

      const compareRes = await request("GET", "/repos/owner/repo/compare/HEAD~1...HEAD");
      expect(compareRes.status).toBe(200);
      expect(compareRes.body.files).toEqual([
        expect.objectContaining({ filename: "a.txt", status: "modified" }),
      ]);

      const markerPath = path.join(repoDir, "marker");
      const injectedRes = await request(
        "GET",
        "/repos/owner/repo/compare/HEAD~1...HEAD;touch${IFS}marker;",
      );
      expect(injectedRes.status).toBe(422);
      expect(fs.existsSync(markerPath)).toBe(false);

      const leadingDashRes = await request("GET", "/repos/owner/repo/compare/-bad...HEAD");
      expect(leadingDashRes.status).toBe(422);

      const malformedRes = await request(
        "GET",
        "/repos/owner/repo/compare/HEAD~1...HEAD...ignored",
      );
      expect(malformedRes.status).toBe(422);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should handle pipeline service discovery", async () => {
    const res = await request("GET", "/_apis/pipelines");
    expect(res.status).toBe(200);
    expect(res.body.locationServiceData).toBeDefined();
    expect(res.body.locationServiceData.serviceDefinitions).toBeDefined();
  });

  it("should handle global runner registration", async () => {
    const res = await request("POST", "/actions/runner-registration");
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.token_schema).toBe("OAuthAccessToken");
  });

  it("should handle session creation", async () => {
    const res = await request("POST", "/_apis/distributedtask/pools/1/sessions");
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeDefined();
    expect(res.body.agent.name).toBe("local-ci-runner");
  });

  it("should handle long polling for messages", async () => {
    // 1. Create a session first
    const sessionRes = await request("POST", "/_apis/distributedtask/pools/1/sessions");
    const sessionId = sessionRes.body.sessionId;

    // 2. Poll for messages (expecting 204 or 200 if job seeded)
    // We'll seed a job first to ensure 200
    await request("POST", "/_dtu/seed", { id: 456, name: "poll-job" });

    const pollRes = await request(
      "GET",
      `/_apis/distributedtask/pools/1/messages?sessionId=${sessionId}`,
    );
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.MessageType).toBe("PipelineAgentJobRequest");
    const body = JSON.parse(pollRes.body.Body);
    expect(body.JobDisplayName).toBe("poll-job");
  });

  it("should dispatch a job seeded AFTER polling begins (issue #47 race condition)", async () => {
    const runnerName = "local-ci-race-test";

    // 1. Register the runner with the DTU (so sessionToRunner mapping exists)
    await request("POST", "/_dtu/start-runner", {
      runnerName,
      logDir: "/tmp/local-ci-race-test-logs",
      timelineDir: "/tmp/local-ci-race-test-logs",
    });

    // 2. Create a session as this runner
    const sessionRes = await request("POST", "/_apis/distributedtask/pools/1/sessions", {
      agent: { name: runnerName },
    });
    const sessionId = sessionRes.body.sessionId;
    expect(sessionRes.status).toBe(200);

    // 3. Start the long-poll — this will block for up to 20s waiting for a job.
    //    The runner arrives BEFORE the job is seeded, exactly reproducing the race.
    const pollPromise = request(
      "GET",
      `/_apis/distributedtask/pools/1/messages?sessionId=${sessionId}`,
    );

    // 4. Give the event loop a tick so the poll handler registers in pendingPolls
    await new Promise((r) => setTimeout(r, 50));

    // 5. Now seed a job targeted at this runner — the seed handler should
    //    find the pending poll and dispatch immediately.
    const seedRes = await request("POST", "/_dtu/seed", {
      id: 999,
      name: "race-test-job",
      runnerName,
    });
    expect(seedRes.status).toBe(201);

    // 6. The poll should resolve almost instantly with the job (200),
    //    NOT after the 20s timeout (204).
    const pollRes = await pollPromise;
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.MessageType).toBe("PipelineAgentJobRequest");
    const body = JSON.parse(pollRes.body.Body);
    expect(body.JobDisplayName).toBe("race-test-job");
  }, 10_000);

  it("should dispatch jobs to 8 concurrent runners seeded after polling (--all mode stress)", async () => {
    const RUNNER_COUNT = 8;
    const runners: Array<{ name: string; sessionId: string }> = [];

    // 1. Register and create sessions for all runners
    for (let i = 0; i < RUNNER_COUNT; i++) {
      const name = `local-ci-stress-${i + 1}`;
      await request("POST", "/_dtu/start-runner", {
        runnerName: name,
        logDir: `/tmp/local-ci-stress-${i + 1}-logs`,
        timelineDir: `/tmp/local-ci-stress-${i + 1}-logs`,
      });
      const sessionRes = await request("POST", "/_apis/distributedtask/pools/1/sessions", {
        agent: { name },
      });
      runners.push({ name, sessionId: sessionRes.body.sessionId });
    }

    // 2. Start all polls concurrently — all runners are waiting before any job is seeded
    const pollPromises = runners.map((r) =>
      request("GET", `/_apis/distributedtask/pools/1/messages?sessionId=${r.sessionId}`),
    );

    // 3. Let the polls register in pendingPolls
    await new Promise((r) => setTimeout(r, 100));

    // 4. Seed all jobs with staggered timing (simulating concurrent executeLocalJob calls)
    for (let i = 0; i < RUNNER_COUNT; i++) {
      await request("POST", "/_dtu/seed", {
        id: 2000 + i,
        name: `stress-job-${i + 1}`,
        runnerName: runners[i].name,
      });
      // Small stagger like real concurrent CLI calls
      if (i < RUNNER_COUNT - 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    // 5. ALL polls should resolve with 200 (their specific job), not 204
    const pollResults = await Promise.all(pollPromises);
    for (let i = 0; i < RUNNER_COUNT; i++) {
      expect(pollResults[i].status).toBe(200);
      expect(pollResults[i].body.MessageType).toBe("PipelineAgentJobRequest");
      const body = JSON.parse(pollResults[i].body.Body);
      expect(body.JobDisplayName).toBe(`stress-job-${i + 1}`);
    }
  }, 15_000);

  it("should NOT let runner B steal runner A's job from the generic pool (issue #47)", async () => {
    // This reproduces the core race in --all mode:
    // 1. Job for runner A is seeded
    // 2. Runner B creates a session and polls BEFORE its own job is seeded
    // 3. BUG: Runner B falls through to the generic state.jobs pool and steals A's job
    // 4. Runner B's actual job arrives later, but A's real runner never gets its job

    const runnerA = "local-ci-runner-A";
    const runnerB = "local-ci-runner-B";

    // Register both runners
    await request("POST", "/_dtu/start-runner", {
      runnerName: runnerA,
      logDir: "/tmp/local-ci-A-logs",
      timelineDir: "/tmp/local-ci-A-logs",
    });
    await request("POST", "/_dtu/start-runner", {
      runnerName: runnerB,
      logDir: "/tmp/local-ci-B-logs",
      timelineDir: "/tmp/local-ci-B-logs",
    });

    // Seed runner A's job
    await request("POST", "/_dtu/seed", {
      id: 3001,
      name: "job-for-A",
      runnerName: runnerA,
    });

    // Runner B creates a session and polls — its job hasn't been seeded yet.
    const sessionB = await request("POST", "/_apis/distributedtask/pools/1/sessions", {
      agent: { name: runnerB },
    });
    const pollBPromise = request(
      "GET",
      `/_apis/distributedtask/pools/1/messages?sessionId=${sessionB.body.sessionId}`,
    );

    // Wait 200ms — if B stole A's job, the poll would have resolved instantly.
    let pollBResolved = false;
    pollBPromise.then(() => {
      pollBResolved = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(pollBResolved).toBe(false); // B should still be long-polling, NOT holding A's job

    // Now seed runner B's actual job — this unblocks B's long-poll via notify-on-seed
    await request("POST", "/_dtu/seed", {
      id: 3002,
      name: "job-for-B",
      runnerName: runnerB,
    });

    // B should now receive its own job
    const pollB = await pollBPromise;
    expect(pollB.status).toBe(200);
    const bodyB = JSON.parse(pollB.body.Body);
    expect(bodyB.JobDisplayName).toBe("job-for-B");

    // Runner A should still get its own job (not stolen)
    const sessionA = await request("POST", "/_apis/distributedtask/pools/1/sessions", {
      agent: { name: runnerA },
    });
    const pollA = await request(
      "GET",
      `/_apis/distributedtask/pools/1/messages?sessionId=${sessionA.body.sessionId}`,
    );
    expect(pollA.status).toBe(200);
    const bodyA = JSON.parse(pollA.body.Body);
    expect(bodyA.JobDisplayName).toBe("job-for-A");
  }, 10_000);

  it("should log unhandled requests to 404.log", async () => {
    const logDir = path.dirname(getDtuLogPath());
    const logFile = path.join(logDir, "404.log");

    // Clean up any existing 404.log
    if (fs.existsSync(logFile)) {
      fs.unlinkSync(logFile);
    }

    const res = await request("POST", "/some/unhandled/route", { test: "payload" });
    expect(res.status).toBe(404);

    // Give the file writing a tiny bit of time to complete if needed,
    // though appendFileSync is synchronous.
    expect(fs.existsSync(logFile)).toBe(true);
    const logContent = fs.readFileSync(logFile, "utf-8");

    expect(logContent).toContain("404 Not Found: POST /some/unhandled/route");
    expect(logContent).toContain("Body (parsed JSON)");
    expect(logContent).toContain('"test": "payload"');
  });
});

describe("DTU control endpoints hardening", () => {
  let server: Polka;
  let port: number;
  let allowedLogRoot: string;
  const controlToken = "test-control-token";

  beforeAll(async () => {
    state.reset();
    allowedLogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-control-logs-"));
    const app = await bootstrapAndReturnApp({
      reset: false,
      controlToken,
      allowedLogRoot,
    });
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.server?.address() as AddressInfo;
        port = address.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server && server.server) {
        server.server.close(() => resolve());
      } else {
        resolve();
      }
    });
    fs.rmSync(allowedLogRoot, { recursive: true, force: true });
  });

  it("should protect control endpoints even when no token is configured", async () => {
    const app = await bootstrapAndReturnApp({ reset: false });
    let randomTokenServer: Polka | undefined;
    const randomTokenPort = await new Promise<number>((resolve) => {
      randomTokenServer = app.listen(0, () => {
        const address = randomTokenServer!.server?.address() as AddressInfo;
        resolve(address.port);
      });
    });

    try {
      const unauthorized = await requestToPort(randomTokenPort, "POST", "/_dtu/seed", {
        id: "default-token-blocked",
      });
      expect(unauthorized.status).toBe(401);
      expect(state.jobs.has("default-token-blocked")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => randomTokenServer!.server?.close(() => resolve()));
    }
  });

  it("should require a control token for internal DTU endpoints", async () => {
    const unauthorizedSeed = await requestToPort(port, "POST", "/_dtu/seed", { id: "blocked" });
    expect(unauthorizedSeed.status).toBe(401);

    const unauthorizedStart = await requestToPort(port, "POST", "/_dtu/start-runner", {
      runnerName: "blocked-runner",
      logDir: path.join(allowedLogRoot, "blocked-runner"),
    });
    expect(unauthorizedStart.status).toBe(401);
    expect(state.runnerLogs.has("blocked-runner")).toBe(false);

    const unauthorizedDump = await requestToPort(port, "GET", "/_dtu/dump");
    expect(unauthorizedDump.status).toBe(401);

    const trailingSeed = await requestToPort(port, "POST", "/_dtu/seed/", {
      id: "trailing-blocked",
    });
    expect(trailingSeed.status).toBe(401);
    expect(state.jobs.has("trailing-blocked")).toBe(false);

    const trailingStart = await requestToPort(port, "POST", "/_dtu/start-runner/", {
      runnerName: "trailing-blocked-runner",
      logDir: path.join(allowedLogRoot, "trailing-blocked-runner"),
    });
    expect(trailingStart.status).toBe(401);
    expect(state.runnerLogs.has("trailing-blocked-runner")).toBe(false);

    const trailingDump = await requestToPort(port, "GET", "/_dtu/dump/");
    expect(trailingDump.status).toBe(401);

    const wrongToken = await requestToPort(
      port,
      "POST",
      "/_dtu/seed",
      { id: "wrong-token" },
      { "X-Agent-CI-DTU-Token": "wrong-token" },
    );
    expect(wrongToken.status).toBe(401);
    expect(state.jobs.has("wrong-token")).toBe(false);

    const authorized = await requestToPort(
      port,
      "POST",
      "/_dtu/seed",
      { id: "allowed" },
      { "X-Agent-CI-DTU-Token": controlToken },
    );
    expect(authorized.status).toBe(201);
    expect(state.jobs.has("allowed")).toBe(true);

    const bearerAuthorized = await requestToPort(port, "GET", "/_dtu/dump", undefined, {
      Authorization: `Bearer ${controlToken}`,
    });
    expect(bearerAuthorized.status).toBe(200);
  });

  it("should reject runner log paths outside the allowed log root", async () => {
    const outside = path.join(os.tmpdir(), "local-ci-outside-logs");
    const rejected = await requestToPort(
      port,
      "POST",
      "/_dtu/start-runner",
      { runnerName: "runner-a", logDir: outside, timelineDir: outside },
      { "X-Agent-CI-DTU-Token": controlToken },
    );
    expect(rejected.status).toBe(400);

    const inside = path.join(allowedLogRoot, "runner-a");
    const accepted = await requestToPort(
      port,
      "POST",
      "/_dtu/start-runner",
      { runnerName: "runner-a", logDir: inside, timelineDir: inside },
      { "X-Agent-CI-DTU-Token": controlToken },
    );
    expect(accepted.status).toBe(200);
    expect(state.runnerLogs.get("runner-a")).toBe(inside);
  });

  it("should validate all runner paths before changing state", async () => {
    const logDir = path.join(allowedLogRoot, "atomic-runner");
    const outside = path.join(os.tmpdir(), "local-ci-atomic-outside");
    const rejected = await requestToPort(
      port,
      "POST",
      "/_dtu/start-runner",
      { runnerName: "atomic-runner", logDir, timelineDir: outside },
      { "X-Agent-CI-DTU-Token": controlToken },
    );

    expect(rejected.status).toBe(400);
    expect(state.runnerLogs.has("atomic-runner")).toBe(false);
    expect(state.runnerTimelineDirs.has("atomic-runner")).toBe(false);
    expect(fs.existsSync(logDir)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "should reject log paths through symlinks outside the root",
    async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-symlink-outside-"));
      const link = path.join(allowedLogRoot, "outside-link");
      fs.symlinkSync(outside, link);

      try {
        const rejected = await requestToPort(
          port,
          "POST",
          "/_dtu/start-runner",
          { runnerName: "symlink-runner", logDir: path.join(link, "logs") },
          { "X-Agent-CI-DTU-Token": controlToken },
        );
        expect(rejected.status).toBe(400);
        expect(state.runnerLogs.has("symlink-runner")).toBe(false);
      } finally {
        fs.rmSync(link, { force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});

// ── Artifact v4 upload / download (Twirp + Azure Block Blob protocol) ──────────
describe("Artifact v4 upload/download", () => {
  let server: any;

  beforeAll(async () => {
    state.reset();
    const app = await bootstrapAndReturnApp({ controlToken: TEST_CONTROL_TOKEN });
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.server?.address() as import("node:net").AddressInfo;
        PORT = address.port;
        resolve();
      });
    });
  });

  beforeEach(() => {
    state.reset();
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

  it("getBaseUrl strips \\r and \\n from Host header (direct unit test)", () => {
    // Node.js's own http client validates headers and won't let us send \r via HTTP.
    // So we test getBaseUrl() directly with a mock request object — this is the
    // exact same path the runner hits when it sends a dirty Host header.
    // Root cause: HTTP/1.1 runners can include a trailing \r in the Host header
    // (part of the \r\n line terminator). If we embed it in the signed URL, the
    // @actions/artifact toolkit triggers "Parse Error: Invalid header value char".
    const mockReq = { headers: { host: `localhost:${PORT}\r`, "x-forwarded-proto": undefined } };
    const url = getBaseUrl(mockReq);

    expect(url).not.toMatch(/[\r\n]/);
    expect(url).toBe(`http://localhost:${PORT}`);

    // Also test \n and mixed whitespace variants
    const mockReq2 = { headers: { host: `  127.0.0.1:8910\r\n  `, "x-forwarded-proto": "http" } };
    const url2 = getBaseUrl(mockReq2);
    expect(url2).not.toMatch(/[\r\n]/);
    expect(url2).toBe("http://127.0.0.1:8910");
  });

  it("full v4 artifact lifecycle: create → block upload → commit → finalize → download", async () => {
    const baseUrl = `http://localhost:${PORT}`;
    const artifactName = "my-v4-artifact";
    const fileContent = Buffer.from("hello from artifact v4!");

    // 1. CreateArtifact (Twirp)
    let res = await fetch(
      `${baseUrl}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: artifactName, version: 4 }),
      },
    );
    expect(res.status).toBe(200);
    const { signedUploadUrl } = (await res.json()) as { signedUploadUrl: string };
    expect(signedUploadUrl).toMatch(/\/_apis\/artifactblob\//);
    // Crucially, no rogue characters
    expect(signedUploadUrl).not.toMatch(/[\r\n]/);

    // Extract containerId from the URL
    const containerIdMatch = signedUploadUrl.match(/\/artifactblob\/(\d+)\//);
    expect(containerIdMatch).toBeTruthy();
    const _containerId = containerIdMatch![1];

    // 2. Upload a block (Azure Block Blob protocol: PUT ?comp=block&blockid=X)
    const blockId = Buffer.from("block-0001").toString("base64url");
    res = await fetch(`${signedUploadUrl}?comp=block&blockid=${blockId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: fileContent,
    });
    expect(res.status).toBe(201);

    // 3. Commit the block list (PUT ?comp=blocklist with XML body)
    const blockListXml = `<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>${blockId}</Latest></BlockList>`;
    res = await fetch(`${signedUploadUrl}?comp=blocklist`, {
      method: "PUT",
      headers: { "Content-Type": "application/xml" },
      body: blockListXml,
    });
    expect(res.status).toBe(201);

    // 4. FinalizeArtifact (Twirp)
    res = await fetch(
      `${baseUrl}/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: artifactName }),
      },
    );
    expect(res.status).toBe(200);
    const finalizeBody = (await res.json()) as { ok: boolean; artifactId: string };
    expect(finalizeBody.ok).toBe(true);

    // 5. GetSignedArtifactURL (Twirp)
    res = await fetch(
      `${baseUrl}/twirp/github.actions.results.api.v1.ArtifactService/GetSignedArtifactURL`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: artifactName }),
      },
    );
    expect(res.status).toBe(200);
    const { signedUrl } = (await res.json()) as { signedUrl: string };
    expect(signedUrl).toMatch(/\/_apis\/artifactblob\//);
    expect(signedUrl).not.toMatch(/[\r\n]/);

    // 6. Download the blob and verify content roundtrips
    res = await fetch(signedUrl);
    expect(res.status).toBe(200);
    const downloaded = Buffer.from(await res.arrayBuffer());
    expect(downloaded).toEqual(fileContent);
  });

  it("ListArtifacts returns uploaded artifacts", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    // Create + finalize an artifact
    let res = await fetch(
      `${baseUrl}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "list-test-artifact", version: 4 }),
      },
    );
    const { signedUploadUrl } = (await res.json()) as { signedUploadUrl: string };

    // Single-block (no comp param) upload
    await fetch(signedUploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("data"),
    });

    res = await fetch(
      `${baseUrl}/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "list-test-artifact" }),
      },
    );
    expect(res.status).toBe(200);

    // ListArtifacts with name filter
    res = await fetch(
      `${baseUrl}/twirp/github.actions.results.api.v1.ArtifactService/ListArtifacts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nameFilter: "list-test-artifact" }),
      },
    );
    expect(res.status).toBe(200);
    const { artifacts } = (await res.json()) as { artifacts: any[] };
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].name).toBe("list-test-artifact");
  });

  it("should handle job request renewal on bare path (actual runner behavior)", async () => {
    const res = await request("PATCH", "/_apis/distributedtask/jobrequests", {
      requestId: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.lockedUntil).toBeDefined();
    expect(new Date(res.body.lockedUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it("should handle job request renewal on parameterized path", async () => {
    const res = await request("PATCH", "/_apis/distributedtask/jobrequests/1", {
      requestId: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.lockedUntil).toBeDefined();
    expect(new Date(res.body.lockedUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it("should let runner B steal runner A's job when seeded WITHOUT runnerName (generic pool bug)", async () => {
    // REPRODUCTION for issue #103:
    // When local-job.ts seeds a job without setting runnerName, the job lands
    // in the generic state.jobs pool. If another runner (from a different
    // concurrent workflow) polls before runner A, it steals the job — causing
    // runner A to hang forever waiting for a job that will never arrive.

    const runnerA = "local-ci-repro-A";
    const runnerB = "local-ci-repro-B";

    // Register both runners
    await request("POST", "/_dtu/start-runner", {
      runnerName: runnerA,
      logDir: "/tmp/local-ci-repro-A-logs",
      timelineDir: "/tmp/local-ci-repro-A-logs",
    });
    await request("POST", "/_dtu/start-runner", {
      runnerName: runnerB,
      logDir: "/tmp/local-ci-repro-B-logs",
      timelineDir: "/tmp/local-ci-repro-B-logs",
    });

    // Seed a job intended for runner A, but WITHOUT runnerName (the bug).
    // This goes into the generic state.jobs pool.
    await request("POST", "/_dtu/seed", {
      id: 4001,
      name: "job-intended-for-A",
      // BUG: no runnerName — job lands in generic pool
    });

    // Runner B creates a session and polls — it shouldn't get A's job,
    // but because the job is in the generic pool, B steals it.
    const sessionB = await request("POST", "/_apis/distributedtask/pools/1/sessions", {
      agent: { name: runnerB },
    });
    const pollB = await request(
      "GET",
      `/_apis/distributedtask/pools/1/messages?sessionId=${sessionB.body.sessionId}`,
    );

    // BUG CONFIRMED: runner B stole the job from the generic pool
    expect(pollB.status).toBe(200);
    const bodyB = JSON.parse(pollB.body.Body);
    expect(bodyB.JobDisplayName).toBe("job-intended-for-A");

    // Now runner A creates a session and polls — the job is gone
    await request("POST", "/_apis/distributedtask/pools/1/sessions", {
      agent: { name: runnerA },
    });

    // Runner A's poll will hang (long-poll timeout) because its job was stolen.
    // We verify by checking state: no jobs remain for A.
    const aHasJob = state.runnerJobs.has(runnerA) || state.jobs.size > 0;
    expect(aHasJob).toBe(false); // A's job is gone — it will hang forever
  }, 10_000);

  it("should handle job request finish (PATCH with result + finishTime)", async () => {
    const finishTime = new Date().toISOString();
    const res = await request("PATCH", "/_apis/distributedtask/jobrequests", {
      requestId: 1,
      result: "succeeded",
      finishTime,
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("succeeded");
    expect(res.body.finishTime).toBe(finishTime);
    // Finish requests should NOT get lockedUntil injected
    expect(res.body.lockedUntil).toBeUndefined();
  });
});
