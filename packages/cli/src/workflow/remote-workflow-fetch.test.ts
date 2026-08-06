import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseRemoteRef,
  isShaRef,
  remoteCachePath,
  prefetchRemoteWorkflows,
} from "./remote-workflow-fetch.ts";

describe("parseRemoteRef", () => {
  it("parses owner/repo/path@ref", () => {
    const ref = parseRemoteRef("redwoodjs/actions/.github/workflows/lint.yml@main");
    expect(ref).toEqual({
      owner: "redwoodjs",
      repo: "actions",
      path: ".github/workflows/lint.yml",
      ref: "main",
      raw: "redwoodjs/actions/.github/workflows/lint.yml@main",
    });
  });

  it("parses SHA refs", () => {
    const ref = parseRemoteRef(
      "org/repo/.github/workflows/ci.yml@abc123def456abc123def456abc123def456abc1",
    );
    expect(ref).not.toBeNull();
    expect(ref!.ref).toBe("abc123def456abc123def456abc123def456abc1");
  });

  it("parses deeply nested paths", () => {
    const ref = parseRemoteRef("org/repo/some/deep/path/workflow.yml@v1");
    expect(ref).not.toBeNull();
    expect(ref!.path).toBe("some/deep/path/workflow.yml");
  });

  it("returns null for local refs", () => {
    expect(parseRemoteRef("./.github/workflows/lint.yml")).toBeNull();
  });

  it("returns null for missing @ref", () => {
    expect(parseRemoteRef("org/repo/.github/workflows/lint.yml")).toBeNull();
  });

  it("returns null for owner/repo@ref (no path)", () => {
    expect(parseRemoteRef("org/repo@v1")).toBeNull();
  });

  it("returns null for empty ref after @", () => {
    expect(parseRemoteRef("org/repo/path@")).toBeNull();
  });
});

describe("isShaRef", () => {
  it("returns true for 40-char hex", () => {
    expect(isShaRef("abc123def456abc123def456abc123def456abc1")).toBe(true);
  });

  it("returns true for uppercase hex", () => {
    expect(isShaRef("ABC123DEF456ABC123DEF456ABC123DEF456ABC1")).toBe(true);
  });

  it("returns false for short strings", () => {
    expect(isShaRef("abc123")).toBe(false);
  });

  it("returns false for tags", () => {
    expect(isShaRef("v1.0.0")).toBe(false);
  });

  it("returns false for branch names", () => {
    expect(isShaRef("main")).toBe(false);
  });
});

describe("remoteCachePath", () => {
  it("builds expected path", () => {
    const ref = parseRemoteRef("org/repo/.github/workflows/lint.yml@v1")!;
    const result = remoteCachePath("/cache", ref);
    expect(result).toBe("/cache/org__repo@v1/.github/workflows/lint.yml");
  });

  it("sanitizes special characters in ref", () => {
    const ref = parseRemoteRef("org/repo/.github/workflows/ci.yml@refs/heads/main")!;
    const result = remoteCachePath("/cache", ref);
    expect(result).toContain("org__repo@refs-heads-main");
  });
});

describe("prefetchRemoteWorkflows", () => {
  let tmpDir: string;
  let cacheDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-wf-test-"));
    cacheDir = path.join(tmpDir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    const wf = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(wf, content);
    return wf;
  }

  function mockFetchSuccess(yamlContent: string) {
    const base64Content = Buffer.from(yamlContent).toString("base64");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: base64Content, encoding: "base64" }),
    });
  }

  it("returns empty map when no remote refs", async () => {
    const wf = writeWorkflow(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`);
    const result = await prefetchRemoteWorkflows(wf, cacheDir);
    expect(result.size).toBe(0);
  });

  it("fetches remote workflow and writes to cache", async () => {
    const remoteYaml = `
on: workflow_call
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`;
    mockFetchSuccess(remoteYaml);

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/repo/.github/workflows/lint.yml@v1
`);

    const result = await prefetchRemoteWorkflows(wf, cacheDir);
    expect(result.size).toBe(1);
    expect(result.has("org/repo/.github/workflows/lint.yml@v1")).toBe(true);

    // Verify cached file was written
    const cachedPath = result.get("org/repo/.github/workflows/lint.yml@v1")!;
    expect(fs.existsSync(cachedPath)).toBe(true);
    expect(fs.readFileSync(cachedPath, "utf-8")).toBe(remoteYaml);
  });

  it("uses cache for SHA refs on subsequent calls", async () => {
    const sha = "abc123def456abc123def456abc123def456abc1";
    const remoteYaml = `
on: workflow_call
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`;
    mockFetchSuccess(remoteYaml);

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/repo/.github/workflows/lint.yml@${sha}
`);

    // First call fetches
    await prefetchRemoteWorkflows(wf, cacheDir);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Second call uses cache (SHA ref is immutable)
    const result = await prefetchRemoteWorkflows(wf, cacheDir);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // not called again
    expect(result.size).toBe(1);
  });

  it("re-fetches for tag/branch refs even when cached", async () => {
    const remoteYaml = `
on: workflow_call
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`;
    mockFetchSuccess(remoteYaml);

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/repo/.github/workflows/lint.yml@main
`);

    // First call fetches
    await prefetchRemoteWorkflows(wf, cacheDir);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Second call also fetches (branch ref is mutable)
    await prefetchRemoteWorkflows(wf, cacheDir);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("throws on 404 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/repo/.github/workflows/nonexistent.yml@v1
`);

    await expect(prefetchRemoteWorkflows(wf, cacheDir)).rejects.toThrow(
      /Remote workflow fetch failed/,
    );
  });

  it("throws on 404 with auth hint when no token provided (private repo hidden as 404)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/private-repo/.github/workflows/lint.yml@v1
`);

    await expect(prefetchRemoteWorkflows(wf, cacheDir)).rejects.toThrow(
      /repository or ref was not found/i,
    );
    await expect(prefetchRemoteWorkflows(wf, cacheDir)).rejects.toThrow(/gh auth login/);
    await expect(prefetchRemoteWorkflows(wf, cacheDir)).rejects.toThrow(/--github-token/);
  });

  it("throws on 404 with token-insufficient hint when githubToken is provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/private-repo/.github/workflows/lint.yml@v1
`);

    await expect(prefetchRemoteWorkflows(wf, cacheDir, "ghp_test123")).rejects.toThrow(
      /repository or ref was not found/i,
    );
    await expect(prefetchRemoteWorkflows(wf, cacheDir, "ghp_test123")).rejects.toThrow(
      /scope|contents: read|SSO/i,
    );
  });

  it("throws on 401 with auth hint", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/private-repo/.github/workflows/lint.yml@v1
`);

    await expect(prefetchRemoteWorkflows(wf, cacheDir)).rejects.toThrow(/--github-token/);
  });

  it("sends Authorization header when githubToken is provided", async () => {
    const remoteYaml = `
on: workflow_call
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`;
    mockFetchSuccess(remoteYaml);

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/repo/.github/workflows/lint.yml@v1
`);

    await prefetchRemoteWorkflows(wf, cacheDir, "ghp_test123");
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].headers["Authorization"]).toBe("token ghp_test123");
  });

  it("does not send Authorization header when no token provided", async () => {
    const remoteYaml = `
on: workflow_call
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`;
    mockFetchSuccess(remoteYaml);

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/repo/.github/workflows/lint.yml@v1
`);

    await prefetchRemoteWorkflows(wf, cacheDir);
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].headers["Authorization"]).toBeUndefined();
  });

  it("throws on 403 with auth hint mentioning --github-token and LOCAL_CI_GITHUB_TOKEN", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/private-repo/.github/workflows/lint.yml@v1
`);

    await expect(prefetchRemoteWorkflows(wf, cacheDir)).rejects.toThrow(/--github-token/);
    await expect(prefetchRemoteWorkflows(wf, cacheDir)).rejects.toThrow(/LOCAL_CI_GITHUB_TOKEN/);
  });

  it("throws on 401 with token-invalid hint when githubToken is provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/private-repo/.github/workflows/lint.yml@v1
`);

    const rejection = prefetchRemoteWorkflows(wf, cacheDir, "ghp_test123");
    await expect(rejection).rejects.toThrow(/invalid|expired|scope/i);
    await expect(prefetchRemoteWorkflows(wf, cacheDir, "ghp_test123")).rejects.not.toThrow(
      /--github-token/,
    );
  });

  it("throws on 403 with token-invalid hint when githubToken is provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/private-repo/.github/workflows/lint.yml@v1
`);

    const rejection = prefetchRemoteWorkflows(wf, cacheDir, "ghp_test123");
    await expect(rejection).rejects.toThrow(/invalid|expired|scope/i);
    await expect(prefetchRemoteWorkflows(wf, cacheDir, "ghp_test123")).rejects.not.toThrow(
      /--github-token/,
    );
  });

  it("succeeds fetching a public remote workflow without auth", async () => {
    const remoteYaml = `
on: workflow_call
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`;
    mockFetchSuccess(remoteYaml);

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/public-repo/.github/workflows/lint.yml@v1
`);

    // No githubToken passed — simulates public repo access without auth
    const result = await prefetchRemoteWorkflows(wf, cacheDir);
    expect(result.size).toBe(1);

    // Verify no Authorization header was sent
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[1].headers["Authorization"]).toBeUndefined();

    // Verify the cached file was written correctly
    const cachedPath = result.get("org/public-repo/.github/workflows/lint.yml@v1")!;
    expect(fs.existsSync(cachedPath)).toBe(true);
    expect(fs.readFileSync(cachedPath, "utf-8")).toBe(remoteYaml);
  });

  it("fetches multiple remote refs in parallel", async () => {
    const remoteYaml = `
on: workflow_call
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`;
    mockFetchSuccess(remoteYaml);

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: org/repo/.github/workflows/lint.yml@v1
  test:
    uses: org/repo/.github/workflows/test.yml@v1
`);

    const result = await prefetchRemoteWorkflows(wf, cacheDir);
    expect(result.size).toBe(2);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("skips local refs", async () => {
    mockFetchSuccess("unused");

    const wf = writeWorkflow(`
jobs:
  lint:
    uses: ./.github/workflows/lint.yml
`);

    const result = await prefetchRemoteWorkflows(wf, cacheDir);
    expect(result.size).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
