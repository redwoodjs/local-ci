import { describe, expect, it } from "vitest";
import Docker from "dockerode";
import type { DockerSocket } from "../docker/docker-socket.ts";

// End-to-end reproduction for #322: when LOCAL_CI_DOCKER_HOST is an ssh:// URI,
// the Docker client must be wired so docker-modem ends up with the parsed
// hostname (and the username/port carried separately), not the full raw URI.
//
// Pre-fix, getDocker() did `new Docker({ host: socket.uri, protocol: "ssh" })`.
// That left modem.host = "ssh://user@remote-host", causing ssh2 to DNS-resolve
// the literal URI and fail with `getaddrinfo ENOTFOUND`.
describe("getDocker SSH wiring (#322)", () => {
  it("constructs a Docker client whose modem has the parsed hostname, not the URI", async () => {
    const mod = await import("./local-job.ts");
    const socket: DockerSocket = {
      socketPath: "",
      uri: "ssh://user@remote-host",
      bindMountPath: "",
    };

    const docker = mod.__test_createDockerClient(socket) as Docker;

    expect(docker.modem.host).toBe("remote-host");
    expect(docker.modem.host).not.toBe("ssh://user@remote-host");
    expect(docker.modem.username).toBe("user");
    expect(docker.modem.protocol).toBe("ssh");
  });
});
