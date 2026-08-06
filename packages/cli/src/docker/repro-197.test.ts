/**
 * Reproduction for https://github.com/redwoodjs/local-ci/issues/197
 *
 * On macOS with Docker Desktop, /var/run/docker.sock is a symlink that resolves
 * to ~/.docker/run/docker.sock. When local-ci passed the resolved path as the
 * container bind-mount source, Docker Desktop's VM tried to create directories at
 * /host_mnt/Users/.../.docker/run/docker.sock and failed with:
 *
 *   error while creating mount source path '...': mkdir ...: operation not supported
 *
 * The fix: resolveDockerSocket() returns a separate `bindMountPath` (the
 * pre-symlink path) that callers must use for bind mounts, while `socketPath`
 * (the resolved path) is used for the Docker API client connection.
 *
 * This file tests the full chain from filesystem state → socket resolution →
 * container bind string, so any regression in that chain fails here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { resolveDockerSocket, type DockerSocketDeps } from "./docker-socket.ts";

afterEach(() => {
  delete process.env.LOCAL_CI_DOCKER_HOST;
});

function dockerDesktopDeps(): DockerSocketDeps {
  return {
    existsSync: () => true,
    realpathSync: (p) => {
      if (String(p) === "/var/run/docker.sock") {
        return "/Users/test/.docker/run/docker.sock";
      }
      throw new Error("ENOENT");
    },
    accessSync: () => undefined,
  };
}

describe("issue-197 reproduction: Docker Desktop bind mount path", () => {
  it("resolves to the real path for API client but keeps the symlink path for bind mounts", () => {
    delete process.env.LOCAL_CI_DOCKER_HOST;
    // Simulate Docker Desktop: /var/run/docker.sock → ~/.docker/run/docker.sock
    const socket = resolveDockerSocket(dockerDesktopDeps());

    // Docker API client must use the resolved path so it can connect
    expect(socket.socketPath).toBe("/Users/test/.docker/run/docker.sock");

    // Bind-mount source must stay as /var/run/docker.sock — Docker Desktop
    // can translate this well-known path but fails on the resolved home-dir path
    expect(socket.bindMountPath).toBe("/var/run/docker.sock");
  });

  it("container bind string uses /var/run/docker.sock, not the resolved path (the failing case)", async () => {
    delete process.env.LOCAL_CI_DOCKER_HOST;

    const { buildContainerBinds } = await import("./container-config.ts");

    const socket = resolveDockerSocket(dockerDesktopDeps());

    // This is what local-job.ts does: use bindMountPath (not socketPath)
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
      dockerSocketPath: socket.bindMountPath,
    });

    // Must use the stable symlink path — this is what Docker Desktop can handle
    expect(binds).toContain("/var/run/docker.sock:/var/run/docker.sock");

    // Must NOT use the resolved path — this is what caused the original error:
    // "error while creating mount source path '/host_mnt/Users/test/.docker/run/docker.sock'"
    expect(binds).not.toContain("/Users/test/.docker/run/docker.sock:/var/run/docker.sock");
  });

  it("LOCAL_CI_DOCKER_HOST unix socket keeps the original path for bind mounts even if it resolves elsewhere", () => {
    process.env.LOCAL_CI_DOCKER_HOST = "unix:///var/run/docker.sock";

    const socket = resolveDockerSocket({
      realpathSync: () => "/Users/test/.docker/run/docker.sock",
      accessSync: () => undefined,
    });

    expect(socket.socketPath).toBe("/Users/test/.docker/run/docker.sock");
    expect(socket.bindMountPath).toBe("/var/run/docker.sock");
  });
});
