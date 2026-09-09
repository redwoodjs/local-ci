import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// ── writeGitShim ──────────────────────────────────────────────────────────────

describe("writeGitShim", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates an executable git shim with the correct SHA", async () => {
    const { writeGitShim } = await import("./git-shim.ts");
    const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    writeGitShim(tmpDir, sha);

    const shimPath = path.join(tmpDir, "git");
    expect(fs.existsSync(shimPath)).toBe(true);

    const content = fs.readFileSync(shimPath, "utf-8");
    expect(content).toContain("#!/bin/bash");
    expect(content).toContain(sha);
    expect(content).toContain("ls-remote");
    expect(content).toContain("git.real");

    // Check executable permission
    const stat = fs.statSync(shimPath);
    expect(stat.mode & 0o755).toBe(0o755);
  });

  it("includes all required interception clauses", async () => {
    const { writeGitShim } = await import("./git-shim.ts");
    writeGitShim(tmpDir, "abc");

    const content = fs.readFileSync(path.join(tmpDir, "git"), "utf-8");
    // All key interception points
    expect(content).toContain("config --local --get remote.origin.url");
    expect(content).toContain("ls-remote");
    expect(content).toContain("fetch");
    expect(content).toContain("rev-parse");
    expect(content).toContain("clean");
    expect(content).toContain("checkout");
    expect(content).toContain("pass-through");
  });

  it.each([false, true])(
    "creates FETCH_HEAD after fetch (existing commit: %s)",
    async (hasExistingCommit) => {
      const { writeGitShim } = await import("./git-shim.ts");
      const repository = path.join(tmpDir, "repository");
      const shims = path.join(tmpDir, "shims");
      fs.mkdirSync(repository);
      fs.mkdirSync(shims);
      fs.writeFileSync(path.join(repository, "example.txt"), "workspace\n");

      const realGit = fs.existsSync("/usr/bin/git.real")
        ? "/usr/bin/git.real"
        : spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
      const runGit = (args: string[]) =>
        spawnSync(realGit, args, { cwd: repository, encoding: "utf8" });
      expect(runGit(["init", "-q"]).status).toBe(0);
      if (hasExistingCommit) {
        expect(runGit(["add", "-A"]).status).toBe(0);
        expect(
          runGit([
            "-c",
            "user.name=local-ci",
            "-c",
            "user.email=local-ci@example.com",
            "commit",
            "-qm",
            "workspace",
          ]).status,
        ).toBe(0);
      }

      writeGitShim(shims, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
      const shim = path.join(shims, "git");
      const log = path.join(tmpDir, "git.log");
      fs.writeFileSync(
        shim,
        fs
          .readFileSync(shim, "utf8")
          .replaceAll("/usr/bin/git.real", realGit)
          .replaceAll("/home/runner/_diag/local-ci-git-calls.log", log),
      );

      const fetch = spawnSync(
        "bash",
        [shim, "fetch", "--no-tags", "--depth", "1", "origin", "example-branch"],
        { cwd: repository, encoding: "utf8" },
      );
      expect(fetch.stderr).toBe("");
      expect(fetch.status).toBe(0);

      const head = runGit(["rev-parse", "HEAD"]).stdout.trim();
      expect(fs.readFileSync(path.join(repository, ".git", "FETCH_HEAD"), "utf8").trim()).toBe(
        head,
      );
      expect(
        spawnSync("bash", [shim, "checkout", "-q", "--detach", "FETCH_HEAD"], {
          cwd: repository,
          encoding: "utf8",
        }).status,
      ).toBe(0);
    },
  );
});
