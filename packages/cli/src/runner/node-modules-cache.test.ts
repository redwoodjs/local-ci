import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  NODE_MODULES_CACHE_SCHEMA,
  cloneDependencyTree,
  dependencyCacheMode,
  isDependencyCacheComplete,
  publishDependencyCache,
  pruneAbandonedDependencyCacheEntries,
  readDependencyCacheManifest,
  resolveDependencyCacheDir,
  restoreDependencyCache,
} from "./node-modules-cache.ts";

describe("node_modules dependency cache", () => {
  let tmpDir: string;
  let sourceNodeModules: string;
  let cacheDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-node-modules-cache-"));
    sourceNodeModules = path.join(tmpDir, "source", "node_modules");
    cacheDir = path.join(tmpDir, "cache", "node-modules-v2", "org-repo", "pnpm", "abc");
    fs.mkdirSync(path.join(sourceNodeModules, "package-a", "bin"), { recursive: true });
    fs.writeFileSync(path.join(sourceNodeModules, "package-a", "index.js"), "original\n");
    fs.writeFileSync(path.join(sourceNodeModules, "package-a", "bin", "cli"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    fs.symlinkSync("../package-a/bin/cli", path.join(sourceNodeModules, ".package-a-cli"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses download-only caching for npm and snapshots for other managers", () => {
    expect(dependencyCacheMode("npm")).toBe("download-only");
    expect(dependencyCacheMode("pnpm")).toBe("snapshot");
    expect(dependencyCacheMode("yarn")).toBe("snapshot");
    expect(dependencyCacheMode("bun")).toBe("snapshot");
  });

  it("uses a versioned package-manager and lockfile scoped path", () => {
    expect(
      resolveDependencyCacheDir("/work", "org-repo", {
        packageManager: "pnpm",
        lockfileHash: "abc123",
      }),
    ).toBe(path.resolve("/work/cache/node-modules-v2/org-repo/pnpm/abc123"));
  });

  it("does not accept package-manager sentinels as completion markers", () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, ".package-lock.json"), "{}");
    fs.writeFileSync(path.join(cacheDir, ".modules.yaml"), "ok");

    expect(isDependencyCacheComplete(cacheDir)).toBe(false);
  });

  it("rejects a manifest whose snapshot tree is missing", () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "complete.json"),
      JSON.stringify({
        schemaVersion: NODE_MODULES_CACHE_SCHEMA,
        packageManager: "pnpm",
        lockfileHash: "abc",
        mode: "snapshot",
        createdAt: new Date().toISOString(),
      }),
    );

    expect(readDependencyCacheManifest(cacheDir)).toBeUndefined();
  });

  it("publishes an immutable snapshot and restores isolated job copies", async () => {
    const published = await publishDependencyCache({
      cacheDir,
      sourceNodeModules,
      identity: { packageManager: "pnpm", lockfileHash: "abc" },
    });

    expect(published.published).toBe(true);
    expect(published.mode).toBe("snapshot");
    expect(isDependencyCacheComplete(cacheDir)).toBe(true);

    const first = path.join(tmpDir, "job-a", "node_modules");
    const second = path.join(tmpDir, "job-b", "node_modules");
    expect(restoreDependencyCache(cacheDir, first).restored).toBe(true);
    expect(restoreDependencyCache(cacheDir, second).restored).toBe(true);

    fs.writeFileSync(path.join(first, "package-a", "index.js"), "changed\n");
    fs.rmSync(path.join(first, "package-a", "bin"), { recursive: true });

    expect(fs.readFileSync(path.join(second, "package-a", "index.js"), "utf8")).toBe("original\n");
    expect(
      fs.readFileSync(path.join(cacheDir, "node_modules", "package-a", "index.js"), "utf8"),
    ).toBe("original\n");
    expect(fs.existsSync(path.join(second, "package-a", "bin", "cli"))).toBe(true);
    expect(fs.lstatSync(path.join(second, ".package-a-cli")).isSymbolicLink()).toBe(true);
    expect(fs.statSync(path.join(second, "package-a", "bin", "cli")).mode & 0o111).not.toBe(0);
  });

  it("allows only one concurrent publisher to promote a snapshot", async () => {
    const results = await Promise.all([
      publishDependencyCache({
        cacheDir,
        sourceNodeModules,
        identity: { packageManager: "pnpm", lockfileHash: "abc" },
      }),
      publishDependencyCache({
        cacheDir,
        sourceNodeModules,
        identity: { packageManager: "pnpm", lockfileHash: "abc" },
      }),
    ]);

    expect(results.filter((result) => result.published)).toHaveLength(1);
    expect(results.filter((result) => result.reason === "already-complete")).toHaveLength(1);
    expect(isDependencyCacheComplete(cacheDir)).toBe(true);
  });

  it("does not overwrite an existing complete snapshot", async () => {
    await publishDependencyCache({
      cacheDir,
      sourceNodeModules,
      identity: { packageManager: "pnpm", lockfileHash: "abc" },
    });
    fs.writeFileSync(path.join(sourceNodeModules, "package-a", "index.js"), "new\n");

    const secondPublish = await publishDependencyCache({
      cacheDir,
      sourceNodeModules,
      identity: { packageManager: "pnpm", lockfileHash: "abc" },
    });

    expect(secondPublish).toMatchObject({ published: false, reason: "already-complete" });
    expect(
      fs.readFileSync(path.join(cacheDir, "node_modules", "package-a", "index.js"), "utf8"),
    ).toBe("original\n");
  });

  it("records npm as download-only without copying node_modules", async () => {
    const npmCacheDir = path.join(tmpDir, "cache", "node-modules-v2", "org-repo", "npm", "def");
    const published = await publishDependencyCache({
      cacheDir: npmCacheDir,
      sourceNodeModules,
      identity: { packageManager: "npm", lockfileHash: "def" },
    });

    expect(published).toMatchObject({ published: true, mode: "download-only" });
    expect(fs.existsSync(path.join(npmCacheDir, "node_modules"))).toBe(false);
    expect(restoreDependencyCache(npmCacheDir, path.join(tmpDir, "npm-job"))).toMatchObject({
      restored: false,
      mode: "download-only",
    });
  });

  it("does not publish when no installation produced node_modules", async () => {
    const result = await publishDependencyCache({
      cacheDir,
      sourceNodeModules: path.join(tmpDir, "missing"),
      identity: { packageManager: "pnpm", lockfileHash: "abc" },
    });

    expect(result).toMatchObject({ published: false, reason: "missing-node-modules" });
    expect(isDependencyCacheComplete(cacheDir)).toBe(false);
  });

  it("prunes abandoned staging directories without deleting completed snapshots", async () => {
    await publishDependencyCache({
      cacheDir,
      sourceNodeModules,
      identity: { packageManager: "pnpm", lockfileHash: "abc" },
    });
    const stagingDir = `${cacheDir}.staging-abandoned`;
    fs.mkdirSync(stagingDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(stagingDir, old, old);

    pruneAbandonedDependencyCacheEntries(path.dirname(cacheDir), 1_000);

    expect(fs.existsSync(stagingDir)).toBe(false);
    expect(isDependencyCacheComplete(cacheDir)).toBe(true);
  });

  it("clone fallback copies without sharing mutable files", () => {
    const destination = path.join(tmpDir, "fallback", "node_modules");
    expect(cloneDependencyTree(sourceNodeModules, destination, "unsupported")).toBe("copy");

    fs.writeFileSync(path.join(destination, "package-a", "index.js"), "changed\n");
    expect(fs.readFileSync(path.join(sourceNodeModules, "package-a", "index.js"), "utf8")).toBe(
      "original\n",
    );
  });
});
