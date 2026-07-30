import { describe, it, expect, beforeAll, vi } from "vitest";
import Docker from "dockerode";
import { ensureImagePulled, registryServerAddress } from "./image-pull.ts";
import { resolveDockerSocket } from "./docker-socket.ts";

function makeMockDocker(imagePresent: boolean): Docker {
  const inspect = imagePresent
    ? vi.fn().mockResolvedValue({})
    : vi.fn().mockRejectedValue(new Error("not found"));
  return {
    getImage: vi.fn().mockReturnValue({ inspect }),
    pull: vi.fn().mockImplementation((_image, _options, callback) => callback(null, {})),
    modem: {
      followProgress: vi.fn().mockImplementation((_stream, callback, onProgress) => {
        onProgress?.({
          status: "Downloading",
          id: "layer-1",
          progressDetail: { current: 1, total: 2 },
        });
        callback(null);
      }),
    },
  } as unknown as Docker;
}

describe("ensureImagePulled auth and cache behavior", () => {
  it("does not contact the registry when the image is already cached", async () => {
    const docker = makeMockDocker(true);
    const onPullStart = vi.fn();

    await ensureImagePulled(docker, "ghcr.io/private-org/ci-image:latest", {
      credentials: { username: "ci-user", password: "secret-token" },
      onPullStart,
    });

    expect(docker.pull).not.toHaveBeenCalled();
    expect(onPullStart).not.toHaveBeenCalled();
  });

  it("passes workflow credentials through Docker's auth config", async () => {
    const docker = makeMockDocker(false);
    const onProgress = vi.fn();

    await ensureImagePulled(docker, "ghcr.io/private-org/ci-image:latest", {
      credentials: { username: "ci-user", password: "secret-token" },
      onProgress,
    });

    expect(docker.pull).toHaveBeenCalledWith(
      "ghcr.io/private-org/ci-image:latest",
      {
        authconfig: {
          username: "ci-user",
          password: "secret-token",
          serveraddress: "ghcr.io",
        },
      },
      expect.any(Function),
    );
    expect(onProgress).toHaveBeenCalled();
  });

  it("uses Docker's canonical registry address for Docker Hub images", () => {
    expect(registryServerAddress("ubuntu:latest")).toBe("https://index.docker.io/v1/");
    expect(registryServerAddress("redwoodjs/agent-ci:latest")).toBe("https://index.docker.io/v1/");
    expect(registryServerAddress("localhost:5000/team/image:latest")).toBe("localhost:5000");
  });
});

// Integration test: requires a running Docker daemon and network access.
// Uses hello-world (~13 KB) to keep pull time minimal.
const TEST_IMAGE = "hello-world:latest";

describe("ensureImagePulled", () => {
  let docker: Docker;

  beforeAll(async () => {
    const socket = resolveDockerSocket();
    docker = new Docker({ socketPath: socket.socketPath });
    await docker.ping();
  });

  it("pulls the image when it is not present locally", { timeout: 60_000 }, async () => {
    // Arrange: remove the image so it is definitely absent
    try {
      await docker.getImage(TEST_IMAGE).remove({ force: true });
    } catch {
      // Already absent — fine
    }

    // Act
    await ensureImagePulled(docker, TEST_IMAGE);

    // Assert: image must now be inspectable
    const info = await docker.getImage(TEST_IMAGE).inspect();
    expect(info.RepoTags).toContain(TEST_IMAGE);
  });

  it(
    "rejects with an error when the image does not exist in the registry",
    { timeout: 30_000 },
    async () => {
      await expect(
        ensureImagePulled(docker, "ghcr.io/redwoodjs/agent-ci-does-not-exist:latest"),
      ).rejects.toThrow(
        "Failed to pull Docker image 'ghcr.io/redwoodjs/agent-ci-does-not-exist:latest'",
      );
    },
  );

  it("does nothing when the image is already present", async () => {
    // Arrange: ensure the image is present (previous test or pre-cached)
    await ensureImagePulled(docker, TEST_IMAGE);

    // Act: calling again must not throw
    await expect(ensureImagePulled(docker, TEST_IMAGE)).resolves.toBeUndefined();
  });

  it("dedupes concurrent pulls of the same image", { timeout: 60_000 }, async () => {
    // Arrange: remove the image so all callers hit the pull path
    try {
      await docker.getImage(TEST_IMAGE).remove({ force: true });
    } catch {
      // Already absent — fine
    }

    // Spy on docker.pull so we can count invocations. The dedup cache
    // should ensure a single pull is shared across all concurrent callers.
    const originalPull = docker.pull.bind(docker);
    let pullInvocations = 0;
    (docker as unknown as { pull: Docker["pull"] }).pull = ((
      ...args: Parameters<Docker["pull"]>
    ) => {
      pullInvocations++;
      return originalPull(...args);
    }) as Docker["pull"];

    try {
      // Act: fire 5 concurrent callers before the first pull completes
      await Promise.all([
        ensureImagePulled(docker, TEST_IMAGE),
        ensureImagePulled(docker, TEST_IMAGE),
        ensureImagePulled(docker, TEST_IMAGE),
        ensureImagePulled(docker, TEST_IMAGE),
        ensureImagePulled(docker, TEST_IMAGE),
      ]);
    } finally {
      (docker as unknown as { pull: Docker["pull"] }).pull = originalPull;
    }

    // Assert: exactly one underlying pull, and image is now present
    expect(pullInvocations).toBe(1);
    const info = await docker.getImage(TEST_IMAGE).inspect();
    expect(info.RepoTags).toContain(TEST_IMAGE);
  });
});
