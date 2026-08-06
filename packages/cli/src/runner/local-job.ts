import Docker from "dockerode";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import { createInterface } from "readline";
import { config } from "../config.ts";
import type { Job } from "../types.ts";
import { createLogContext } from "../output/logger.ts";
import { getWorkingDirectory } from "../output/working-directory.ts";

import { debugRunner, debugBoot } from "../output/debug.ts";
import {
  startServiceContainers,
  cleanupServiceContainers,
  type ServiceContext,
} from "../docker/service-containers.ts";
import { killRunnerContainers } from "../docker/shutdown.ts";
import { startEphemeralDtu } from "dtu-github-actions/ephemeral";
import { type JobResult, tailLogFile } from "../output/reporter.ts";
import { RunStateStore, type StepState } from "../output/run-state.ts";

import { writeJobMetadata } from "./metadata.ts";
import { writeGitShim } from "./git-shim.ts";
import { prepareWorkspace } from "./workspace.ts";
import { createRunDirectories } from "./directory-setup.ts";
import { publishDependencyCache, restoreDependencyCache } from "./node-modules-cache.ts";
import { writeDetachedMarker } from "../launcher.ts";
import {
  buildContainerEnv,
  buildContainerBinds,
  buildContainerCmd,
  parseContainerOptions,
  resolveDtuHost,
  resolveDockerApiUrl,
  resolveDockerExtraHosts,
} from "../docker/container-config.ts";
import { buildJobResult, isJobSuccessful } from "./result-builder.ts";
import { ensureImagePulled, type ImageRegistryCredentials } from "../docker/image-pull.ts";
import { wrapJobSteps, appendOutputCaptureStep } from "./step-wrapper.ts";
import { syncWorkspaceForRetry } from "./sync.ts";
import {
  discoverRunnerImage,
  ensureRunnerImage,
  UPSTREAM_RUNNER_IMAGE,
  type ResolvedRunnerImage,
} from "./runner-image.ts";
import { findRepoRoot } from "./metadata.ts";

// Fix permissions after extracting runner from container.
// docker cp and cp -a copy files with restrictive permissions (often root-owned),
// which breaks the runner's ability to create files like run-helper.sh.
// Directories get 777 (world-writable), files get 755 (world-readable + executable).
function ensureRunnerWriteable(rootDir: string): void {
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const stat = fs.statSync(current);
    // Directories need full write access (777), files need read+execute for all (755)
    fs.chmodSync(current, stat.isDirectory() ? 0o777 : 0o755);

    if (!stat.isDirectory()) {
      continue;
    }

    for (const entry of fs.readdirSync(current)) {
      stack.push(path.join(current, entry));
    }
  }
}

// ─── Docker setup ─────────────────────────────────────────────────────────────

import { resolveDockerSocket, type DockerSocket } from "../docker/docker-socket.ts";

let _resolvedSocket: DockerSocket | null = null;
let _docker: Docker | null = null;

function getDockerSocket(): DockerSocket {
  if (!_resolvedSocket) {
    _resolvedSocket = resolveDockerSocket();
  }
  return _resolvedSocket;
}

export function getDocker(): Docker {
  if (!_docker) {
    const socket = getDockerSocket();
    if (socket.socketPath) {
      _docker = new Docker({ socketPath: socket.socketPath });
    } else if (socket.uri.startsWith("ssh://")) {
      // dockerode/docker-modem expects `host` to be the hostname only, with
      // username/port carried separately. Passing the raw URI made ssh2 try
      // to DNS-resolve `ssh://user@host`, failing with ENOTFOUND (#322).
      const parsed = new URL(socket.uri);
      _docker = new Docker({
        protocol: "ssh" as const,
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 22,
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        sshOptions: { agent: process.env.SSH_AUTH_SOCK },
      });
    } else {
      // Let dockerode/docker-modem parse non-unix, non-ssh host URIs from the
      // environment. cli.ts forwards LOCAL_CI_DOCKER_HOST → DOCKER_HOST at
      // bootstrap so dockerode's default client still picks up tcp:// URIs.
      _docker = new Docker();
    }
  }
  return _docker;
}

export function __test_createDockerClient(socket: DockerSocket): Docker {
  _resolvedSocket = socket;
  _docker = null;
  return getDocker();
}

export function nestedContainerNetworkName(inspectResult: any): string | undefined {
  const networks = inspectResult?.NetworkSettings?.Networks;
  if (!networks || typeof networks !== "object") {
    return undefined;
  }

  const networkNames = Object.keys(networks).filter(
    (name) => !["bridge", "host", "none"].includes(name),
  );
  return networkNames[0] ?? Object.keys(networks)[0];
}

async function resolveNestedContainerNetworkName(
  containerId: string | undefined,
): Promise<string | undefined> {
  if (!containerId) {
    return undefined;
  }
  try {
    const inspectResult = await getDocker().getContainer(containerId).inspect();
    const networkName = nestedContainerNetworkName(inspectResult);
    if (networkName) {
      debugRunner(`Nested container network detected: ${networkName}`);
    }
    return networkName;
  } catch (error) {
    debugRunner(`Failed to inspect nested container network for ${containerId}: ${String(error)}`);
    return undefined;
  }
}

// The upstream runner image is always needed as the seed source when a job
// uses a custom `container:` directive — we extract the runner binary from it
// regardless of what image the user's steps run in. In default mode (no
// `container:`), the actual runtime image is resolved per-job via
// discoverRunnerImage() and may be a user-provided Dockerfile build.
const SEED_IMAGE = UPSTREAM_RUNNER_IMAGE;

import { writeRunnerCredentials } from "./runner-credentials.ts";

const CONTAINER_EXIT_TIMEOUT_MS = 30_000;

/**
 * Pull a Docker image and report per-layer download / extraction progress to
 * the RunStateStore. Resolves once the pull completes. Rejects on any error
 * the daemon surfaces.
 */
async function pullContainerImageWithProgress(
  docker: Docker,
  image: string,
  store: RunStateStore | undefined,
  containerName: string,
  credentials?: ImageRegistryCredentials,
): Promise<void> {
  const downloadProgress = new Map<string, { current: number; total: number }>();
  const extractProgress = new Map<string, { current: number; total: number }>();
  let lastProgressUpdate = 0;
  let currentPhase: "downloading" | "extracting" = "downloading";

  const flushProgress = (force = false) => {
    const map = currentPhase === "downloading" ? downloadProgress : extractProgress;
    if (map.size === 0) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastProgressUpdate < 250) {
      return;
    }
    lastProgressUpdate = now;
    let totalBytes = 0;
    let currentBytes = 0;
    for (const layer of map.values()) {
      totalBytes += layer.total;
      currentBytes += layer.current;
    }
    store?.updateJob(containerName, {
      pullProgress: { phase: currentPhase, currentBytes, totalBytes },
    });
  };

  try {
    await ensureImagePulled(docker, image, {
      credentials,
      onPullStart: () => debugRunner(`Pulling ${image}...`),
      onProgress: (event) => {
        if (!event.id) {
          return;
        }

        const detail = event.progressDetail;
        const hasByteCounts =
          detail &&
          typeof detail.current === "number" &&
          typeof detail.total === "number" &&
          detail.total > 0;

        if (event.status === "Downloading" && hasByteCounts) {
          downloadProgress.set(event.id, {
            current: detail.current!,
            total: detail.total!,
          });
        } else if (event.status === "Download complete") {
          const existing = downloadProgress.get(event.id);
          if (existing) {
            existing.current = existing.total;
          }
        } else if (event.status === "Extracting" && hasByteCounts) {
          const phaseChanged = currentPhase !== "extracting";
          currentPhase = "extracting";
          extractProgress.set(event.id, {
            current: detail.current!,
            total: detail.total!,
          });
          // Force update on first extraction event so the phase change is visible immediately
          if (phaseChanged) {
            flushProgress(true);
            return;
          }
        } else if (event.status === "Pull complete") {
          const existing = extractProgress.get(event.id);
          if (existing) {
            existing.current = existing.total;
          }
        } else {
          return;
        }

        flushProgress();
      },
    });
  } finally {
    store?.updateJob(containerName, { pullProgress: undefined });
  }
}

/**
 * Extract the actions-runner binary from the SEED_IMAGE to `hostRunnerSeedDir`
 * once and reuse it on subsequent calls. Direct-container mode injects this
 * runner into the user's chosen image so we don't have to fork their entrypoint.
 *
 * Skipped when the seed dir already has a `.seeded` marker and `run.sh`.
 */
async function seedRunnerBinaryToHost(docker: Docker, hostRunnerSeedDir: string): Promise<void> {
  await fs.promises.mkdir(hostRunnerSeedDir, { recursive: true });
  const markerFile = path.join(hostRunnerSeedDir, ".seeded");
  const runShExists = fs.existsSync(path.join(hostRunnerSeedDir, "run.sh"));
  const needsSeed = !fs.existsSync(markerFile) || !runShExists;
  if (needsSeed) {
    if (!runShExists && fs.existsSync(markerFile)) {
      debugRunner(`Runner seed is incomplete (run.sh missing), re-extracting...`);
    } else {
      debugRunner(`Extracting runner binary to host (one-time)...`);
    }
    const tmpName = `local-ci-seed-runner-${Date.now()}`;
    const seedContainer = await docker.createContainer({
      Image: SEED_IMAGE,
      name: tmpName,
      Cmd: ["true"],
    });
    execSync(`docker cp ${tmpName}:/home/runner/. "${hostRunnerSeedDir}/"`, { stdio: "pipe" });
    await seedContainer.remove();
    const configShPath = path.join(hostRunnerSeedDir, "config.sh");
    let configSh = await fs.promises.readFile(configShPath, "utf8");
    configSh = configSh.replace(
      /# Check dotnet Core.*?^fi$/ms,
      "# Dependency checks removed for container injection",
    );
    await fs.promises.writeFile(configShPath, configSh);
    await fs.promises.writeFile(markerFile, new Date().toISOString());
    ensureRunnerWriteable(hostRunnerSeedDir);
    debugRunner(`Runner extracted.`);
  }
  for (const staleFile of [".runner", ".credentials", ".credentials_rsaparams"]) {
    try {
      fs.rmSync(path.join(hostRunnerSeedDir, staleFile));
    } catch {
      /* not present */
    }
  }
}

/**
 * Mutable state tracked across timeline-poll ticks. The store-sync helper
 * mutates the fields in place; the polling loop and the rest of
 * `executeLocalJob` read them once the loop finishes.
 */
type TimelineSyncState = {
  lastSeenAttempt: number;
  isPaused: boolean;
  pausedAtMs: number | null;
  pausedStepName: string | null;
  isBooting: boolean;
  lastFailedStep: string | null;
};

/** Read-only inputs the store-sync helper needs but does not mutate. */
type TimelineSyncContext = {
  pauseOnFailure: boolean;
  pausedSignalPath: string;
  signalsDir: string;
  timelinePath: string;
  bootStart: number;
  containerName: string;
  store: RunStateStore | undefined;
  /** Called the first time a pause is detected — sets up the Enter-to-retry stdin listener. */
  onNewPause: () => void;
};

/** Result of folding the timeline-records list into a render-ready shape. */
type BuiltSteps = {
  newSteps: StepState[];
  totalDurationMs: number | undefined;
  jobFinished: boolean;
};

/**
 * Fold the raw actions-runner timeline records into the `StepState[]` shape
 * the renderer expects. Mutates `state.lastFailedStep` when a step result is
 * "failed". Skips duplicate names; the second occurrence (e.g. for a "Post"
 * step) triggers a synthetic "Post Setup" row at the end.
 */
function buildStepsFromTimeline(steps: any[], state: TimelineSyncState): BuiltSteps {
  const seenNames = new Set<string>();
  let hasPostSteps = false;
  let completeJobRecord: any = null;

  const preCountNames = new Set<string>();
  for (const r of steps) {
    if (!preCountNames.has(r.name)) {
      preCountNames.add(r.name);
    } else {
      hasPostSteps = true;
    }
  }

  let stepIdx = 0;
  const newSteps: StepState[] = [];

  for (const r of steps) {
    if (seenNames.has(r.name)) {
      continue;
    }
    seenNames.add(r.name);

    if (r.name === "Complete job") {
      completeJobRecord = r;
      continue;
    }
    stepIdx++;

    const durationMs =
      r.startTime && r.finishTime
        ? new Date(r.finishTime).getTime() - new Date(r.startTime).getTime()
        : undefined;

    let status: StepState["status"];
    if (!r.result && r.state !== "completed") {
      if (r.startTime) {
        status = state.isPaused && state.pausedStepName === r.name ? "paused" : "running";
      } else {
        status = "pending";
      }
    } else {
      const result = (r.result || "").toLowerCase();
      if (result === "failed") {
        state.lastFailedStep = r.name;
        status = "failed";
      } else if (result === "skipped") {
        status = "skipped";
      } else {
        status = "completed";
      }
    }

    newSteps.push({
      name: r.name,
      index: stepIdx,
      status,
      startedAt: r.startTime,
      completedAt: r.finishTime,
      durationMs,
    });
  }

  const jobFinished = !!completeJobRecord?.result;

  if (hasPostSteps && jobFinished) {
    stepIdx++;
    newSteps.push({ name: "Post Setup", index: stepIdx, status: "completed" });
  }

  if (completeJobRecord && jobFinished) {
    stepIdx++;
    const durationMs =
      completeJobRecord.startTime && completeJobRecord.finishTime
        ? new Date(completeJobRecord.finishTime).getTime() -
          new Date(completeJobRecord.startTime).getTime()
        : undefined;
    newSteps.push({
      name: "Complete job",
      index: stepIdx,
      status: "completed",
      startedAt: completeJobRecord.startTime,
      completedAt: completeJobRecord.finishTime,
      durationMs,
    });
  }

  // Total job duration spans first step start to last step end.
  let totalDurationMs: number | undefined;
  if (jobFinished) {
    const allTimes = steps
      .filter((r) => r.startTime && r.finishTime)
      .map((r) => ({
        start: new Date(r.startTime).getTime(),
        end: new Date(r.finishTime).getTime(),
      }));
    if (allTimes.length > 0) {
      const earliest = Math.min(...allTimes.map((t) => t.start));
      const latest = Math.max(...allTimes.map((t) => t.end));
      const ms = latest - earliest;
      if (!isNaN(ms) && ms >= 0) {
        totalDurationMs = ms;
      }
    }
  }

  return { newSteps, totalDurationMs, jobFinished };
}

/**
 * One poll tick of the actions-runner timeline.json into the RunStateStore.
 * Reads the paused-signal file (if `pauseOnFailure` is set) and the timeline
 * JSON; updates the store and the mutable `state` in place. Errors are
 * swallowed — this is best-effort and runs every 100ms.
 */
function syncTimelineToStore(state: TimelineSyncState, ctx: TimelineSyncContext): void {
  try {
    // ── Pause-on-failure: check for paused signal ───────────────────────────
    if (ctx.pauseOnFailure && fs.existsSync(ctx.pausedSignalPath)) {
      const content = fs.readFileSync(ctx.pausedSignalPath, "utf-8").trim();
      const lines = content.split("\n");
      state.pausedStepName = lines[0] || null;
      const attempt = parseInt(lines[1] || "1", 10);
      const isNewAttempt = attempt !== state.lastSeenAttempt;
      if (isNewAttempt) {
        state.lastSeenAttempt = attempt;
        state.isPaused = true;
        state.pausedAtMs = Date.now();
        ctx.onNewPause();
      }

      // Read output captured by the wrapper script's tee — written directly
      // to the signals dir so it's always available when paused.
      const tailLines = tailLogFile(path.join(ctx.signalsDir, "step-output"), 20);

      ctx.store?.updateJob(ctx.containerName, {
        status: "paused",
        pausedAtStep: state.pausedStepName || undefined,
        ...(isNewAttempt && state.pausedAtMs !== null
          ? { pausedAtMs: new Date(state.pausedAtMs).toISOString(), attempt: state.lastSeenAttempt }
          : {}),
        lastOutputLines: tailLines,
      });
    } else if (state.isPaused && !fs.existsSync(ctx.pausedSignalPath)) {
      // Pause signal removed — job is retrying
      state.isPaused = false;
      state.pausedAtMs = null;
      ctx.store?.updateJob(ctx.containerName, { status: "running", pausedAtMs: undefined });
    }

    if (!fs.existsSync(ctx.timelinePath)) {
      return;
    }

    const records = JSON.parse(fs.readFileSync(ctx.timelinePath, "utf-8")) as any[];
    const steps = records
      .filter((r) => r.type === "Task" && r.name)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    if (steps.length === 0) {
      return;
    }

    // ── Transition from booting to running on first timeline entry ──────────
    if (state.isBooting) {
      state.isBooting = false;
      debugBoot(`${ctx.containerName} total: ${Date.now() - ctx.bootStart}ms`);
      ctx.store?.updateJob(ctx.containerName, {
        status: state.isPaused ? "paused" : "running",
        bootDurationMs: Date.now() - ctx.bootStart,
      });
    }

    const { newSteps, totalDurationMs, jobFinished } = buildStepsFromTimeline(steps, state);

    ctx.store?.updateJob(ctx.containerName, {
      steps: newSteps,
      ...(jobFinished
        ? {
            status: state.lastFailedStep ? "failed" : "completed",
            failedStep: state.lastFailedStep || undefined,
            durationMs: totalDurationMs,
          }
        : {}),
    });
  } catch {
    // Best-effort
  }
}

/**
 * Wait for a container's exit, but bail out after `timeoutMs` and stop the
 * container if the runner keeps the entrypoint alive past that. Returns the
 * exit code the daemon reports.
 */
async function waitForContainerExit(
  container: Docker.Container,
  containerWaitPromise: Promise<{ StatusCode: number }>,
  timeoutMs: number,
): Promise<number> {
  let waitResult: { StatusCode: number };
  try {
    waitResult = await Promise.race([
      containerWaitPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Container exit timeout")), timeoutMs),
      ),
    ]);
  } catch {
    debugRunner(`Runner did not exit within ${timeoutMs / 1000}s, force-stopping container…`);
    try {
      await container.stop({ t: 5 });
    } catch {
      /* already stopped */
    }
    waitResult = await container.wait();
  }
  return waitResult.StatusCode;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function executeLocalJob(
  job: Job,
  options?: { pauseOnFailure?: boolean; store?: RunStateStore },
): Promise<JobResult> {
  const pauseOnFailure = options?.pauseOnFailure ?? false;
  const startTime = Date.now();
  const store = options?.store;

  // ── Pre-flight: verify Docker is reachable ────────────────────────────────
  try {
    await getDocker().ping();
  } catch (err: any) {
    const isSocket = err?.code === "ECONNREFUSED" || err?.code === "ENOENT";
    const hint = isSocket
      ? "Docker does not appear to be running."
      : `Docker is not reachable: ${err?.message || err}`;
    throw new Error(
      `${hint}\n` +
        "\n" +
        "  To fix this:\n" +
        "    1. Start your Docker runtime (OrbStack, Docker Desktop, etc.)\n" +
        "    2. Wait for the engine to be ready\n" +
        "    3. Re-run the workflow\n",
    );
  }

  // ── Prepare directories ───────────────────────────────────────────────────
  // When running nested (another local-ci is our parent), include a short
  // hostname suffix in the prefix so sibling container names don't collide
  // with a concurrent nested run inside a different parent container. Some
  // runner images do not expose /.dockerenv, so also trust the env that our
  // outer runner injects into job containers.
  const isNestedContainer =
    fs.existsSync("/.dockerenv") ||
    process.env.LOCAL_CI_LOCAL === "true" ||
    process.env.LOCAL_CI_LOCAL_SYNC === "true";
  const nestedHost = isNestedContainer ? process.env.HOSTNAME?.slice(0, 12) : "";
  const nestedNetworkName = await resolveNestedContainerNetworkName(nestedHost);
  const prefix = nestedHost ? `local-ci-${nestedHost}` : "local-ci";
  const preferredContainerName = nestedHost ? `${prefix}-${job.runnerName}` : job.runnerName;
  const {
    name: containerName,
    runDir,
    logDir,
    debugLogPath,
  } = createLogContext(prefix, preferredContainerName);

  // Register the job in the store so the render loop can show the boot spinner
  store?.addJob(
    job.parentWorkflowPath ?? job.workflowPath ?? "",
    job.taskId ?? "job",
    containerName,
    {
      logDir,
      debugLogPath,
    },
  );
  store?.updateJob(containerName, {
    status: "booting",
    startedAt: new Date().toISOString(),
    logDir,
    debugLogPath,
  });

  const bootStart = Date.now();
  const bt = (label: string, since: number) => {
    debugBoot(`${containerName} ${label}: ${Date.now() - since}ms`);
    return Date.now();
  };

  // Start an ephemeral in-process DTU for this job run so each job gets its
  // own isolated DTU instance on a random port — eliminating port conflicts.
  let t0 = Date.now();
  const dtuCacheDir = path.resolve(getWorkingDirectory(), "cache", "dtu");
  let ephemeralDtu: Awaited<ReturnType<typeof startEphemeralDtu>> | null = null;
  try {
    ephemeralDtu = await startEphemeralDtu(dtuCacheDir, { allowedLogRoot: path.dirname(logDir) });
    debugRunner(
      `DTU server started - CLI URL: ${ephemeralDtu.url}, Container URL: ${ephemeralDtu.containerUrl}`,
    );
  } catch (e) {
    debugRunner(`Failed to start ephemeral DTU: ${e}`);
  }
  // CLI uses url (127.0.0.1), containers use containerUrl (host IP)
  const dtuUrl = ephemeralDtu?.url ?? config.GITHUB_API_URL;
  const dtuContainerUrl = ephemeralDtu?.containerUrl ?? dtuUrl;
  const dtuControlHeaders = {
    "Content-Type": "application/json",
    ...ephemeralDtu?.controlHeaders,
  };
  t0 = bt("dtu-start", t0);

  // ── Create run directories ────────────────────────────────────────────────
  // Done before DTU registration so we can use the detected package manager
  // to scope virtualCachePatterns to only the relevant PM.
  const dirs = createRunDirectories({
    runDir,
    githubRepo: job.githubRepo!,
    workflowPath: job.workflowPath,
  });
  debugRunner(`Detected package manager: ${dirs.detectedPM ?? "none (mounting all PM caches)"}`);

  // Drop the detached-worker marker so `local-ci retry --name X` (running in
  // a separate process) can find this worker's log and tail it after sending
  // the retry signal. No-op outside detached mode. See issue #315.
  writeDetachedMarker(runDir);

  await fetch(`${dtuUrl}/_dtu/start-runner`, {
    method: "POST",
    headers: dtuControlHeaders,
    body: JSON.stringify({
      runnerName: containerName,
      logDir,
      timelineDir: logDir,
      // Package manager stores are bind-mounted into the container, so there's
      // no need for the runner to tar/gzip them. Tell the DTU to return a
      // synthetic hit for any cache key matching these patterns — skipping the
      // 60s+ tar entirely.
      // "bun" is excluded: it collides with oven-sh/setup-bun cache keys
      // (format `bun-<sha1>`), causing a fake hit that hides the real binary.
      virtualCachePatterns: dirs.detectedPM
        ? dirs.detectedPM === "bun"
          ? []
          : [dirs.detectedPM]
        : ["pnpm", "npm", "yarn"],
    }),
  }).catch(() => {
    /* non-fatal */
  });
  t0 = bt("dtu-register", t0);

  // Write metadata if available (to help the UI map logs to workflows)
  writeJobMetadata({ logDir, containerName, job });

  // Open debug stream to capture raw container output
  const debugStream = fs.createWriteStream(debugLogPath);

  // Hoisted for cleanup in `finally` — assigned inside the try block.
  let container: Docker.Container | null = null;
  let serviceCtx: ServiceContext | undefined;
  const hostRunnerDir = path.resolve(runDir, "runner");

  // Signal handler: ensure cleanup runs even when killed.
  // Do NOT call process.exit() here — multiple jobs register handlers concurrently,
  // and an early exit would prevent other jobs' handlers from cleaning up their containers.
  // killRunnerContainers already handles the runner, its svc-* sidecars, and the network.
  const signalCleanup = () => {
    killRunnerContainers(containerName);
    for (const d of [
      dirs.containerWorkDir,
      dirs.shimsDir,
      dirs.signalsDir,
      dirs.diagDir,
      hostRunnerDir,
    ]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  };
  process.on("SIGINT", signalCleanup);
  process.on("SIGTERM", signalCleanup);
  process.on("SIGHUP", signalCleanup);

  try {
    // 1. Seed the job to Local DTU
    const [githubOwner, githubRepoName] = (job.githubRepo || "").split("/");
    const overriddenRepository = job.githubRepo
      ? {
          full_name: job.githubRepo,
          name: githubRepoName,
          owner: { login: githubOwner },
          default_branch: job.repository?.default_branch || "main",
        }
      : job.repository;

    const wrappedSteps = pauseOnFailure ? wrapJobSteps(job.steps ?? [], true) : job.steps;
    const seededSteps = appendOutputCaptureStep(wrappedSteps ?? []);

    // Pin runnerName so the job goes to the runner-specific pool, not the
    // shared generic pool where a runner from another concurrent workflow
    // could steal it (see issue #103).
    job.runnerName = containerName;

    t0 = Date.now();
    const seedResponse = await fetch(`${dtuUrl}/_dtu/seed`, {
      method: "POST",
      headers: dtuControlHeaders,
      body: JSON.stringify({
        id: job.githubJobId || "1",
        name: "job",
        status: "queued",
        localPath: dirs.workspaceDir,
        ...job,
        steps: seededSteps,
        repository: overriddenRepository,
      }),
    });
    if (!seedResponse.ok) {
      throw new Error(`Failed to seed DTU: ${seedResponse.status} ${seedResponse.statusText}`);
    }
    t0 = bt("dtu-seed", t0);

    // 2. Registration token (mock for local)
    const registrationToken = "mock_local_token";

    // 4. Write git shim BEFORE container start so the entrypoint can install it
    // immediately. On Linux, prepareWorkspace (rsync) is slow enough that the
    // container entrypoint would race ahead and find an empty shims dir.
    writeGitShim(dirs.shimsDir, job.realHeadSha);

    // Prepare workspace files in parallel with container setup
    const workspacePrepStart = Date.now();
    const workspacePrepPromise = (async () => {
      try {
        await prepareWorkspace({
          workflowPath: job.workflowPath,
          headSha: job.headSha,
          githubRepo: job.githubRepo,
          workspaceDir: dirs.workspaceDir,
        });
      } catch (err) {
        debugRunner(`Failed to prepare workspace: ${err}. Using host fallback.`);
      }

      if (dirs.dependencyCacheDir) {
        const restored = restoreDependencyCache(
          dirs.dependencyCacheDir,
          path.join(dirs.workspaceDir, "node_modules"),
        );
        if (restored.restored) {
          debugRunner(
            `Restored private node_modules snapshot via ${restored.strategy} in ${restored.durationMs}ms`,
          );
        } else if (restored.mode === "download-only") {
          debugRunner("Using private node_modules with the shared package-manager download cache");
        }
      }

      try {
        const execAsync = promisify(exec);
        await execAsync(`chmod -R 777 "${dirs.containerWorkDir}" "${dirs.diagDir}"`);
      } catch {
        // Non-fatal: entrypoint has a fallback
      }
      bt("workspace-prep", workspacePrepStart);
    })();

    // 6. Spawn container
    const dtuHost = await resolveDtuHost();
    const dockerApiUrl = resolveDockerApiUrl(dtuContainerUrl, dtuHost);
    const parsedDockerApiUrl = new URL(dockerApiUrl);
    const dtuPort =
      parsedDockerApiUrl.port || (parsedDockerApiUrl.protocol === "https:" ? "443" : "80");
    const githubRepo = job.githubRepo!;
    const repoUrl = `${dockerApiUrl}/${githubRepo}`;

    debugRunner(`Spawning container ${containerName}...`);
    debugRunner(`DTU config - Port: ${dtuPort}, Host: ${dtuHost}, Docker API: ${dockerApiUrl}`);
    debugRunner(`Runner will connect to: ${repoUrl}`);

    // Pre-cleanup: remove any stale container with the same name
    try {
      const stale = getDocker().getContainer(containerName);
      await stale.remove({ force: true });
    } catch {
      // Ignore - container doesn't exist
    }

    // ── Service containers ────────────────────────────────────────────────────
    if (job.services && job.services.length > 0) {
      const svcStart = Date.now();
      debugRunner(`Starting ${job.services.length} service container(s)...`);
      serviceCtx = await startServiceContainers(getDocker(), job.services, containerName, (line) =>
        debugRunner(line),
      );
      bt("service-containers", svcStart);
    }

    const svcPortForwardSnippet = serviceCtx?.portForwards.length
      ? serviceCtx.portForwards.join(" \n") + " \nsleep 0.3 && "
      : "";

    // ── Direct container injection ─────────────────────────────────────────────
    const hostWorkDir = dirs.containerWorkDir;
    const hostRunnerSeedDir = path.resolve(getWorkingDirectory(), "runner");
    const useDirectContainer = !!job.container;

    // Resolve the runner image for default mode (no `container:` directive).
    // Checks LOCAL_CI_RUNNER_IMAGE env var, then .github/local-ci/Dockerfile,
    // then .github/local-ci.Dockerfile, then falls back to the upstream image.
    // In direct-container mode this is unused at runtime — the user's image
    // wins — but we still need SEED_IMAGE pulled for the runner binary seed.
    let resolvedRunnerImage: ResolvedRunnerImage;
    let containerImage: string;
    if (useDirectContainer) {
      resolvedRunnerImage = {
        image: SEED_IMAGE,
        source: "default",
        sourceLabel: "built-in default",
        needsBuild: false,
      };
      await ensureImagePulled(getDocker(), SEED_IMAGE);
      containerImage = job.container!.image;
    } else {
      const repoRoot = (job.workflowPath && findRepoRoot(job.workflowPath)) || process.cwd();
      resolvedRunnerImage = discoverRunnerImage(repoRoot);
      containerImage = await ensureRunnerImage(getDocker(), resolvedRunnerImage);
    }

    if (useDirectContainer) {
      await seedRunnerBinaryToHost(getDocker(), hostRunnerSeedDir);
      execSync(`cp -a "${hostRunnerSeedDir}" "${hostRunnerDir}"`, { stdio: "pipe" });

      const resolvedUrl = `${dockerApiUrl}/${githubRepo}`;
      writeRunnerCredentials(hostRunnerDir, containerName, resolvedUrl);

      await pullContainerImageWithProgress(
        getDocker(),
        containerImage,
        store,
        containerName,
        job.container!.credentials,
      );
    }

    const containerEnv = buildContainerEnv({
      containerName,
      registrationToken,
      repoUrl,
      dockerApiUrl,
      githubRepo,
      headSha: job.headSha,
      dtuHost,
      useDirectContainer,
    });

    const containerBinds = buildContainerBinds({
      hostWorkDir,
      shimsDir: dirs.shimsDir,
      signalsDir: pauseOnFailure ? dirs.signalsDir : undefined,
      diagDir: dirs.diagDir,
      toolCacheDir: dirs.toolCacheDir,
      pnpmStoreDir: dirs.pnpmStoreDir,
      npmCacheDir: dirs.npmCacheDir,
      yarnCacheDir: dirs.yarnCacheDir,
      bunCacheDir: dirs.bunCacheDir,
      playwrightCacheDir: dirs.playwrightCacheDir,
      hostRunnerDir,
      useDirectContainer,
      dockerSocketPath: getDockerSocket().bindMountPath || undefined,
    });

    const containerCmd = buildContainerCmd({
      svcPortForwardSnippet,
      dtuPort,
      dtuHost,
      useDirectContainer,
      containerName,
    });

    const extraHosts = resolveDockerExtraHosts(dtuHost);

    const extraContainerOpts = parseContainerOptions(job.container?.options);

    t0 = Date.now();
    container = await getDocker().createContainer({
      Image: containerImage,
      name: containerName,
      Labels: {
        "local-ci.pid": String(process.pid),
        ...extraContainerOpts.labels,
      },
      Env: [...containerEnv, ...extraContainerOpts.env],
      ...(useDirectContainer ? { Entrypoint: ["bash"] } : {}),
      Cmd: containerCmd,
      HostConfig: {
        Binds: containerBinds,
        AutoRemove: false,
        Ulimits: [{ Name: "nofile", Soft: 65536, Hard: 65536 }],
        ...(serviceCtx
          ? { NetworkMode: serviceCtx.networkName }
          : nestedNetworkName
            ? { NetworkMode: nestedNetworkName }
            : {}),
        ...(extraHosts ? { ExtraHosts: extraHosts } : {}),
      },
      Tty: true,
    });
    t0 = bt("container-create", t0);

    await workspacePrepPromise;
    t0 = Date.now();
    await container.start();
    bt("container-start", t0);

    // 7. Stream logs ───────────────────────────────────────────────────────────
    const rawStream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    })) as NodeJS.ReadableStream;

    let tailDone = false;
    let stdinListening = false;
    const timelinePath = path.join(logDir, "timeline.json");
    const pausedSignalPath = path.join(dirs.signalsDir, "paused");
    const signalsRunDir = path.dirname(dirs.signalsDir);

    const timelineState: TimelineSyncState = {
      lastSeenAttempt: 0,
      isPaused: false,
      pausedAtMs: null,
      pausedStepName: null,
      isBooting: true,
      lastFailedStep: null,
    };

    // Listen for Enter key to trigger retry when paused
    const setupStdinRetry = () => {
      if (stdinListening || !process.stdin.isTTY) {
        return;
      }
      stdinListening = true;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (key: Buffer) => {
        if (key[0] === 3) {
          process.stdin.setRawMode(false);
          process.exit(130);
        }
        if (key[0] === 13 && timelineState.isPaused) {
          syncWorkspaceForRetry(signalsRunDir);
          fs.writeFileSync(path.join(dirs.signalsDir, "retry"), "");
        }
      });
    };
    const cleanupStdin = () => {
      if (stdinListening && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeAllListeners("data");
        stdinListening = false;
      }
    };

    const timelineCtx: TimelineSyncContext = {
      pauseOnFailure,
      pausedSignalPath,
      signalsDir: dirs.signalsDir,
      timelinePath,
      bootStart,
      containerName,
      store,
      onNewPause: setupStdinRetry,
    };

    const pollPromise = (async () => {
      while (!tailDone) {
        syncTimelineToStore(timelineState, timelineCtx);
        await new Promise((r) => setTimeout(r, 100));
      }
      // Final update
      syncTimelineToStore(timelineState, timelineCtx);
    })();

    // Start waiting for container exit in parallel with log streaming.
    const containerWaitPromise = container.wait();

    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: rawStream, crlfDelay: Infinity });

      rl.on("line", (line) => {
        debugStream.write(line + "\n");
      });

      rl.on("close", () => {
        resolve();
      });

      containerWaitPromise
        .then(() => {
          (rawStream as any).destroy?.();
        })
        .catch(() => {});
    });

    tailDone = true;
    cleanupStdin();
    await pollPromise;

    // 8. Wait for completion
    const containerExitCode = await waitForContainerExit(
      container,
      containerWaitPromise,
      CONTAINER_EXIT_TIMEOUT_MS,
    );

    const jobSucceeded = isJobSuccessful({
      lastFailedStep: timelineState.lastFailedStep,
      containerExitCode,
      isBooting: timelineState.isBooting,
    });

    // Update store with final exit code on failure
    if (!jobSucceeded) {
      store?.updateJob(containerName, {
        failedExitCode: containerExitCode !== 0 ? containerExitCode : undefined,
      });
    }

    await new Promise<void>((resolve) => debugStream.end(resolve));

    // Read step outputs captured by the DTU server via the runner's outputs API
    let stepOutputs: Record<string, string> = {};
    if (jobSucceeded) {
      const outputsFile = path.join(logDir, "outputs.json");
      try {
        if (fs.existsSync(outputsFile)) {
          stepOutputs = JSON.parse(fs.readFileSync(outputsFile, "utf-8"));
        }
      } catch {
        /* best-effort */
      }
    }

    if (jobSucceeded && dirs.detectedPM && dirs.dependencyCacheDir) {
      const published = await publishDependencyCache({
        cacheDir: dirs.dependencyCacheDir,
        sourceNodeModules: path.join(dirs.workspaceDir, "node_modules"),
        identity: {
          packageManager: dirs.detectedPM,
          lockfileHash: dirs.lockfileHash,
        },
      });
      if (published.published) {
        debugRunner(
          `Published ${published.mode} dependency cache${published.strategy ? ` via ${published.strategy}` : ""} in ${published.durationMs}ms`,
        );
      }
    }

    if (jobSucceeded && fs.existsSync(dirs.containerWorkDir)) {
      try {
        fs.rmSync(dirs.containerWorkDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup — ENOTEMPTY can occur when container
        // processes haven't fully released file handles yet.
      }
    }

    return buildJobResult({
      containerName,
      job,
      startTime,
      jobSucceeded,
      lastFailedStep: timelineState.lastFailedStep,
      containerExitCode,
      timelinePath,
      logDir,
      debugLogPath,
      stepOutputs,
      resolvedRunnerImage,
      toolCacheDir: dirs.toolCacheDir,
    });
  } finally {
    // Cleanup: always runs even when errors occur mid-run.
    try {
      await container?.remove({ force: true });
    } catch {
      /* already removed */
    }
    if (serviceCtx) {
      await cleanupServiceContainers(getDocker(), serviceCtx, (line) => debugRunner(line));
    }
    // Clean up temp dirs asynchronously to avoid blocking the event loop
    // (which would freeze spinner rendering for all other runners).
    const rmOpts = { recursive: true, force: true } as const;
    await Promise.all([
      fsp.rm(dirs.shimsDir, rmOpts).catch(() => {}),
      !pauseOnFailure ? fsp.rm(dirs.signalsDir, rmOpts).catch(() => {}) : undefined,
      fsp.rm(dirs.diagDir, rmOpts).catch(() => {}),
      fsp.rm(hostRunnerDir, rmOpts).catch(() => {}),
    ]);
    await ephemeralDtu?.close().catch(() => {});
    process.removeListener("SIGINT", signalCleanup);
    process.removeListener("SIGTERM", signalCleanup);
    process.removeListener("SIGHUP", signalCleanup);
  }
}
