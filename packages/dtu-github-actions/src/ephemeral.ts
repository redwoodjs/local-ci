import fs from "node:fs";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { setCacheDir } from "./server/store.ts";
import { bootstrapAndReturnApp } from "./server/index.ts";

export interface EphemeralDtu {
  /** Full URL including port for CLI access (127.0.0.1), e.g. "http://127.0.0.1:49823" */
  url: string;
  /** Full URL including port for container access (host IP), e.g. "http://172.17.0.1:49823" */
  containerUrl: string;
  port: number;
  /** Headers to include when calling internal DTU control endpoints. */
  controlHeaders: Record<string, string>;
  /** Shut down the ephemeral DTU server. */
  close(): Promise<void>;
}

const DEFAULT_DTU_HOST_ALIAS = "host.docker.internal";
const DEFAULT_DOCKER_BRIDGE_GATEWAY = "172.17.0.1";

export function resolveContainerHostForEnv(opts: {
  configuredHost?: string;
  bridgeGateway?: string;
  containerIp?: string;
  isInsideDocker: boolean;
}): string {
  if (opts.configuredHost && !opts.isInsideDocker) {
    return opts.configuredHost;
  }

  if (opts.isInsideDocker) {
    return opts.containerIp || opts.bridgeGateway || DEFAULT_DOCKER_BRIDGE_GATEWAY;
  }

  return DEFAULT_DTU_HOST_ALIAS;
}

function resolveContainerIp(): string | undefined {
  for (const command of ["hostname -I 2>/dev/null", "hostname -i 2>/dev/null"]) {
    try {
      const ip = execSync(command, { encoding: "utf8" }).trim().split(/\s+/)[0];
      if (ip) {
        return ip;
      }
    } catch {
      // Try the next command/fallback.
    }
  }
  return undefined;
}

function resolveContainerHost(): string {
  const isInsideDocker =
    fs.existsSync("/.dockerenv") ||
    process.env.LOCAL_CI_LOCAL === "true" ||
    process.env.LOCAL_CI_LOCAL_SYNC === "true";
  return resolveContainerHostForEnv({
    configuredHost: process.env.LOCAL_CI_DTU_HOST?.trim(),
    bridgeGateway: process.env.LOCAL_CI_DOCKER_BRIDGE_GATEWAY?.trim(),
    containerIp: isInsideDocker ? resolveContainerIp() : undefined,
    isInsideDocker,
  });
}

/**
 * Start an ephemeral in-process DTU server on a random OS-assigned port.
 *
 * Each call creates an independent server instance — no shared state between
 * calls. Typical startup overhead is ~50ms.
 *
 * @param cacheDir  Where cache archives should be stored (e.g. `os.tmpdir()/local-ci/<repo>/cache/dtu`).
 */
export async function startEphemeralDtu(
  cacheDir: string,
  options?: { allowedLogRoot?: string },
): Promise<EphemeralDtu> {
  // Override the cache directory before bootstrapping so the store writes
  // archives to the repo-scoped path rather than the global tmp dir.
  setCacheDir(cacheDir);

  const controlToken = crypto.randomBytes(32).toString("base64url");

  // Build the Polka app with all routes registered.
  const app = await bootstrapAndReturnApp({
    reset: false,
    controlToken,
    allowedLogRoot: options?.allowedLogRoot,
  });

  // Wrap the Polka request handler in a plain Node.js HTTP server so we can
  // bind to port 0 (OS-assigned) and get back the actual port.
  const server = http.createServer((req, res) => {
    // Polka exposes its composed handler as `app.handler`.
    (app as any).handler(req, res);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "0.0.0.0", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        return reject(new Error("Unexpected server address type"));
      }
      resolve(addr.port);
    });
    server.on("error", reject);
  });

  // Use 127.0.0.1 for CLI access and a host reachable from sibling Docker
  // containers for runner access. When local-ci itself is running in Docker,
  // that host must be this container's own IP, not the inherited outer DTU host.
  const containerHost = resolveContainerHost();
  const cliUrl = `http://127.0.0.1:${port}`;
  const containerUrl = `http://${containerHost}:${port}`;

  return {
    url: cliUrl,
    containerUrl,
    port,
    controlHeaders: { "X-Agent-CI-DTU-Token": controlToken },
    close(): Promise<void> {
      return new Promise((resolve) => {
        // Force-close all existing connections (HTTP keep-alive etc.)
        // so the server shuts down immediately instead of waiting for
        // idle connections to drain.
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
