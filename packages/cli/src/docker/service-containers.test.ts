import { describe, it, expect, vi } from "vitest";
import {
  startServiceContainers,
  cleanupServiceContainers,
  parseHealthCheck,
} from "./service-containers.ts";
import type { WorkflowService } from "../workflow/workflow-parser.ts";

// ─── Mock Docker client ───────────────────────────────────────────────────────

function makeMockContainer(id: string, healthStatus?: string) {
  return {
    id,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      State: {
        Running: true,
        Health: healthStatus ? { Status: healthStatus } : undefined,
      },
    }),
  };
}

function makeMockDocker(opts?: { healthStatus?: string; imagePresent?: boolean }) {
  const containers = new Map<string, ReturnType<typeof makeMockContainer>>();
  let containerCounter = 0;

  const mockDocker = {
    createNetwork: vi.fn().mockResolvedValue({ id: "net-123" }),
    createContainer: vi.fn().mockImplementation((config: any) => {
      containerCounter++;
      const id = `container-${containerCounter}`;
      const c = makeMockContainer(id, opts?.healthStatus);
      containers.set(config.name || id, c);
      return Promise.resolve(c);
    }),
    getContainer: vi.fn().mockImplementation((nameOrId: string) => {
      const existing = containers.get(nameOrId);
      if (existing) {
        return existing;
      }
      return {
        remove: vi.fn().mockRejectedValue(new Error("not found")),
        stop: vi.fn().mockRejectedValue(new Error("not found")),
        inspect: vi.fn().mockResolvedValue({
          State: {
            Running: true,
            Health: opts?.healthStatus ? { Status: opts.healthStatus } : undefined,
          },
        }),
      };
    }),
    getImage: vi.fn().mockReturnValue({
      inspect:
        opts?.imagePresent === false
          ? vi.fn().mockRejectedValue(new Error("not found"))
          : vi.fn().mockResolvedValue({}),
    }),
    getNetwork: vi.fn().mockReturnValue({
      remove: vi.fn().mockResolvedValue(undefined),
    }),
    pull: vi.fn().mockImplementation((_image, _options, callback) => callback(null, {})),
    modem: {
      followProgress: vi.fn().mockImplementation((_stream, callback) => callback(null)),
    },
    _containers: containers,
  };

  return mockDocker as any;
}

// ─── parseHealthCheck ─────────────────────────────────────────────────────────

describe("parseHealthCheck", () => {
  it("parses all health-check flags from options string", () => {
    const options = `--health-cmd="mysqladmin ping -h localhost -proot" --health-interval=5s --health-timeout=3s --health-retries=10`;
    const result = parseHealthCheck(options);

    expect(result).toBeDefined();
    expect(result!.Test).toEqual(["CMD-SHELL", "mysqladmin ping -h localhost -proot"]);
    expect(result!.Interval).toBe(5_000_000_000);
    expect(result!.Timeout).toBe(3_000_000_000);
    expect(result!.Retries).toBe(10);
  });

  it("uses defaults when interval/timeout/retries are missing", () => {
    const options = `--health-cmd="curl -f http://localhost/"`;
    const result = parseHealthCheck(options);

    expect(result).toBeDefined();
    expect(result!.Interval).toBe(10_000_000_000);
    expect(result!.Timeout).toBe(5_000_000_000);
    expect(result!.Retries).toBe(3);
  });

  it("returns undefined when no --health-cmd is present", () => {
    expect(parseHealthCheck("--some-other-flag")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseHealthCheck("")).toBeUndefined();
  });
});

// ─── startServiceContainers ───────────────────────────────────────────────────

describe("startServiceContainers", () => {
  const MYSQL_SERVICE: WorkflowService = {
    name: "mysql",
    image: "mysql:8.0",
    env: { MYSQL_ROOT_PASSWORD: "root", MYSQL_DATABASE: "test_db" },
    ports: ["3306:3306"],
    options: `--health-cmd="mysqladmin ping" --health-interval=5s --health-timeout=3s --health-retries=10`,
  };

  const REDIS_SERVICE: WorkflowService = {
    name: "redis",
    image: "redis:7",
    ports: ["6379:6379"],
  };

  it("creates a Docker network with agent-ci-net- prefix", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [REDIS_SERVICE], "agent-ci-42");

    expect(docker.createNetwork).toHaveBeenCalledWith({
      Name: "agent-ci-net-agent-ci-42",
      Driver: "bridge",
    });
  });

  it("creates containers for each service on the shared network", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [MYSQL_SERVICE, REDIS_SERVICE], "agent-ci-42");

    expect(docker.createContainer).toHaveBeenCalledTimes(2);

    const mysqlCall = docker.createContainer.mock.calls[0][0];
    expect(mysqlCall.Image).toBe("mysql:8.0");
    expect(mysqlCall.name).toBe("agent-ci-42-svc-mysql");
    expect(mysqlCall.Env).toContain("MYSQL_ROOT_PASSWORD=root");
    expect(mysqlCall.Env).toContain("MYSQL_DATABASE=test_db");
    expect(mysqlCall.HostConfig.NetworkMode).toBe("agent-ci-net-agent-ci-42");
    expect(mysqlCall.HostConfig.PortBindings).toEqual({ "3306/tcp": [{ HostPort: "3306" }] });
    expect(
      mysqlCall.NetworkingConfig.EndpointsConfig["agent-ci-net-agent-ci-42"].Aliases,
    ).toContain("mysql");

    const redisCall = docker.createContainer.mock.calls[1][0];
    expect(redisCall.Image).toBe("redis:7");
    expect(redisCall.name).toBe("agent-ci-42-svc-redis");
    expect(
      redisCall.NetworkingConfig.EndpointsConfig["agent-ci-net-agent-ci-42"].Aliases,
    ).toContain("redis");
  });

  it("starts all created containers", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [MYSQL_SERVICE, REDIS_SERVICE], "agent-ci-42");

    for (const [, container] of docker._containers) {
      expect(container.start).toHaveBeenCalledTimes(1);
    }
  });

  it("returns the correct ServiceContext", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    const ctx = await startServiceContainers(docker, [MYSQL_SERVICE, REDIS_SERVICE], "agent-ci-42");

    expect(ctx.networkName).toBe("agent-ci-net-agent-ci-42");
    expect(ctx.containerIds).toHaveLength(2);
    expect(ctx.containerIds[0]).toBe("container-1");
    expect(ctx.containerIds[1]).toBe("container-2");
  });

  it("generates port-forward commands for each port mapping", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    const ctx = await startServiceContainers(docker, [MYSQL_SERVICE, REDIS_SERVICE], "agent-ci-42");

    expect(ctx.portForwards).toHaveLength(2);
    expect(ctx.portForwards[0]).toContain("agent-ci-42-svc-mysql");
    expect(ctx.portForwards[0]).toContain("3306");
    expect(ctx.portForwards[1]).toContain("agent-ci-42-svc-redis");
    expect(ctx.portForwards[1]).toContain("6379");
  });

  it("applies health-check config from options string", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [MYSQL_SERVICE], "agent-ci-42");

    const call = docker.createContainer.mock.calls[0][0];
    expect(call.Healthcheck).toBeDefined();
    expect(call.Healthcheck.Test).toEqual(["CMD-SHELL", "mysqladmin ping"]);
    expect(call.Healthcheck.Retries).toBe(10);
  });

  it("labels service containers with agent-ci.pid for orphan cleanup", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [MYSQL_SERVICE, REDIS_SERVICE], "agent-ci-42");

    for (const call of docker.createContainer.mock.calls) {
      expect(call[0].Labels).toBeDefined();
      expect(call[0].Labels["agent-ci.pid"]).toBe(String(process.pid));
    }
  });

  it("does not set Healthcheck when options are absent", async () => {
    const docker = makeMockDocker();
    await startServiceContainers(docker, [REDIS_SERVICE], "agent-ci-42");

    const call = docker.createContainer.mock.calls[0][0];
    expect(call.Healthcheck).toBeUndefined();
  });

  it("handles service with no ports (no port forwards generated)", async () => {
    const docker = makeMockDocker();
    const svc: WorkflowService = { name: "memcached", image: "memcached:latest" };
    const ctx = await startServiceContainers(docker, [svc], "agent-ci-42");

    expect(ctx.portForwards).toHaveLength(0);
  });

  it("uses service credentials when pulling a private image", async () => {
    const docker = makeMockDocker({ imagePresent: false });
    const service: WorkflowService = {
      name: "cache",
      image: "ghcr.io/private-org/cache:latest",
      credentials: { username: "ci-user", password: "secret-token" },
    };

    await startServiceContainers(docker, [service], "agent-ci-42");

    expect(docker.pull).toHaveBeenCalledWith(
      service.image,
      {
        authconfig: {
          username: "ci-user",
          password: "secret-token",
          serveraddress: "ghcr.io",
        },
      },
      expect.any(Function),
    );
  });

  it("pre-cleans stale containers with the same name", async () => {
    const docker = makeMockDocker();
    await startServiceContainers(docker, [REDIS_SERVICE], "agent-ci-42");

    expect(docker.getContainer).toHaveBeenCalledWith("agent-ci-42-svc-redis");
  });

  it("calls emit with progress messages", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    const lines: string[] = [];
    await startServiceContainers(docker, [MYSQL_SERVICE], "agent-ci-42", (l) => lines.push(l));

    expect(lines.some((l) => l.includes("Created network"))).toBe(true);
    expect(lines.some((l) => l.includes("Starting service: mysql"))).toBe(true);
    expect(lines.some((l) => l.includes("mysql started"))).toBe(true);
    expect(lines.some((l) => l.includes("Waiting for mysql to become healthy"))).toBe(true);
    expect(lines.some((l) => l.includes("mysql healthy in"))).toBe(true);
  });

  it("sets short service name as a Docker network alias so DB_HOST=mysql resolves", async () => {
    // Regression: container was named agent-ci-N-svc-mysql but DB_HOST=mysql couldn't resolve.
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [MYSQL_SERVICE], "agent-ci-99");

    const call = docker.createContainer.mock.calls[0][0];
    const networkName = "agent-ci-net-agent-ci-99";

    expect(call.NetworkingConfig.EndpointsConfig[networkName]).toBeDefined();
    const aliases: string[] = call.NetworkingConfig.EndpointsConfig[networkName].Aliases;
    expect(aliases).toContain("mysql");
    expect(aliases).not.toContain("agent-ci-99-svc-mysql"); // full name is NOT the alias
  });

  it("aliases differ per service", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [MYSQL_SERVICE, REDIS_SERVICE], "agent-ci-42");

    const networkName = "agent-ci-net-agent-ci-42";
    const mysqlAliases =
      docker.createContainer.mock.calls[0][0].NetworkingConfig.EndpointsConfig[networkName].Aliases;
    const redisAliases =
      docker.createContainer.mock.calls[1][0].NetworkingConfig.EndpointsConfig[networkName].Aliases;

    expect(mysqlAliases).toContain("mysql");
    expect(redisAliases).toContain("redis");
    expect(mysqlAliases).not.toContain("redis");
    expect(redisAliases).not.toContain("mysql");
  });
});

// ─── cleanupServiceContainers ─────────────────────────────────────────────────

describe("cleanupServiceContainers", () => {
  it("stops and removes all containers, then removes the network", async () => {
    const docker = makeMockDocker();
    const ctx = {
      networkName: "agent-ci-net-test",
      containerIds: ["c1", "c2"],
      portForwards: [],
    };

    await cleanupServiceContainers(docker, ctx);

    expect(docker.getContainer).toHaveBeenCalledWith("c1");
    expect(docker.getContainer).toHaveBeenCalledWith("c2");
    expect(docker.getNetwork).toHaveBeenCalledWith("agent-ci-net-test");
  });

  it("doesn't throw if containers are already gone", async () => {
    const docker = makeMockDocker();
    const ctx = {
      networkName: "agent-ci-net-gone",
      containerIds: ["nonexistent"],
      portForwards: [],
    };
    await expect(cleanupServiceContainers(docker, ctx)).resolves.toBeUndefined();
  });

  it("emits cleanup message", async () => {
    const docker = makeMockDocker();
    const ctx = { networkName: "agent-ci-net-test", containerIds: [], portForwards: [] };
    const lines: string[] = [];

    await cleanupServiceContainers(docker, ctx, (l) => lines.push(l));

    expect(lines.some((l) => l.includes("Cleaned up"))).toBe(true);
    expect(lines.some((l) => l.includes("agent-ci-net-test"))).toBe(true);
  });
});
