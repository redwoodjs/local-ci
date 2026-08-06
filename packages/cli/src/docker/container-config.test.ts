import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";

afterEach(() => {
  vi.restoreAllMocks();
});

// ── buildContainerEnv ─────────────────────────────────────────────────────────

describe("buildContainerEnv", () => {
  it("builds the standard env array", async () => {
    const { buildContainerEnv } = await import("./container-config.ts");
    const env = buildContainerEnv({
      containerName: "runner-1",
      registrationToken: "tok",
      repoUrl: "http://dtu:3000/org/repo",
      dockerApiUrl: "http://dtu:3000",
      githubRepo: "org/repo",
      headSha: "abc123",
      dtuHost: "host.docker.internal",
      useDirectContainer: false,
    });

    expect(env).toContain("RUNNER_NAME=runner-1");
    expect(env).toContain("GITHUB_REPOSITORY=org/repo");
    expect(env).toContain("LOCAL_CI_LOCAL=true");
    expect(env).toContain("LOCAL_CI_HEAD_SHA=abc123");
    expect(env).toContain("FORCE_COLOR=1");
    // Should NOT include root-mode vars for standard container
    expect(env).not.toContain("RUNNER_ALLOW_RUNASROOT=1");
  });

  it("adds root-mode env vars for direct container injection", async () => {
    const { buildContainerEnv } = await import("./container-config.ts");
    const env = buildContainerEnv({
      containerName: "runner-1",
      registrationToken: "tok",
      repoUrl: "http://dtu:3000/org/repo",
      dockerApiUrl: "http://dtu:3000",
      githubRepo: "org/repo",
      dtuHost: "host.docker.internal",
      useDirectContainer: true,
    });

    expect(env).toContain("RUNNER_ALLOW_RUNASROOT=1");
    expect(env).toContain("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1");
  });
});

// ── buildContainerBinds ───────────────────────────────────────────────────────

describe("buildContainerBinds", () => {
  it("builds standard bind mounts with all PM caches", async () => {
    const { buildContainerBinds } = await import("./container-config.ts");
    const binds = buildContainerBinds({
      hostWorkDir: "/tmp/work",
      shimsDir: "/tmp/shims",
      diagDir: "/tmp/diag",
      toolCacheDir: "/tmp/toolcache",
      pnpmStoreDir: "/tmp/pnpm",
      npmCacheDir: "/tmp/npm",
      yarnCacheDir: "/tmp/yarn",
      bunCacheDir: "/tmp/bun",
      playwrightCacheDir: "/tmp/playwright",
      hostRunnerDir: "/tmp/runner",
      useDirectContainer: false,
    });

    expect(binds).toContain("/tmp/work:/home/runner/_work");
    expect(binds).toContain("/var/run/docker.sock:/var/run/docker.sock"); // default when dockerSocketPath is not set
    expect(binds).toContain("/tmp/shims:/tmp/local-ci-shims");
    expect(binds).toContain("/tmp/pnpm:/home/runner/_work/.pnpm-store");
    expect(binds).toContain("/tmp/npm:/home/runner/.npm");
    expect(binds).toContain("/tmp/yarn:/home/runner/.cache/yarn");
    expect(binds).toContain("/tmp/bun:/home/runner/.bun");
    expect(binds.some((bind) => bind.includes("/node_modules"))).toBe(false);
    // Standard mode should NOT include runner home bind (but _work bind is expected)
    expect(binds.some((b) => b.endsWith(":/home/runner"))).toBe(false);
  });

  it("omits PM bind mounts when cache dirs are not provided", async () => {
    const { buildContainerBinds } = await import("./container-config.ts");
    const binds = buildContainerBinds({
      hostWorkDir: "/tmp/work",
      shimsDir: "/tmp/shims",
      diagDir: "/tmp/diag",
      toolCacheDir: "/tmp/toolcache",
      playwrightCacheDir: "/tmp/playwright",
      warmModulesDir: "/tmp/warm",
      hostRunnerDir: "/tmp/runner",
      useDirectContainer: false,
      githubRepo: "org/repo",
    });

    expect(binds).toContain("/tmp/work:/home/runner/_work");
    expect(binds.some((b) => b.includes(".pnpm-store"))).toBe(false);
    expect(binds.some((b) => b.includes("/.npm"))).toBe(false);
    expect(binds.some((b) => b.includes("/.bun"))).toBe(false);
  });

  it("includes only the npm bind mount when only npmCacheDir is provided", async () => {
    const { buildContainerBinds } = await import("./container-config.ts");
    const binds = buildContainerBinds({
      hostWorkDir: "/tmp/work",
      shimsDir: "/tmp/shims",
      diagDir: "/tmp/diag",
      toolCacheDir: "/tmp/toolcache",
      npmCacheDir: "/tmp/npm",
      playwrightCacheDir: "/tmp/playwright",
      warmModulesDir: "/tmp/warm",
      hostRunnerDir: "/tmp/runner",
      useDirectContainer: false,
      githubRepo: "org/repo",
    });

    expect(binds).toContain("/tmp/npm:/home/runner/.npm");
    expect(binds.some((b) => b.includes(".pnpm-store"))).toBe(false);
    expect(binds.some((b) => b.includes(".bun"))).toBe(false);
  });

  it("uses the given dockerSocketPath as the bind-mount source", async () => {
    const { buildContainerBinds } = await import("./container-config.ts");
    const binds = buildContainerBinds({
      hostWorkDir: "/tmp/work",
      shimsDir: "/tmp/shims",
      diagDir: "/tmp/diag",
      toolCacheDir: "/tmp/toolcache",
      playwrightCacheDir: "/tmp/playwright",
      warmModulesDir: "/tmp/warm",
      hostRunnerDir: "/tmp/runner",
      useDirectContainer: false,
      githubRepo: "org/repo",
      dockerSocketPath: "/Users/test/.orbstack/run/docker.sock",
    });

    expect(binds).toContain("/Users/test/.orbstack/run/docker.sock:/var/run/docker.sock");
    expect(binds).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("includes runner bind mount for direct container", async () => {
    const { buildContainerBinds } = await import("./container-config.ts");
    const binds = buildContainerBinds({
      hostWorkDir: "/tmp/work",
      shimsDir: "/tmp/shims",
      diagDir: "/tmp/diag",
      toolCacheDir: "/tmp/toolcache",
      pnpmStoreDir: "/tmp/pnpm",
      npmCacheDir: "/tmp/npm",
      bunCacheDir: "/tmp/bun",
      playwrightCacheDir: "/tmp/playwright",
      warmModulesDir: "/tmp/warm",
      hostRunnerDir: "/tmp/runner",
      useDirectContainer: true,
      githubRepo: "org/repo",
    });

    expect(binds).toContain("/tmp/runner:/home/runner");
  });
});

// ── buildContainerCmd ─────────────────────────────────────────────────────────

describe("buildContainerCmd", () => {
  it("starts with bash -c for standard containers", async () => {
    const { buildContainerCmd } = await import("./container-config.ts");
    const cmd = buildContainerCmd({
      svcPortForwardSnippet: "",
      dtuPort: "3000",
      dtuHost: "localhost",
      useDirectContainer: false,
      containerName: "test-runner",
    });

    expect(cmd[0]).toBe("bash");
    expect(cmd[1]).toBe("-c");
    expect(cmd[2]).toContain("MAYBE_SUDO");
    expect(cmd[2]).toContain("run.sh --once");
  });

  it("starts with -c for direct containers", async () => {
    const { buildContainerCmd } = await import("./container-config.ts");
    const cmd = buildContainerCmd({
      svcPortForwardSnippet: "",
      dtuPort: "3000",
      dtuHost: "localhost",
      useDirectContainer: true,
      containerName: "test-runner",
    });

    expect(cmd[0]).toBe("-c");
    expect(cmd).toHaveLength(2);
  });

  it("includes service port forwarding snippet", async () => {
    const { buildContainerCmd } = await import("./container-config.ts");
    const cmd = buildContainerCmd({
      svcPortForwardSnippet: "socat TCP-LISTEN:5432,fork TCP:svc-db:5432 & \nsleep 0.3 && ",
      dtuPort: "3000",
      dtuHost: "localhost",
      useDirectContainer: false,
      containerName: "test-runner",
    });

    expect(cmd[2]).toContain("socat TCP-LISTEN:5432");
  });

  // Regression for #257: on native Linux Docker the bind-mounted
  // /var/run/docker.sock is root:docker 0660 and the runner user can't
  // chmod it without sudo. If this line drops MAYBE_SUDO, every step that
  // talks to the Docker socket (buildx, compose, docker login, ...) fails
  // with "permission denied".
  it("chmods the docker socket via MAYBE_SUDO so it works on native Linux Docker (#257)", async () => {
    const { buildContainerCmd } = await import("./container-config.ts");
    const cmd = buildContainerCmd({
      svcPortForwardSnippet: "",
      dtuPort: "3000",
      dtuHost: "localhost",
      useDirectContainer: false,
      containerName: "test-runner",
    });

    expect(cmd[2]).toContain("MAYBE_SUDO chmod 666 /var/run/docker.sock");
  });

  // Regression for #263: on macOS with Colima / Docker Desktop the
  // bind-mounted /home/runner/_diag and /home/runner/_work appear as
  // root:root 0755 inside the container (host perms don't translate
  // through the VM mount layer), so the runner user (uid 1001) hits
  // UnauthorizedAccessException when writing its diag logs and workspace.
  it("chmods /home/runner/_diag and /home/runner/_work via MAYBE_SUDO (#263)", async () => {
    const { buildContainerCmd } = await import("./container-config.ts");
    const cmd = buildContainerCmd({
      svcPortForwardSnippet: "",
      dtuPort: "3000",
      dtuHost: "localhost",
      useDirectContainer: false,
      containerName: "test-runner",
    });
    expect(cmd[2]).toContain("MAYBE_SUDO chmod 1777 /home/runner/_diag");
    expect(cmd[2]).toContain("MAYBE_SUDO chmod 1777 /home/runner/_work");
  });
});

// ── resolveDockerApiUrl ───────────────────────────────────────────────────────

describe("resolveDockerApiUrl", () => {
  it("replaces localhost with the DTU host", async () => {
    const { resolveDockerApiUrl } = await import("./container-config.ts");
    expect(resolveDockerApiUrl("http://localhost:3000", "172.17.0.2")).toBe(
      "http://172.17.0.2:3000",
    );
  });

  it("replaces 127.0.0.1 with the DTU host", async () => {
    const { resolveDockerApiUrl } = await import("./container-config.ts");
    expect(resolveDockerApiUrl("http://127.0.0.1:3000", "host.docker.internal")).toBe(
      "http://host.docker.internal:3000",
    );
  });

  it("preserves path and query components", async () => {
    const { resolveDockerApiUrl } = await import("./container-config.ts");
    expect(resolveDockerApiUrl("http://localhost:8910/api/v1?foo=bar", "10.0.0.8")).toBe(
      "http://10.0.0.8:8910/api/v1?foo=bar",
    );
  });

  it("keeps implicit https default port behavior", async () => {
    const { resolveDockerApiUrl } = await import("./container-config.ts");
    expect(resolveDockerApiUrl("https://localhost", "host.docker.internal")).toBe(
      "https://host.docker.internal",
    );
  });

  it("does not rewrite non-loopback hosts", async () => {
    const { resolveDockerApiUrl } = await import("./container-config.ts");
    expect(
      resolveDockerApiUrl("https://dtu.internal.example.com:8910", "host.docker.internal"),
    ).toBe("https://dtu.internal.example.com:8910");
  });
});

describe("resolveDtuHost", () => {
  const originalBridgeGateway = process.env.LOCAL_CI_DOCKER_BRIDGE_GATEWAY;
  const originalDtuHost = process.env.LOCAL_CI_DTU_HOST;

  beforeEach(() => {
    delete process.env.LOCAL_CI_DTU_HOST;
  });

  afterEach(() => {
    if (originalBridgeGateway === undefined) {
      delete process.env.LOCAL_CI_DOCKER_BRIDGE_GATEWAY;
    } else {
      process.env.LOCAL_CI_DOCKER_BRIDGE_GATEWAY = originalBridgeGateway;
    }
    if (originalDtuHost === undefined) {
      delete process.env.LOCAL_CI_DTU_HOST;
    } else {
      process.env.LOCAL_CI_DTU_HOST = originalDtuHost;
    }
  });

  it("uses host alias when available outside Docker", async () => {
    delete process.env.LOCAL_CI_DTU_HOST;
    const { resolveDtuHost } = await import("./container-config.ts");
    const originalExistsSync = fs.existsSync;

    vi.spyOn(fs, "existsSync").mockImplementation((filePath: fs.PathLike) => {
      if (filePath === "/.dockerenv") {
        return false;
      }
      return originalExistsSync(filePath);
    });

    await expect(resolveDtuHost()).resolves.toBe("host.docker.internal");
  });

  it("uses configured bridge gateway outside Docker when provided", async () => {
    delete process.env.LOCAL_CI_DTU_HOST;
    const { resolveDtuHost } = await import("./container-config.ts");
    const originalExistsSync = fs.existsSync;

    vi.spyOn(fs, "existsSync").mockImplementation((filePath: fs.PathLike) => {
      if (filePath === "/.dockerenv") {
        return false;
      }
      return originalExistsSync(filePath);
    });
    process.env.LOCAL_CI_DOCKER_BRIDGE_GATEWAY = "10.10.0.1";

    await expect(resolveDtuHost()).resolves.toBe("10.10.0.1");
  });

  it("uses host alias outside Docker when no gateway override is configured", async () => {
    delete process.env.LOCAL_CI_DTU_HOST;
    const { resolveDtuHost } = await import("./container-config.ts");
    const originalExistsSync = fs.existsSync;

    vi.spyOn(fs, "existsSync").mockImplementation((filePath: fs.PathLike) => {
      if (filePath === "/.dockerenv") {
        return false;
      }
      return originalExistsSync(filePath);
    });

    await expect(resolveDtuHost()).resolves.toBe("host.docker.internal");
  });
});

describe("resolveDockerExtraHosts", () => {
  const originalExtraHosts = process.env.LOCAL_CI_DOCKER_EXTRA_HOSTS;
  const originalDisable = process.env.LOCAL_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS;
  const originalGateway = process.env.LOCAL_CI_DOCKER_HOST_GATEWAY;

  afterEach(() => {
    if (originalExtraHosts === undefined) {
      delete process.env.LOCAL_CI_DOCKER_EXTRA_HOSTS;
    } else {
      process.env.LOCAL_CI_DOCKER_EXTRA_HOSTS = originalExtraHosts;
    }

    if (originalDisable === undefined) {
      delete process.env.LOCAL_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS;
    } else {
      process.env.LOCAL_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS = originalDisable;
    }

    if (originalGateway === undefined) {
      delete process.env.LOCAL_CI_DOCKER_HOST_GATEWAY;
    } else {
      process.env.LOCAL_CI_DOCKER_HOST_GATEWAY = originalGateway;
    }
  });

  it("maps host.docker.internal to host-gateway by default", async () => {
    delete process.env.LOCAL_CI_DOCKER_EXTRA_HOSTS;
    delete process.env.LOCAL_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS;
    delete process.env.LOCAL_CI_DOCKER_HOST_GATEWAY;

    const { resolveDockerExtraHosts } = await import("./container-config.ts");
    expect(resolveDockerExtraHosts("host.docker.internal")).toEqual([
      "host.docker.internal:host-gateway",
    ]);
  });

  it("uses LOCAL_CI_DOCKER_EXTRA_HOSTS when provided", async () => {
    process.env.LOCAL_CI_DOCKER_EXTRA_HOSTS = "host.docker.internal:172.17.0.1,api.local:10.0.0.2";
    delete process.env.LOCAL_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS;

    const { resolveDockerExtraHosts } = await import("./container-config.ts");
    expect(resolveDockerExtraHosts("host.docker.internal")).toEqual([
      "host.docker.internal:172.17.0.1",
      "api.local:10.0.0.2",
    ]);
  });

  it("returns undefined when defaults are disabled", async () => {
    delete process.env.LOCAL_CI_DOCKER_EXTRA_HOSTS;
    process.env.LOCAL_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS = "1";

    const { resolveDockerExtraHosts } = await import("./container-config.ts");
    expect(resolveDockerExtraHosts("host.docker.internal")).toBeUndefined();
  });

  it("does not add default mapping for non-host.docker.internal hosts", async () => {
    delete process.env.LOCAL_CI_DOCKER_EXTRA_HOSTS;
    delete process.env.LOCAL_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS;

    const { resolveDockerExtraHosts } = await import("./container-config.ts");
    expect(resolveDockerExtraHosts("10.10.10.10")).toBeUndefined();
  });
});

// ── dockerSocketPath bind-mount ───────────────────────────────────────────────

describe("buildContainerBinds with dockerSocketPath", () => {
  const baseOpts = {
    hostWorkDir: "/tmp/work",
    shimsDir: "/tmp/shims",
    diagDir: "/tmp/diag",
    toolCacheDir: "/tmp/toolcache",
    playwrightCacheDir: "/tmp/playwright",
    warmModulesDir: "/tmp/warm",
    hostRunnerDir: "/tmp/runner",
    useDirectContainer: false,
    githubRepo: "org/repo",
  };

  it("uses default /var/run/docker.sock when no dockerSocketPath is provided", async () => {
    const { buildContainerBinds } = await import("./container-config.ts");
    const binds = buildContainerBinds(baseOpts);
    expect(binds).toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("uses custom host socket path from dockerSocketPath", async () => {
    const { buildContainerBinds } = await import("./container-config.ts");
    const binds = buildContainerBinds({
      ...baseOpts,
      dockerSocketPath: "/Users/foo/.docker/run/docker.sock",
    });
    expect(binds).toContain("/Users/foo/.docker/run/docker.sock:/var/run/docker.sock");
    expect(binds).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
  });
});

// ── signalsDir bind-mount ─────────────────────────────────────────────────────

describe("buildContainerBinds with signalsDir", () => {
  const baseOpts = {
    hostWorkDir: "/tmp/work",
    shimsDir: "/tmp/shims",
    diagDir: "/tmp/diag",
    toolCacheDir: "/tmp/toolcache",
    pnpmStoreDir: "/tmp/pnpm",
    npmCacheDir: "/tmp/npm",
    bunCacheDir: "/tmp/bun",
    playwrightCacheDir: "/tmp/playwright",
    warmModulesDir: "/tmp/warm",
    hostRunnerDir: "/tmp/runner",
    useDirectContainer: false,
    githubRepo: "org/repo",
  };

  it("includes signals bind-mount when signalsDir is provided", async () => {
    const { buildContainerBinds } = await import("./container-config.ts");
    const binds = buildContainerBinds({ ...baseOpts, signalsDir: "/tmp/signals" });
    expect(binds).toContain("/tmp/signals:/tmp/local-ci-signals");
  });

  it("omits signals bind-mount when signalsDir is undefined", async () => {
    const { buildContainerBinds } = await import("./container-config.ts");
    const binds = buildContainerBinds(baseOpts);
    expect(binds.some((b) => b.includes("local-ci-signals"))).toBe(false);
  });
});
