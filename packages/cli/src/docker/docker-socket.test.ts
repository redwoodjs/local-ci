import { describe, it, expect, afterEach } from "vitest";
import { resolveDockerSocket, type DockerSocketDeps } from "./docker-socket.ts";

afterEach(() => {
  delete process.env.LOCAL_CI_DOCKER_HOST;
});

function deps(overrides: DockerSocketDeps = {}): DockerSocketDeps {
  return {
    existsSync: () => false,
    realpathSync: () => {
      throw new Error("ENOENT");
    },
    accessSync: () => undefined,
    execSync: () => "[]",
    homedir: () => "/home/user",
    ...overrides,
  };
}

describe("resolveDockerSocket", () => {
  // ── LOCAL_CI_DOCKER_HOST set ──────────────────────────────────────────────────────

  it("uses LOCAL_CI_DOCKER_HOST when set to a unix socket that exists", () => {
    process.env.LOCAL_CI_DOCKER_HOST = "unix:///tmp/test-docker.sock";

    const result = resolveDockerSocket(
      deps({
        realpathSync: () => "/tmp/test-docker.sock",
        accessSync: () => undefined,
      }),
    );

    expect(result.socketPath).toBe("/tmp/test-docker.sock");
    expect(result.uri).toBe("unix:///tmp/test-docker.sock");
    expect(result.bindMountPath).toBe("/tmp/test-docker.sock");
  });

  it("uses original LOCAL_CI_DOCKER_HOST path as bindMountPath even when it resolves elsewhere", () => {
    process.env.LOCAL_CI_DOCKER_HOST = "unix:///var/run/docker.sock";

    const result = resolveDockerSocket(
      deps({
        realpathSync: () => "/Users/test/.docker/run/docker.sock",
        accessSync: () => undefined,
      }),
    );

    expect(result.socketPath).toBe("/Users/test/.docker/run/docker.sock");
    expect(result.bindMountPath).toBe("/var/run/docker.sock");
  });

  it("returns non-unix LOCAL_CI_DOCKER_HOST as-is (e.g. ssh://)", () => {
    process.env.LOCAL_CI_DOCKER_HOST = "ssh://user@remote";

    const result = resolveDockerSocket(deps());

    expect(result.socketPath).toBe("");
    expect(result.uri).toBe("ssh://user@remote");
    expect(result.bindMountPath).toBe("");
  });

  it("throws with doc link when LOCAL_CI_DOCKER_HOST points to non-existent socket", () => {
    process.env.LOCAL_CI_DOCKER_HOST = "unix:///nonexistent/docker.sock";

    expect(() => resolveDockerSocket(deps())).toThrow(
      "LOCAL_CI_DOCKER_HOST=unix:///nonexistent/docker.sock",
    );
    expect(() => resolveDockerSocket(deps())).toThrow("docs/docker-socket.md");
  });

  // ── Default socket path ────────────────────────────────────────────────

  it("resolves /var/run/docker.sock symlink", () => {
    delete process.env.LOCAL_CI_DOCKER_HOST;

    const result = resolveDockerSocket(
      deps({
        existsSync: () => true,
        realpathSync: (p) => {
          if (String(p) === "/var/run/docker.sock") {
            return "/Users/test/.orbstack/run/docker.sock";
          }
          throw new Error("ENOENT");
        },
        accessSync: () => undefined,
      }),
    );

    expect(result.socketPath).toBe("/Users/test/.orbstack/run/docker.sock");
    expect(result.uri).toBe("unix:///Users/test/.orbstack/run/docker.sock");
    // bindMountPath must stay as /var/run/docker.sock (the symlink), not the resolved path.
    // Using the resolved path as a bind-mount source fails on macOS Docker Desktop with
    // "error while creating mount source path" (issue #197).
    expect(result.bindMountPath).toBe("/var/run/docker.sock");
  });

  it("uses /var/run/docker.sock as bindMountPath when it resolves to Docker Desktop path (regression #197)", () => {
    delete process.env.LOCAL_CI_DOCKER_HOST;

    const result = resolveDockerSocket(
      deps({
        existsSync: () => true,
        realpathSync: (p) => {
          if (String(p) === "/var/run/docker.sock") {
            return "/Users/username/.docker/run/docker.sock";
          }
          throw new Error("ENOENT");
        },
        accessSync: () => undefined,
      }),
    );

    expect(result.socketPath).toBe("/Users/username/.docker/run/docker.sock");
    expect(result.bindMountPath).toBe("/var/run/docker.sock");
  });

  // ── EACCES fallthrough ─────────────────────────────────────────────────

  it("falls through to docker context when default socket is not accessible, and uses /var/run/docker.sock for bind mount (regression #209)", () => {
    delete process.env.LOCAL_CI_DOCKER_HOST;
    // Exact #209 cell: Linux + Docker Desktop, user not in docker group.
    // - /var/run/docker.sock exists (owned by root:docker 660) — exists but EACCES for us
    // - Active docker context points at the Desktop socket — what our API client must use
    // - Bind mount must NOT be the Desktop socket (Docker Desktop rejects its own socket
    //   path as a mount source with "mounts denied") — it must be /var/run/docker.sock,
    //   which Docker Desktop's mount proxy accepts.
    const result = resolveDockerSocket(
      deps({
        realpathSync: () => "/var/run/docker.sock",
        accessSync: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
        existsSync: (p) => {
          const s = String(p);
          return s === "/var/run/docker.sock" || s === "/home/user/.docker/desktop/docker.sock";
        },
        execSync: () =>
          JSON.stringify([
            {
              Endpoints: {
                docker: {
                  Host: "unix:///home/user/.docker/desktop/docker.sock",
                },
              },
            },
          ]),
      }),
    );

    // API client connects via the Desktop socket (we can't R/W /var/run/docker.sock)
    expect(result.socketPath).toBe("/home/user/.docker/desktop/docker.sock");
    // Bind mount uses /var/run/docker.sock — the path Docker Desktop's mount proxy accepts
    expect(result.bindMountPath).toBe("/var/run/docker.sock");
  });

  // ── Missing / dangling /var/run/docker.sock ─────────────────────────────

  it("throws with doc link when /var/run/docker.sock is missing", () => {
    delete process.env.LOCAL_CI_DOCKER_HOST;

    expect(() => resolveDockerSocket(deps())).toThrow("/var/run/docker.sock");
    expect(() => resolveDockerSocket(deps())).toThrow("missing or a dangling symlink");
    expect(() => resolveDockerSocket(deps())).toThrow("docs/docker-socket.md");
  });

  it("appends Docker Desktop toggle hint when ~/.docker/run/docker.sock exists but /var/run/docker.sock is missing", () => {
    delete process.env.LOCAL_CI_DOCKER_HOST;
    const socketDeps = deps({
      existsSync: (p) => {
        const s = String(p);
        if (s === "/var/run/docker.sock") {
          return false;
        }
        if (s.endsWith("/.docker/run/docker.sock")) {
          return true;
        }
        return false;
      },
    });

    expect(() => resolveDockerSocket(socketDeps)).toThrow(
      "Docker Desktop is running but the default socket is disabled",
    );
    expect(() => resolveDockerSocket(socketDeps)).toThrow("Settings → Advanced");
  });

  it("throws with doc link when /var/run/docker.sock is a dangling symlink (stale OrbStack / Colima switch)", () => {
    // Regression for #263 debugging session: /var/run/docker.sock → ~/.orbstack/...
    // but OrbStack is stopped, so the link dangles. fs.existsSync returns false for
    // dangling symlinks, which is the signal we want.
    delete process.env.LOCAL_CI_DOCKER_HOST;

    expect(() => resolveDockerSocket(deps())).toThrow("dangling symlink");
  });

  it("throws with doc link when /var/run/docker.sock exists but EACCES and no readable context", () => {
    delete process.env.LOCAL_CI_DOCKER_HOST;
    const socketDeps = deps({
      existsSync: () => true,
      realpathSync: () => "/var/run/docker.sock",
      accessSync: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      execSync: () => {
        throw new Error("docker not found");
      },
    });

    expect(() => resolveDockerSocket(socketDeps)).toThrow("not readable");
    expect(() => resolveDockerSocket(socketDeps)).toThrow("docs/docker-socket.md");
  });
});
