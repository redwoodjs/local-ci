import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerSocket } from "../docker/docker-socket.ts";

const dockerCtor = vi.fn();

vi.mock("dockerode", () => ({
  default: dockerCtor,
}));

vi.mock("dtu-github-actions/ephemeral", () => ({
  startEphemeralDtu: vi.fn(),
}));

afterEach(() => {
  dockerCtor.mockReset();
});

describe("nestedContainerNetworkName", () => {
  it("prefers the current container's non-default Docker network", async () => {
    const mod = await import("./local-job.ts");

    expect(
      mod.nestedContainerNetworkName({
        NetworkSettings: {
          Networks: {
            bridge: {},
            "local-ci-local-ci-1-j1": {},
          },
        },
      }),
    ).toBe("local-ci-local-ci-1-j1");
  });

  it("falls back to bridge when it is the only network", async () => {
    const mod = await import("./local-job.ts");

    expect(
      mod.nestedContainerNetworkName({
        NetworkSettings: {
          Networks: {
            bridge: {},
          },
        },
      }),
    ).toBe("bridge");
  });
});

describe("getDocker client construction", () => {
  it("uses socketPath for unix sockets", async () => {
    const mod = await import("./local-job.ts");
    const socket: DockerSocket = {
      socketPath: "/tmp/docker.sock",
      uri: "unix:///tmp/docker.sock",
      bindMountPath: "/tmp/docker.sock",
    };

    mod.__test_createDockerClient(socket);

    expect(dockerCtor).toHaveBeenCalledWith({ socketPath: "/tmp/docker.sock" });
  });

  it("parses ssh URIs into host/username/port (#322)", async () => {
    const mod = await import("./local-job.ts");
    const socket: DockerSocket = {
      socketPath: "",
      uri: "ssh://user@remote-host",
      bindMountPath: "",
    };

    mod.__test_createDockerClient(socket);

    // Regression: previously we passed the full URI as `host`, which caused
    // ssh2 to DNS-resolve `ssh://user@remote-host` and fail with ENOTFOUND.
    expect(dockerCtor).toHaveBeenCalledWith({
      protocol: "ssh",
      host: "remote-host",
      port: 22,
      username: "user",
      sshOptions: { agent: process.env.SSH_AUTH_SOCK },
    });
  });

  it("parses ssh URIs with explicit port", async () => {
    const mod = await import("./local-job.ts");
    const socket: DockerSocket = {
      socketPath: "",
      uri: "ssh://deploy@remote-host:2222",
      bindMountPath: "",
    };

    mod.__test_createDockerClient(socket);

    expect(dockerCtor).toHaveBeenCalledWith({
      protocol: "ssh",
      host: "remote-host",
      port: 2222,
      username: "deploy",
      sshOptions: { agent: process.env.SSH_AUTH_SOCK },
    });
  });

  it("parses ssh URIs without an explicit username", async () => {
    const mod = await import("./local-job.ts");
    const socket: DockerSocket = {
      socketPath: "",
      uri: "ssh://remote-host",
      bindMountPath: "",
    };

    mod.__test_createDockerClient(socket);

    expect(dockerCtor).toHaveBeenCalledWith({
      protocol: "ssh",
      host: "remote-host",
      port: 22,
      username: undefined,
      sshOptions: { agent: process.env.SSH_AUTH_SOCK },
    });
  });

  it("falls back to dockerode environment parsing for tcp URIs", async () => {
    const mod = await import("./local-job.ts");
    const socket: DockerSocket = {
      socketPath: "",
      uri: "tcp://192.168.110.1:2375",
      bindMountPath: "",
    };

    mod.__test_createDockerClient(socket);

    expect(dockerCtor).toHaveBeenCalledWith();
  });
});
