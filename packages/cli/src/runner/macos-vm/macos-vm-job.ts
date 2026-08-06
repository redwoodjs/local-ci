import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { startEphemeralDtu } from "dtu-github-actions/ephemeral";

import type { Job } from "../../types.ts";
import { getWorkingDirectory } from "../../output/working-directory.ts";
import { createLogContext } from "../../output/logger.ts";
import { debugRunner, debugBoot } from "../../output/debug.ts";
import { type JobResult } from "../../output/reporter.ts";
import { buildJobResult, isJobSuccessful } from "../result-builder.ts";
import { writeJobMetadata } from "../metadata.ts";
import { appendOutputCaptureStep } from "../step-wrapper.ts";
import { writeRunnerCredentials } from "../runner-credentials.ts";
import { classifyRunsOn } from "../runs-on-compat.ts";
import { parseJobRunsOn } from "../../workflow/workflow-parser.ts";

import { checkMacosVmHost } from "./host-capability.ts";
import { createSemaphore } from "./semaphore.ts";
import {
  listImages,
  pullImage,
  clone,
  runBackground,
  waitForIp,
  waitForSsh,
  applyDnsOverride,
  sshExecScript,
  rsyncTo,
  stop as vmStop,
  destroy as vmDestroy,
  type SshCreds,
} from "./tart.ts";
import { ensureMacosRunnerBinary } from "./runner-binary.ts";
import { resolveMacosVmImage } from "./image-mapping.ts";

// ─── Tunables (env-overridable) ───────────────────────────────────────────────

// Apple's Virtualization.framework tops out at 2 concurrent VMs per host, and
// pushing that limit has a real memory cost. Default low; raise via env when
// running on a dedicated CI mac.
const MACOS_VM_CONCURRENCY = parseInt(process.env.LOCAL_CI_MACOS_VM_CONCURRENCY || "2", 10);
const semaphore = createSemaphore(
  Number.isFinite(MACOS_VM_CONCURRENCY) && MACOS_VM_CONCURRENCY >= 1 ? MACOS_VM_CONCURRENCY : 2,
);

// cirruslabs images default to admin/admin with passwordless sudo. If a user
// ever builds a custom tart image with different creds they can override here.
const SSH_CREDS: SshCreds = {
  user: process.env.LOCAL_CI_MACOS_VM_USER || "admin",
  password: process.env.LOCAL_CI_MACOS_VM_PASSWORD || "admin",
};

// The VM reaches the host at the tart bridge gateway. This is the default for
// tart's softnet-less NAT; override if the user has a custom network setup.
const VM_HOST_IP = process.env.LOCAL_CI_MACOS_VM_HOST_IP || "192.168.64.1";

// Remote filesystem layout inside the VM. The actions-runner creates `_work/`
// as a sibling of `run.sh`, so the runner's workspace lives under VM_RUNNER_DIR.
const VM_RUNNER_DIR = "/Users/admin/local-ci-runner";
const VM_RUNNER_WORK_DIR = `${VM_RUNNER_DIR}/_work`;

// ─── Entrypoint ───────────────────────────────────────────────────────────────

export async function executeMacosVmJob(job: Job): Promise<JobResult> {
  const host = checkMacosVmHost();
  if (!host.supported) {
    throw new Error(
      `macOS VM runner unavailable: ${host.reason}${host.hint ? `\n  ${host.hint}` : ""}`,
    );
  }

  const release = await semaphore.acquire();
  const startTime = Date.now();

  const { name, logDir, debugLogPath } = createLogContext("local-ci-macos", job.runnerName);
  job.runnerName = name;
  writeJobMetadata({ logDir, containerName: name, job });
  const debugStream = fs.createWriteStream(debugLogPath);
  const debug = (line: string) => {
    debugRunner(line);
    debugStream.write(line + "\n");
  };

  const bootStart = Date.now();
  const bt = (label: string, since: number) => {
    debugBoot(`${name} ${label}: ${Date.now() - since}ms`);
    return Date.now();
  };

  // ── Resolve image up front so we can fail fast on unknown labels ──────────
  const labels = job.workflowPath ? parseJobRunsOn(job.workflowPath, job.taskId ?? "") : [];
  const kind = classifyRunsOn(labels);
  if (kind !== "macos") {
    throw new Error(
      `executeMacosVmJob called for a ${kind} job (labels: ${JSON.stringify(labels)}). ` +
        "This is a routing bug — only macOS jobs should reach this path.",
    );
  }
  const { image, exact } = resolveMacosVmImage(labels);
  if (!exact) {
    process.stderr.write(
      `\nwarning: could not map runs-on ${JSON.stringify(labels)} to a known macOS image.\n` +
        `         Falling back to ${image}. Override with LOCAL_CI_MACOS_VM_IMAGE if needed.\n\n`,
    );
  }

  // ── Start the ephemeral DTU (binds 0.0.0.0 so the VM can reach it) ────────
  let t0 = Date.now();
  const dtuCacheDir = path.resolve(getWorkingDirectory(), "cache", "dtu");
  const dtu = await startEphemeralDtu(dtuCacheDir, { allowedLogRoot: path.dirname(logDir) });
  const dtuHostUrl = dtu.url; // for our own fetch() calls on the host
  const dtuVmUrl = `http://${VM_HOST_IP}:${dtu.port}`; // what the VM runner connects to
  const dtuControlHeaders = {
    "Content-Type": "application/json",
    ...dtu.controlHeaders,
  };
  t0 = bt("dtu-start", t0);

  let vmName: string | null = null;
  let vmProc: ChildProcess | null = null;
  const tmpRunnerCredsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "local-ci-macos-creds-"));

  const signalCleanup = () => {
    if (vmName) {
      // Fire and forget — process may be exiting. `tart stop` both signals the
      // tart run child and tears down the VM.
      vmStop(vmName).catch(() => {});
      vmDestroy(vmName).catch(() => {});
    }
  };
  process.on("SIGINT", signalCleanup);
  process.on("SIGTERM", signalCleanup);
  process.on("SIGHUP", signalCleanup);

  try {
    // ── Seed the job to the DTU ─────────────────────────────────────────────
    await fetch(`${dtuHostUrl}/_dtu/start-runner`, {
      method: "POST",
      headers: dtuControlHeaders,
      body: JSON.stringify({
        runnerName: name,
        logDir,
        timelineDir: logDir,
        // We don't currently bind-mount package manager caches into the VM, so
        // let cache saves/restores run normally rather than short-circuiting.
        virtualCachePatterns: [],
      }),
    }).catch(() => {
      /* non-fatal */
    });

    const [githubOwner, githubRepoName] = (job.githubRepo || "").split("/");
    const overriddenRepository = job.githubRepo
      ? {
          full_name: job.githubRepo,
          name: githubRepoName,
          owner: { login: githubOwner },
          default_branch: job.repository?.default_branch || "main",
        }
      : job.repository;
    const seededSteps = appendOutputCaptureStep(job.steps ?? []);

    const seedResponse = await fetch(`${dtuHostUrl}/_dtu/seed`, {
      method: "POST",
      headers: dtuControlHeaders,
      body: JSON.stringify({
        id: job.githubJobId || "1",
        name: "job",
        status: "queued",
        ...job,
        steps: seededSteps,
        repository: overriddenRepository,
        // Tell the DTU to emit the macOS-flavored variables, workspace path,
        // and runner tool cache directory. See generators.ts. runnerWorkDir
        // must match where the actions-runner actually creates `_work/` —
        // that's a sibling of run.sh, not a host-configurable path.
        runnerOs: "macOS",
        runnerArch: "ARM64",
        runnerWorkDir: VM_RUNNER_WORK_DIR,
      }),
    });
    if (!seedResponse.ok) {
      throw new Error(`Failed to seed DTU: ${seedResponse.status} ${seedResponse.statusText}`);
    }
    t0 = bt("dtu-seed", t0);

    // ── Ensure the macOS actions-runner binary is cached ────────────────────
    const runnerCacheRoot = path.resolve(getWorkingDirectory(), "cache", "macos-runner");
    const cachedRunner = await ensureMacosRunnerBinary(runnerCacheRoot);
    debug(`Using macOS runner v${cachedRunner.version} from ${cachedRunner.dir}`);
    t0 = bt("runner-binary-ready", t0);

    // ── Pull base image if missing, then clone a per-job VM ─────────────────
    const images = await listImages();
    if (!images.includes(image)) {
      debug(`Pulling tart image ${image} (first run may take ~30m at 60GB)...`);
      await pullImage(image);
      t0 = bt("tart-pull", t0);
    }

    vmName = `local-ci-macos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await clone(image, vmName);
    t0 = bt("tart-clone", t0);

    vmProc = runBackground(vmName);
    vmProc.stderr?.on("data", (chunk) => debug(`[tart run] ${chunk.toString().trimEnd()}`));

    const ip = await waitForIp(vmName);
    t0 = bt("tart-ip", t0);
    debug(`VM ${vmName} IP: ${ip}`);

    await waitForSsh(ip, SSH_CREDS);
    t0 = bt("ssh-ready", t0);

    await applyDnsOverride(ip, SSH_CREDS).catch((err) => {
      // Non-fatal — on networks where the tart NAT DNS works, dig may already
      // succeed. Log and move on; if DNS really is broken the first network
      // step in the job will surface a clear error.
      debug(`DNS override skipped: ${err.message || err}`);
    });
    t0 = bt("dns-override", t0);

    // ── Provision runner binary + credentials inside the VM ─────────────────
    await sshExecScript(
      ip,
      SSH_CREDS,
      `set -e
mkdir -p ${VM_RUNNER_DIR}
mkdir -p ${VM_RUNNER_WORK_DIR}/${githubRepoName}/${githubRepoName}
mkdir -p ${VM_RUNNER_WORK_DIR}/_temp
mkdir -p /Users/admin/hostedtoolcache`,
    );
    await rsyncTo(ip, SSH_CREDS, cachedRunner.dir, VM_RUNNER_DIR);
    t0 = bt("rsync-runner", t0);

    const repoUrl = `${dtuVmUrl}/${job.githubRepo}`;
    writeRunnerCredentials(tmpRunnerCredsDir, name, repoUrl);
    await rsyncTo(ip, SSH_CREDS, tmpRunnerCredsDir, VM_RUNNER_DIR);
    t0 = bt("rsync-credentials", t0);

    // ── Kick off ./run.sh and stream output to debug log ────────────────────
    const runScript = `set -e
cd ${VM_RUNNER_DIR}
chmod +x run.sh
# --once: exit after the first job finishes (ephemeral runner mode).
exec ./run.sh --once
`;
    debug(`Starting ./run.sh inside VM ${vmName} (${ip})`);
    bt("total-boot", bootStart);

    const runResult = await sshExecScript(ip, SSH_CREDS, runScript, {
      timeoutMs: 3_600_000, // 1h hard cap
      onStdout: (c) => debugStream.write(c),
      onStderr: (c) => debugStream.write(c),
    });

    await new Promise<void>((resolve) => debugStream.end(resolve));

    // ── Assemble the JobResult from timeline + outputs ──────────────────────
    const timelinePath = path.join(logDir, "timeline.json");
    const outputsFile = path.join(logDir, "outputs.json");
    let stepOutputs: Record<string, string> = {};
    if (fs.existsSync(outputsFile)) {
      try {
        stepOutputs = JSON.parse(fs.readFileSync(outputsFile, "utf-8"));
      } catch {
        /* best-effort */
      }
    }

    const lastFailedStep = readLastFailedStep(timelinePath);
    const isBooting = !fs.existsSync(timelinePath);
    const jobSucceeded = isJobSuccessful({
      lastFailedStep,
      containerExitCode: runResult.code,
      isBooting,
    });

    return buildJobResult({
      containerName: name,
      job,
      startTime,
      jobSucceeded,
      lastFailedStep,
      containerExitCode: runResult.code,
      timelinePath,
      logDir,
      debugLogPath,
      stepOutputs,
    });
  } finally {
    process.removeListener("SIGINT", signalCleanup);
    process.removeListener("SIGTERM", signalCleanup);
    process.removeListener("SIGHUP", signalCleanup);

    if (vmName) {
      await vmStop(vmName).catch(() => {});
      await vmDestroy(vmName).catch(() => {});
    }
    if (vmProc && !vmProc.killed) {
      vmProc.kill("SIGTERM");
    }

    await dtu.close().catch(() => {});
    await fsp.rm(tmpRunnerCredsDir, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

// Read the timeline file and return the display name of the most recent failed
// step, or null if none / the file does not exist. Mirrors what the Linux
// path's inline log-watcher computes via `lastFailedStep`.
function readLastFailedStep(timelinePath: string): string | null {
  if (!fs.existsSync(timelinePath)) {
    return null;
  }
  try {
    const records = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as any[];
    const failed = records
      .filter((r) => r.type === "Task" && (r.result || "").toLowerCase() === "failed")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return failed.length > 0 ? failed[failed.length - 1].name : null;
  } catch {
    return null;
  }
}
