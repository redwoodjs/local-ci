import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  discoverRunnerImage,
  detectMissingToolHint,
  detectToolcacheHint,
  UPSTREAM_RUNNER_IMAGE,
  type ResolvedRunnerImage,
} from "./runner-image.ts";

describe("discoverRunnerImage", () => {
  let repoDir: string;
  const originalEnv = process.env.LOCAL_CI_RUNNER_IMAGE;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-image-test-"));
    delete process.env.LOCAL_CI_RUNNER_IMAGE;
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.LOCAL_CI_RUNNER_IMAGE;
    } else {
      process.env.LOCAL_CI_RUNNER_IMAGE = originalEnv;
    }
  });

  it("falls back to upstream when nothing is configured", () => {
    const r = discoverRunnerImage(repoDir);
    expect(r.image).toBe(UPSTREAM_RUNNER_IMAGE);
    expect(r.source).toBe("default");
    expect(r.needsBuild).toBe(false);
  });

  it("respects LOCAL_CI_RUNNER_IMAGE env var as highest priority", () => {
    fs.mkdirSync(path.join(repoDir, ".github"));
    fs.writeFileSync(
      path.join(repoDir, ".github", "local-ci.Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\n",
    );
    process.env.LOCAL_CI_RUNNER_IMAGE = "my-org/custom:v1";

    const r = discoverRunnerImage(repoDir);
    expect(r.image).toBe("my-org/custom:v1");
    expect(r.source).toBe("env");
    expect(r.needsBuild).toBe(false);
  });

  it("discovers simple form .github/local-ci.Dockerfile", () => {
    fs.mkdirSync(path.join(repoDir, ".github"));
    fs.writeFileSync(
      path.join(repoDir, ".github", "local-ci.Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nRUN echo hi\n",
    );

    const r = discoverRunnerImage(repoDir);
    expect(r.source).toBe("dockerfile-file");
    expect(r.needsBuild).toBe(true);
    expect(r.image).toMatch(/^local-ci-runner:[0-9a-f]{12}$/);
    expect(r.dockerfilePath).toBe(path.join(repoDir, ".github", "local-ci.Dockerfile"));
    expect(r.contextDir).toBeUndefined();
  });

  it("discovers directory form .github/local-ci/Dockerfile with context", () => {
    fs.mkdirSync(path.join(repoDir, ".github", "local-ci"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".github", "local-ci", "Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nCOPY ca.pem /etc/\n",
    );
    fs.writeFileSync(path.join(repoDir, ".github", "local-ci", "ca.pem"), "fake-cert");

    const r = discoverRunnerImage(repoDir);
    expect(r.source).toBe("dockerfile-dir");
    expect(r.needsBuild).toBe(true);
    expect(r.image).toMatch(/^local-ci-runner:[0-9a-f]{12}$/);
    expect(r.contextDir).toBe(path.join(repoDir, ".github", "local-ci"));
  });

  it("supports the legacy .github/agent-ci.Dockerfile path", () => {
    fs.mkdirSync(path.join(repoDir, ".github"));
    const dockerfile = path.join(repoDir, ".github", "agent-ci.Dockerfile");
    fs.writeFileSync(dockerfile, "FROM ghcr.io/actions/actions-runner:latest\n");

    const result = discoverRunnerImage(repoDir);

    expect(result.source).toBe("dockerfile-file");
    expect(result.dockerfilePath).toBe(dockerfile);
  });

  it("prefers Local CI runner configuration over legacy Agent CI configuration", () => {
    fs.mkdirSync(path.join(repoDir, ".github"));
    const canonical = path.join(repoDir, ".github", "local-ci.Dockerfile");
    fs.writeFileSync(canonical, "FROM ghcr.io/actions/actions-runner:latest\n");
    fs.writeFileSync(
      path.join(repoDir, ".github", "agent-ci.Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nRUN echo legacy\n",
    );

    const result = discoverRunnerImage(repoDir);

    expect(result.dockerfilePath).toBe(canonical);
  });

  it("directory form takes precedence over simple form", () => {
    fs.mkdirSync(path.join(repoDir, ".github", "local-ci"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".github", "local-ci", "Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\n",
    );
    fs.writeFileSync(
      path.join(repoDir, ".github", "local-ci.Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nRUN echo wrong\n",
    );

    const r = discoverRunnerImage(repoDir);
    expect(r.source).toBe("dockerfile-dir");
  });

  it("hash is stable across identical contents", () => {
    fs.mkdirSync(path.join(repoDir, ".github"));
    const contents = "FROM ghcr.io/actions/actions-runner:latest\nRUN echo stable\n";
    fs.writeFileSync(path.join(repoDir, ".github", "local-ci.Dockerfile"), contents);
    const r1 = discoverRunnerImage(repoDir);

    // Overwrite with the same contents
    fs.writeFileSync(path.join(repoDir, ".github", "local-ci.Dockerfile"), contents);
    const r2 = discoverRunnerImage(repoDir);

    expect(r1.image).toBe(r2.image);
  });

  it("hash changes when Dockerfile contents change", () => {
    fs.mkdirSync(path.join(repoDir, ".github"));
    fs.writeFileSync(
      path.join(repoDir, ".github", "local-ci.Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nRUN echo a\n",
    );
    const r1 = discoverRunnerImage(repoDir);

    fs.writeFileSync(
      path.join(repoDir, ".github", "local-ci.Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nRUN echo b\n",
    );
    const r2 = discoverRunnerImage(repoDir);

    expect(r1.image).not.toBe(r2.image);
  });

  it("hash changes when a context file changes (directory form)", () => {
    fs.mkdirSync(path.join(repoDir, ".github", "local-ci"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".github", "local-ci", "Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nCOPY data /tmp/\n",
    );
    fs.writeFileSync(path.join(repoDir, ".github", "local-ci", "data"), "v1");
    const r1 = discoverRunnerImage(repoDir);

    fs.writeFileSync(path.join(repoDir, ".github", "local-ci", "data"), "v2");
    const r2 = discoverRunnerImage(repoDir);

    expect(r1.image).not.toBe(r2.image);
  });

  it("ignores empty LOCAL_CI_RUNNER_IMAGE", () => {
    process.env.LOCAL_CI_RUNNER_IMAGE = "   ";
    const r = discoverRunnerImage(repoDir);
    expect(r.source).toBe("default");
  });
});

describe("detectMissingToolHint", () => {
  const defaultResolved: ResolvedRunnerImage = {
    image: UPSTREAM_RUNNER_IMAGE,
    source: "default",
    sourceLabel: "built-in default",
    needsBuild: false,
  };

  it("matches cargo linker `cc` not found", () => {
    const hint = detectMissingToolHint(
      "error: linker `cc` not found\n  = note: No such file",
      defaultResolved,
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("cc");
    expect(hint).toContain("runner-image.md");
  });

  it("matches bare `cc: command not found`", () => {
    const hint = detectMissingToolHint("sh: cc: command not found", defaultResolved);
    expect(hint).toContain("cc");
  });

  it("matches `make: command not found`", () => {
    const hint = detectMissingToolHint("/bin/sh: make: command not found", defaultResolved);
    expect(hint).not.toBeNull();
    expect(hint).toContain("make");
  });

  it("matches nix installer xz message", () => {
    const hint = detectMissingToolHint(
      "you do not have 'xz' installed, which I need to unpack the binary tarball",
      defaultResolved,
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("xz");
  });

  it("catches any unknown tool via generic 'command not found'", () => {
    const hint = detectMissingToolHint("bash: cmake: command not found", defaultResolved);
    expect(hint).not.toBeNull();
    expect(hint).toContain("cmake");
  });

  it("returns null when the user is on a custom image (env var)", () => {
    const resolved: ResolvedRunnerImage = {
      image: "my-org/custom:v1",
      source: "env",
      sourceLabel: "LOCAL_CI_RUNNER_IMAGE",
      needsBuild: false,
    };
    const hint = detectMissingToolHint("error: linker `cc` not found", resolved);
    expect(hint).toBeNull();
  });

  it("returns null when the user already has a Dockerfile configured", () => {
    const resolved: ResolvedRunnerImage = {
      image: "local-ci-runner:abc123def456",
      source: "dockerfile-file",
      sourceLabel: ".github/local-ci.Dockerfile",
      needsBuild: true,
      dockerfilePath: "/fake/.github/local-ci.Dockerfile",
    };
    const hint = detectMissingToolHint("error: linker `cc` not found", resolved);
    expect(hint).toBeNull();
  });

  it("returns null for unrelated failures", () => {
    const hint = detectMissingToolHint("Error: assertion failed at line 42", defaultResolved);
    expect(hint).toBeNull();
  });
});

describe("detectToolcacheHint", () => {
  const toolCacheDir = "/var/folders/xx/T/local-ci/slug/cache/toolcache";

  it("matches tar `Cannot open: Permission denied` and returns an rm command", () => {
    const output = [
      "/usr/bin/tar: bin/npm: Cannot open: Permission denied",
      "/usr/bin/tar: bin/npx: Cannot open: Permission denied",
      "/usr/bin/tar: Exiting with failure status due to previous errors",
    ].join("\n");
    const hint = detectToolcacheHint(output, toolCacheDir);
    expect(hint).not.toBeNull();
    expect(hint).toContain("sudo rm -rf");
    expect(hint).toContain(toolCacheDir);
  });

  it("returns null when no toolCacheDir is supplied", () => {
    const hint = detectToolcacheHint("tar: bin/npm: Cannot open: Permission denied", undefined);
    expect(hint).toBeNull();
  });

  it("returns null for unrelated failures", () => {
    const hint = detectToolcacheHint("npm ERR! code ENOENT", toolCacheDir);
    expect(hint).toBeNull();
  });

  it("does not fire on generic Permission denied without the tar prefix", () => {
    const hint = detectToolcacheHint("Permission denied: /home/runner/x", toolCacheDir);
    expect(hint).toBeNull();
  });
});
