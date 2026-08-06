/**
 * Parse the `options` string from `jobs.<id>.container.options` into a subset
 * of Docker CLI flags our runner can map to dockerode createContainer fields.
 * Only `--env`/`-e` and `--label`/`-l` are recognized today; anything else
 * is silently ignored to avoid accidentally clashing with local-ci's own
 * container orchestration (volumes, networks, pids, etc). Extend the match
 * list below as additional flags are proven safe via smoke coverage.
 */
export function parseContainerOptions(options: string | undefined): {
  env: string[];
  labels: Record<string, string>;
} {
  const env: string[] = [];
  const labels: Record<string, string> = {};
  if (!options) {
    return { env, labels };
  }
  const tokens = options.match(/\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if ((tok === "--env" || tok === "-e") && i + 1 < tokens.length) {
      env.push(tokens[++i]);
      continue;
    }
    if ((tok === "--label" || tok === "-l") && i + 1 < tokens.length) {
      const kv = tokens[++i];
      const idx = kv.indexOf("=");
      if (idx > 0) {
        labels[kv.slice(0, idx)] = kv.slice(idx + 1);
      } else {
        labels[kv] = "";
      }
    }
  }
  return { env, labels };
}

export interface ContainerEnvOpts {
  containerName: string;
  registrationToken: string;
  repoUrl: string;
  dockerApiUrl: string;
  githubRepo: string;
  headSha?: string;
  dtuHost: string;
  useDirectContainer: boolean;
}

export interface ContainerBindsOpts {
  hostWorkDir: string;
  shimsDir: string;
  signalsDir?: string;
  diagDir: string;
  toolCacheDir: string;
  pnpmStoreDir?: string;
  npmCacheDir?: string;
  yarnCacheDir?: string;
  bunCacheDir?: string;
  playwrightCacheDir: string;
  hostRunnerDir: string;
  useDirectContainer: boolean;
  /** Legacy inputs accepted for callers compiled against the old bind API. They are intentionally ignored. */
  warmModulesDir?: string;
  githubRepo?: string;
  /** Host-side Docker socket path to use as the bind-mount source (use DockerSocket.bindMountPath, not socketPath). */
  dockerSocketPath?: string;
}

export interface ContainerCmdOpts {
  svcPortForwardSnippet: string;
  dtuPort: string;
  dtuHost: string;
  useDirectContainer: boolean;
  containerName: string;
}

// ─── Environment variables ────────────────────────────────────────────────────

/**
 * Build the Env array for `docker.createContainer()`.
 */
export function buildContainerEnv(opts: ContainerEnvOpts): string[] {
  const {
    containerName,
    registrationToken,
    repoUrl,
    dockerApiUrl,
    githubRepo,
    headSha,
    dtuHost,
    useDirectContainer,
  } = opts;

  return [
    `RUNNER_NAME=${containerName}`,
    `RUNNER_TOKEN=${registrationToken}`,
    `RUNNER_REPOSITORY_URL=${repoUrl}`,
    `GITHUB_API_URL=${dockerApiUrl}`,
    `GITHUB_SERVER_URL=${repoUrl}`,
    `GITHUB_REPOSITORY=${githubRepo}`,
    `LOCAL_CI_LOCAL=true`,
    `LOCAL_CI_LOCAL_SYNC=true`,
    `LOCAL_CI_HEAD_SHA=${headSha || "HEAD"}`,
    `LOCAL_CI_DTU_HOST=${dtuHost}`,
    `AGENT_CI_LOCAL=true`,
    `AGENT_CI_LOCAL_SYNC=true`,
    `AGENT_CI_HEAD_SHA=${headSha || "HEAD"}`,
    `AGENT_CI_DTU_HOST=${dtuHost}`,
    `ACTIONS_CACHE_URL=${dockerApiUrl}/`,
    `ACTIONS_RESULTS_URL=${dockerApiUrl}/`,
    `ACTIONS_RUNTIME_TOKEN=mock_cache_token_123`,
    `RUNNER_TOOL_CACHE=/opt/hostedtoolcache`,
    `PATH=/home/runner/externals/node24/bin:/home/runner/externals/node20/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    // Force colour output in all child processes (pnpm, Node, etc.)
    `FORCE_COLOR=1`,
    // Custom containers may run as root and lack libicu — configure accordingly
    ...(useDirectContainer
      ? [`RUNNER_ALLOW_RUNASROOT=1`, `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`]
      : []),
  ];
}

// ─── Bind mounts ──────────────────────────────────────────────────────────────

/**
 * Build the Binds array for `docker.createContainer()`.
 */
export function buildContainerBinds(opts: ContainerBindsOpts): string[] {
  const {
    hostWorkDir,
    shimsDir,
    signalsDir,
    diagDir,
    toolCacheDir,
    pnpmStoreDir,
    npmCacheDir,
    yarnCacheDir,
    bunCacheDir,
    playwrightCacheDir,
    hostRunnerDir,
    useDirectContainer,
    dockerSocketPath = "/var/run/docker.sock",
  } = opts;

  const h = toHostPath;
  return [
    // When using a custom container, bind-mount the extracted runner
    ...(useDirectContainer ? [`${h(hostRunnerDir)}:/home/runner`] : []),
    `${h(hostWorkDir)}:/home/runner/_work`,
    `${dockerSocketPath}:/var/run/docker.sock`,
    `${h(shimsDir)}:/tmp/local-ci-shims`,
    // Pause-on-failure IPC: signal files (paused, retry, abort)
    ...(signalsDir ? [`${h(signalsDir)}:/tmp/local-ci-signals`] : []),
    `${h(diagDir)}:/home/runner/_diag`,
    `${h(toolCacheDir)}:/opt/hostedtoolcache`,
    // Package manager caches (persist across runs, only for detected PM)
    ...(pnpmStoreDir ? [`${h(pnpmStoreDir)}:/home/runner/_work/.pnpm-store`] : []),
    ...(npmCacheDir ? [`${h(npmCacheDir)}:/home/runner/.npm`] : []),
    ...(yarnCacheDir ? [`${h(yarnCacheDir)}:/home/runner/.cache/yarn`] : []),
    ...(bunCacheDir ? [`${h(bunCacheDir)}:/home/runner/.bun`] : []),
    `${h(playwrightCacheDir)}:/home/runner/.cache/ms-playwright`,
  ];
}

// ─── Container command ────────────────────────────────────────────────────────

/**
 * Build the long entrypoint command string for the container.
 */
export function buildContainerCmd(opts: ContainerCmdOpts): string[] {
  const { svcPortForwardSnippet, dtuPort, dtuHost, useDirectContainer, containerName } = opts;

  // The runner connects directly to the DTU host (no in-container proxy needed).
  // The DTU listens on 0.0.0.0 so it's reachable from the container network.
  const dtuBaseUrl = `http://${dtuHost}:${dtuPort}`;

  // For direct containers, credentials are pre-baked on the host and bind-mounted
  // into /home/runner. For the default image, we write them inline in the
  // entrypoint since /home/runner is baked into the image.
  const credentialSnippet = useDirectContainer
    ? ""
    : `echo '{"agentId":1,"agentName":"${containerName}","poolId":1,"poolName":"Default","serverUrl":"${dtuBaseUrl}","gitHubUrl":"${dtuBaseUrl}/'$GITHUB_REPOSITORY'","workFolder":"_work","ephemeral":true}' > /home/runner/.runner && echo '{"scheme":"OAuth","data":{"clientId":"00000000-0000-0000-0000-000000000000","authorizationUrl":"${dtuBaseUrl}/_apis/oauth2/token","oAuthEndpointUrl":"${dtuBaseUrl}/_apis/oauth2/token","requireFipsCryptography":"False"}}' > /home/runner/.credentials && echo '{"d":"CQpCI+sO2GD1N/JsHHI9zEhMlu5Fcc8mU4O2bO6iscOsagFjvEnTesJgydC/Go1HuOBlx+GT9EG2h7+juS0z2o5n8Mvt5BBxlK+tqoDOs8VfQ9CSUl3hqYRPeNdBfnA1w8ovLW0wqfPO08FWTLI0urYsnwjZ5BQrBM+D7zYeA0aCsKdo75bKmaEKnmqrtIEhb7hE45XQa32Yt0RPCPi8QcQAY2HLHbdWdZYDj6k/UuDvz9H/xlDzwYq6Yikk2RSMArFzaufxCGS9tBZNEACDPYgnZnEMXRcvsnZ9FYbq81KOSifCmq7Yocq+j3rY5zJCD+PIDY9QJwPxB4PGasRKAQ==","dp":"A0sY1oOz1+3uUMiy+I5xGuHGHOrEQPYspd1xGClBYYsa/Za0UDWS7V0Tn1cbRWfWtNe5vTpxcvwQd6UZBwrtHF6R2zyXFhE++PLPhCe0tH4C5FY9i9jUw9Vo8t44i/s5JUHU2B1mEptXFUA0GcVrLKS8toZSgqELSS2Q/YLRxoE=","dq":"GrLC9dPJ5n3VYw51ghCH7tybUN9/Oe4T8d9v4dLQ34RQEWHwRd4g3U3zkvuhpXFPloUTMmkxS7MF5pS1evrtzkay4QUTDv+28s0xRuAsw5qNTzuFygg8t93MvpvTVZ2TNApW6C7NFvkL9NbxAnU8+I61/3ow7i6a7oYJJ0hWAxE=","exponent":"AQAB","inverseQ":"8DVz9FSvEdt5W4B9OjgakZHwGfnhn2VLDUxrsR5ilC5tPC/IgA8C2xEfKQM1t+K/N3pAYHBYQ6EPgtW4kquBS/Sy102xbRI7GSCnUbRtTpWYPOaCn6EaxBNzwWzbp5vCbCGvFqlSu4+OBYRVe+iCj+gAnkmT/TKPhHHbTjJHvw==","modulus":"x0eoW2DD7xsW5YiorMN8pNHVvZk4ED1SHlA/bmVnRz5FjEDnQloMn0nBgIUHxoNArksknrp/FOVJv5sJHJTiRZkOp+ZmH7d3W3gmw63IxK2C5pV+6xfav9jR2+Wt/6FMYMgG2utBdF95oif1f2XREFovHoXkWms2l0CPLLHVPO44Hh9EEmBmjOeMJEZkulHJ44z9y8e+GZ2nYqO0ZiRWQcRObZ0vlRaGg6PPOl4ltay0BfNksMB3NDtlhkdVkAEFQxEaZZDK9NtkvNljXCioP3TyTAbqNUGsYCA5D+IHGZT9An99J9vUqTFP6TKjqUvy9WNiIzaUksCySA0a4SVBkQ==","p":"8fgAdmWy+sTzAN19fYkWMQqeC7t1BCQMo5z5knfVLg8TtwP9ZGqDtoe+r0bGv3UgVsvvDdP/QwRvRVP+5G9l999Y6b4VbSdUbrfPfOgjpPDmRTQzHDve5jh5xBENQoRXYm7PMgHGmjwuFsE/tKtSGTrvt2Z3qcYAo0IOqLLhYmE=","q":"0tXx4+P7gUWePf92UJLkzhNBClvdnmDbIt52Lui7YCARczbN/asCDJxcMy6Bh3qmIx/bNuOUrfzHkYZHfnRw8AGEK80qmiLLPI6jrUBOGRajmzemGQx0W8FWalEQfGdNIv9R2nsegDRoMq255Zo/qX60xQ6abpp0c6UNhVYSjTE="}' > /home/runner/.credentials_rsaparams && `;

  // Timing helper: date +%s%3N gives epoch milliseconds
  const T = (label: string) =>
    `T1=$(date +%s%3N); echo "[local-ci:boot] ${label}: $((T1-T0))ms"; T0=$T1`;

  const cmdScript = [
    `MAYBE_SUDO() { if command -v sudo >/dev/null 2>&1; then sudo -n "$@"; else "$@"; fi; }`,
    `BOOT_T0=$(date +%s%3N); T0=$BOOT_T0`,
    // chmod is done host-side in workspacePrepPromise — skip it here
    `if [ -f /usr/bin/git ]; then MAYBE_SUDO mv /usr/bin/git /usr/bin/git.real 2>/dev/null; MAYBE_SUDO cp -p /tmp/local-ci-shims/git /usr/bin/git 2>/dev/null; MAYBE_SUDO chmod +x /usr/bin/git 2>/dev/null; fi`,
    T("git-shim"),
    // The bind-mounted /var/run/docker.sock inherits host ownership (root:docker,
    // 0660 on native Linux Docker). The runner user inside the container is
    // not in the host's docker group, so without this chmod, any step that
    // talks to the Docker socket (docker/setup-buildx-action, docker login,
    // buildx, compose, ...) fails with "permission denied while trying to
    // connect to the docker API at unix:///var/run/docker.sock" (#257).
    // MAYBE_SUDO is required because runner (UID 1001) cannot chmod a
    // root-owned socket without escalation. macOS/OrbStack/Colima usually
    // ship the socket as world-accessible so this is a no-op there.
    `${svcPortForwardSnippet}MAYBE_SUDO chmod 666 /var/run/docker.sock 2>/dev/null || true`,
    T("docker-sock"),
    // The Playwright bind mount creates /home/runner/.cache as root — make it
    // world-writable so tools like Cypress can mkdir inside it (#234).
    `MAYBE_SUDO chmod 1777 /home/runner/.cache 2>/dev/null || true`,
    // On Colima / Docker Desktop the bind-mounted _diag and _work dirs
    // surface as root:root inside the container (host perms don't translate
    // through the VM mount layer), so the runner user (uid 1001) can't
    // write diag logs or workspace scratch files (#263). OrbStack maps
    // UIDs automatically, so this is effectively a no-op there.
    `MAYBE_SUDO chmod 1777 /home/runner/_diag 2>/dev/null || true`,
    `MAYBE_SUDO chmod 1777 /home/runner/_work 2>/dev/null || true`,
    `cd /home/runner`,
    `${credentialSnippet}true`,
    T("credentials"),
    `REPO_NAME=$(basename $GITHUB_REPOSITORY)`,
    `WORKSPACE_PATH=/home/runner/_work/$REPO_NAME/$REPO_NAME`,
    `mkdir -p $WORKSPACE_PATH`,
    T("workspace-setup"),
    `echo "[local-ci:boot] total: $(($(date +%s%3N)-BOOT_T0))ms"`,
    `echo "[local-ci:boot] starting run.sh --once"`,
    `./run.sh --once`,
  ].join(" && ");

  return [...(useDirectContainer ? ["-c"] : ["bash", "-c"]), cmdScript];
}

// ─── DTU host resolution ──────────────────────────────────────────────────────

import fs from "fs";
import { execSync } from "child_process";
import { debugRunner } from "../output/debug.ts";

const DEFAULT_DTU_HOST_ALIAS = "host.docker.internal";
const DEFAULT_DOCKER_BRIDGE_GATEWAY = "172.17.0.1";
const DEFAULT_DOCKER_HOST_GATEWAY = "host-gateway";

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function parseCsvEnv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function resolveDtuHost(): Promise<string> {
  const isInsideDocker = fs.existsSync("/.dockerenv");

  // When running inside a container (nested local-ci), ignore the inherited
  // LOCAL_CI_DTU_HOST — it points to the parent's DTU host (e.g.
  // "host.docker.internal") which isn't reachable from sibling containers.
  // Instead, resolve this container's own IP so the inner container can
  // connect back to our DTU.
  const configuredHost = process.env.LOCAL_CI_DTU_HOST?.trim();
  if (configuredHost && !isInsideDocker) {
    return configuredHost;
  }

  if (isInsideDocker) {
    try {
      const ip = execSync("hostname -I 2>/dev/null | awk '{print $1}'", {
        encoding: "utf8",
      }).trim();
      if (ip) {
        return ip;
      }
    } catch (error: unknown) {
      debugRunner(`Failed to resolve Docker bridge IP via hostname -I: ${String(error)}`);
    }

    return process.env.LOCAL_CI_DOCKER_BRIDGE_GATEWAY?.trim() || DEFAULT_DOCKER_BRIDGE_GATEWAY;
  }

  const configuredGateway = process.env.LOCAL_CI_DOCKER_BRIDGE_GATEWAY?.trim();
  if (configuredGateway) {
    debugRunner(
      `Using configured bridge gateway '${configuredGateway}' for DTU host outside Docker`,
    );
    return configuredGateway;
  }

  return DEFAULT_DTU_HOST_ALIAS;
}

export function resolveDockerExtraHosts(dtuHost: string): string[] | undefined {
  const configuredExtraHosts = process.env.LOCAL_CI_DOCKER_EXTRA_HOSTS;
  if (configuredExtraHosts !== undefined) {
    const parsed = parseCsvEnv(configuredExtraHosts);
    return parsed.length > 0 ? parsed : undefined;
  }

  if (process.env.LOCAL_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS === "1") {
    return undefined;
  }

  if (dtuHost !== DEFAULT_DTU_HOST_ALIAS) {
    return undefined;
  }

  const gateway = process.env.LOCAL_CI_DOCKER_HOST_GATEWAY?.trim() || DEFAULT_DOCKER_HOST_GATEWAY;
  return [`${DEFAULT_DTU_HOST_ALIAS}:${gateway}`];
}

/**
 * Rewrite a DTU URL to be reachable from inside Docker containers.
 */
export function resolveDockerApiUrl(dtuUrl: string, dtuHost: string): string {
  const parsed = new URL(dtuUrl);

  if (isLoopbackHostname(parsed.hostname)) {
    parsed.hostname = dtuHost;
  }

  const serialized = parsed.toString();
  if (parsed.pathname === "/" && !parsed.search && !parsed.hash && serialized.endsWith("/")) {
    return serialized.slice(0, -1);
  }

  return serialized;
}

// ─── Docker-outside-of-Docker path translation ──────────────────────────────

interface MountMapping {
  containerPath: string;
  hostPath: string;
}

let _mountMappings: MountMapping[] | null = null;

/**
 * When running inside a container with Docker-outside-of-Docker (shared socket),
 * bind mount paths must use HOST paths, not container paths. This function
 * inspects our own container's mounts to build a translation table.
 *
 * Returns [] when running on bare metal (no translation needed).
 */
function getMountMappings(): MountMapping[] {
  if (_mountMappings !== null) {
    return _mountMappings;
  }

  if (!fs.existsSync("/.dockerenv")) {
    _mountMappings = [];
    return _mountMappings;
  }

  try {
    const containerId = fs.readFileSync("/etc/hostname", "utf8").trim();
    const json = execSync(`docker inspect ${containerId}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const data = JSON.parse(json);
    const mounts = data[0]?.Mounts || [];
    _mountMappings = mounts
      .filter((m: { Type: string }) => m.Type === "bind")
      .map((m: { Source: string; Destination: string }) => ({
        hostPath: m.Source,
        containerPath: m.Destination,
      }))
      // Sort longest containerPath first for greedy matching
      .sort((a: MountMapping, b: MountMapping) => b.containerPath.length - a.containerPath.length);
  } catch {
    _mountMappings = [];
  }
  return _mountMappings!;
}

/**
 * Translate a local filesystem path to the corresponding Docker host path.
 * Only applies when running inside a container (Docker-outside-of-Docker).
 * Returns the path unchanged when running on bare metal.
 */
export function toHostPath(localPath: string): string {
  const mappings = getMountMappings();
  for (const { containerPath, hostPath } of mappings) {
    if (localPath === containerPath || localPath.startsWith(containerPath + "/")) {
      return hostPath + localPath.slice(containerPath.length);
    }
  }
  return localPath;
}
