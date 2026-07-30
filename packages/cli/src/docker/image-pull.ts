import { createHash } from "node:crypto";
import type Docker from "dockerode";

export interface ImageRegistryCredentials {
  username: string;
  password: string;
}

export interface ImagePullProgressEvent {
  status?: string;
  id?: string;
  progressDetail?: { current?: number; total?: number };
}

export interface EnsureImagePulledOptions {
  credentials?: ImageRegistryCredentials;
  onPullStart?: () => void;
  onProgress?: (event: ImagePullProgressEvent) => void;
}

// Dedup concurrent pulls of the same image and credentials. Authenticated and
// anonymous pulls must not share a promise: an anonymous failure must not make
// a valid authenticated pull fail too. See issue #211.
const inflightPulls = new Map<string, Promise<void>>();

/**
 * Ensures a Docker image is present locally, pulling it if not.
 *
 * Docker's createContainer() returns a 404 "No such image" error when the
 * image is absent — it does not pull automatically. Dockerode forwards the
 * optional auth config through Docker's standard X-Registry-Auth header, so
 * the Docker daemon can handle each registry's authentication challenge.
 *
 * Reproduces: https://github.com/redwoodjs/agent-ci/issues/203
 */
export async function ensureImagePulled(
  docker: Docker,
  image: string,
  options: EnsureImagePulledOptions = {},
): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return; // already present
  } catch {
    // Not found locally — fall through to pull
  }

  const pullKey = imagePullKey(image, options.credentials);
  const existing = inflightPulls.get(pullKey);
  if (existing) {
    return existing;
  }

  options.onPullStart?.();
  const pullOptions = options.credentials
    ? {
        authconfig: {
          username: options.credentials.username,
          password: options.credentials.password,
          serveraddress: registryServerAddress(image),
        },
      }
    : {};

  const pull = new Promise<void>((resolve, reject) => {
    docker.pull(image, pullOptions, (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err) {
        return reject(wrapPullError(image, err, !!options.credentials));
      }
      if (!stream) {
        return reject(
          wrapPullError(image, new Error("Docker returned no pull stream"), !!options.credentials),
        );
      }
      docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) {
            reject(wrapPullError(image, err, !!options.credentials));
          } else {
            resolve();
          }
        },
        options.onProgress,
      );
    });
  }).finally(() => {
    inflightPulls.delete(pullKey);
  });

  inflightPulls.set(pullKey, pull);
  return pull;
}

export function registryServerAddress(image: string): string {
  const firstSegment = image.split("/", 1)[0];
  const usesDockerHub =
    !image.includes("/") ||
    (!firstSegment.includes(".") && !firstSegment.includes(":") && firstSegment !== "localhost");

  if (usesDockerHub || firstSegment === "docker.io" || firstSegment === "index.docker.io") {
    return "https://index.docker.io/v1/";
  }
  return firstSegment;
}

function imagePullKey(image: string, credentials?: ImageRegistryCredentials): string {
  if (!credentials) {
    return `${image}\0anonymous`;
  }
  const authFingerprint = createHash("sha256")
    .update(credentials.username)
    .update("\0")
    .update(credentials.password)
    .digest("base64url");
  return `${image}\0${authFingerprint}`;
}

function wrapPullError(image: string, cause: Error, hadCredentials: boolean): Error {
  const authHint = hadCredentials
    ? "    • The registry credentials are invalid or expired\n"
    : "    • The image is private and no workflow credentials were provided\n";
  return new Error(
    `Failed to pull Docker image '${image}': ${cause.message}\n` +
      "\n" +
      "  Possible causes:\n" +
      "    • The image name is misspelled or does not exist in the registry\n" +
      authHint +
      "    • No network connection",
  );
}
