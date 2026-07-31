import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type Docker from "dockerode";
import { parse as parseYaml } from "yaml";

import { config, loadMachineSecrets, resolveRepoSlug } from "../config.ts";
import { loadVarFiles } from "../workflow-vars.ts";
import { getNextLogNum } from "../output/logger.ts";
import {
  setWorkingDirectory,
  DEFAULT_WORKING_DIR,
  PROJECT_ROOT,
  getWorkingDirectory,
} from "../output/working-directory.ts";
import { debugCli } from "../output/debug.ts";
import { executeLocalJob, getDocker } from "../runner/local-job.ts";
import { executeMacosVmJob } from "../runner/macos-vm/macos-vm-job.ts";
import { checkMacosVmHost } from "../runner/macos-vm/host-capability.ts";
import {
  discoverRunnerImage,
  ensureRunnerImage,
  UPSTREAM_RUNNER_IMAGE,
} from "../runner/runner-image.ts";
import {
  parseWorkflowSteps,
  parseWorkflowServices,
  parseWorkflowContainer,
  parseJobRunsOnLabels,
  validateSecrets,
  extractSecretRefs,
  validateVars,
  extractVarRefs,
  parseMatrixDef,
  expandMatrixCombinations,
  collapseMatrixToSingle,
  isWorkflowRelevant,
  getChangedFiles,
  parseJobOutputDefs,
  parseJobIf,
  evaluateJobIf,
  parseFailFast,
  parseJobRunsOn,
  expandExpressions,
} from "../workflow/workflow-parser.ts";
import {
  classifyRunsOn,
  isUnsupportedOS,
  formatUnsupportedOSWarning,
  type RunnerOSKind,
} from "../runner/runs-on-compat.ts";
import { resolveJobOutputs } from "../runner/result-builder.ts";
import type { Job } from "../types.ts";
import { createConcurrencyLimiter, getDefaultMaxConcurrentJobs } from "../output/concurrency.ts";
import { computeLockfileHash, detectPackageManager } from "../output/cleanup.ts";
import {
  isDependencyCacheComplete,
  resolveDependencyCacheDir,
} from "../runner/node-modules-cache.ts";
import {
  pruneOrphanedDockerResources,
  killOrphanedContainers,
  pruneStaleWorkspaces,
} from "../docker/shutdown.ts";
import { topoSort } from "../workflow/job-scheduler.ts";
import { expandReusableJobs, type ExpandedJobEntry } from "../workflow/reusable-workflow.ts";
import { prefetchRemoteWorkflows } from "../workflow/remote-workflow-fetch.ts";
import { printSummary, type JobResult } from "../output/reporter.ts";
import { computeDirtySha } from "../runner/dirty-sha.ts";
import { RunStateStore } from "../output/run-state.ts";
import { renderRunState } from "../output/state-renderer.ts";
import { isAgentMode, isJsonMode, setJsonMode, setQuietMode } from "../output/agent-mode.ts";
import { createDiffRenderer } from "../output/diff-renderer.ts";
import { createFailedJobResult, wrapJobError, isJobError } from "../runner/job-result.ts";
import { postCommitStatus } from "../commit-status.ts";
import {
  classifyJobResources,
  collectJobResourceHints,
  getHostResources,
  type ResourceFidelity,
} from "../workflow/resource-classifier.ts";
import { writeRunResult } from "../run-result-writer.ts";
import { pruneLogs } from "../log-prune.ts";
import {
  EVENT_SCHEMA_VERSION,
  formatEvent,
  isDetachedWorker,
  isForceDetachedRequested,
  runDetachedLauncher,
  shouldLaunchDetached,
  type DiagnosticEvent,
  type LogEvent,
} from "../launcher.ts";

type ParsedRunArgs = {
  sha?: string;
  workflow?: string;
  pauseOnFailure: boolean;
  runAll: boolean;
  noMatrix: boolean;
  githubToken?: string;
  commitStatus: boolean;
  maxJobs?: number;
  prewarmThrough?: string;
  cliVars: Record<string, string>;
  varFiles: string[];
};

export type PrewarmThroughSpec = {
  workflowPath: string;
  jobId: string;
  stepId: string;
};

export function parsePrewarmThroughSpec(raw: string): PrewarmThroughSpec {
  const parts = raw.split(":");
  if (parts.length < 3) {
    exitWithError("[Agent CI] Error: --prewarm-through expects <workflow-path>:<job-id>:<step-id>");
  }
  const stepId = parts.pop()!.trim();
  const jobId = parts.pop()!.trim();
  const workflowPath = parts.join(":").trim();
  if (!workflowPath || !jobId || !stepId) {
    exitWithError("[Agent CI] Error: --prewarm-through expects <workflow-path>:<job-id>:<step-id>");
  }
  return { workflowPath, jobId, stepId };
}

export type PrewarmInstallCandidate = {
  workflowPath: string;
  jobId: string;
  stepId?: string;
  command: string;
};

function isLikelyInstallCommand(script: string): boolean {
  return /(^|[\s;&|()])(?:npm\s+(?:ci|install|i)|pnpm\s+(?:install|i)|yarn\s+install|bun\s+install)(?:\s|$)/m.test(
    script,
  );
}

function jobNeedsAreEmpty(needs: unknown): boolean {
  return needs === undefined || (Array.isArray(needs) && needs.length === 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

type InstallRunStep = {
  id?: unknown;
  run: string;
};

function isInstallRunStep(step: unknown): step is InstallRunStep {
  return isRecord(step) && typeof step.run === "string" && isLikelyInstallCommand(step.run);
}

export function findPrewarmInstallCandidates(workflowPath: string): PrewarmInstallCandidate[] {
  let rawYaml: unknown;
  try {
    rawYaml = parseYaml(fs.readFileSync(workflowPath, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(rawYaml) || !isRecord(rawYaml.jobs)) {
    return [];
  }

  const candidates: PrewarmInstallCandidate[] = [];
  for (const [jobId, job] of Object.entries(rawYaml.jobs)) {
    if (!isRecord(job) || !jobNeedsAreEmpty(job.needs)) {
      continue;
    }
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const installStep = steps.find(isInstallRunStep);
    if (!installStep) {
      continue;
    }
    candidates.push({
      workflowPath,
      jobId,
      stepId: typeof installStep.id === "string" ? installStep.id : undefined,
      command:
        installStep.run
          .split("\n")
          .find((line) => line.trim())
          ?.trim() ?? "install",
    });
  }
  return candidates;
}

export function prewarmSelectorForCandidates(candidates: PrewarmInstallCandidate[]): string {
  const example = candidates.find((candidate) => candidate.stepId) ?? candidates[0];
  return example.stepId
    ? `${example.workflowPath}:${example.jobId}:${example.stepId}`
    : `${example.workflowPath}:${example.jobId}:install`;
}

export function formatPrewarmWarning(candidates: PrewarmInstallCandidate[]): string {
  const example = candidates.find((candidate) => candidate.stepId) ?? candidates[0];
  const selector = prewarmSelectorForCandidates(candidates);
  const stepIdHint = example.stepId
    ? ""
    : "\nAdd a stable `id: install` to the install step you want Agent CI to prewarm through.\n";
  return [
    `[Agent CI] Notice: ${candidates.length} parallel jobs will start with a cold dependency cache.`,
    "Each job has private node_modules, but prewarming can avoid duplicate installation work.",
    stepIdHint.trim(),
    "To prewarm dependencies explicitly, run:",
    "",
    `  agent-ci run --all --prewarm-through ${selector}`,
    "",
    "Or persist this in .env.agent-ci:",
    "",
    `  AGENT_CI_PREWARM_THROUGH=${selector}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function prewarmDiagnosticEvent(candidates: PrewarmInstallCandidate[]): DiagnosticEvent {
  return {
    event: "diagnostic",
    ts: new Date().toISOString(),
    level: "warning",
    message: formatPrewarmWarning(candidates),
    code: "prewarm_recommended",
    details: {
      selector: prewarmSelectorForCandidates(candidates),
      candidateCount: candidates.length,
      candidates: candidates.map((candidate) => ({
        workflowPath: candidate.workflowPath,
        jobId: candidate.jobId,
        stepId: candidate.stepId,
        command: candidate.command,
      })),
    },
  };
}

function emitJsonDiagnostic(event: DiagnosticEvent): void {
  if (!isJsonMode()) {
    return;
  }
  process.stdout.write(formatEvent(event) + "\n");
}

export function truncateStepsThroughId<T extends { ContextName?: string } | null | undefined>(
  steps: T[],
  stepId: string,
): NonNullable<T>[] {
  const idx = steps.findIndex((step) => step?.ContextName === stepId);
  if (idx === -1) {
    throw new Error(
      `[Agent CI] Prewarm step '${stepId}' not found. Add a stable 'id: ${stepId}' to the target step.`,
    );
  }
  return steps.slice(0, idx + 1).filter((step): step is NonNullable<T> => step != null);
}

function exitWithError(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseJobsFlag(raw: string): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    exitWithError("[Agent CI] Error: --jobs must be a positive integer");
  }
  return n;
}

function parseVarFlag(raw: string): [string, string] {
  const eqIdx = raw.indexOf("=");
  if (eqIdx < 1) {
    exitWithError(`[Agent CI] Error: --var expects KEY=VALUE, got: ${raw}`);
  }
  const key = raw.slice(0, eqIdx).trim();
  if (!key) {
    exitWithError(`[Agent CI] Error: --var expects KEY=VALUE, got: ${raw}`);
  }
  return [key, raw.slice(eqIdx + 1)];
}

function resolveGithubTokenFlag(
  args: string[],
  i: number,
): { token: string; consumedNext: boolean } {
  // If the next arg looks like a token value (not another flag), use it.
  // Otherwise, auto-resolve via `gh auth token`.
  const next = args[i + 1];
  if (next && !next.startsWith("-")) {
    return { token: next, consumedNext: true };
  }
  try {
    const token = execSync("gh auth token", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { token, consumedNext: false };
  } catch {
    exitWithError(
      "[Agent CI] Error: --github-token requires `gh` CLI to be installed and authenticated, or pass a token value: --github-token <value>",
    );
  }
}

function parseRunArgs(args: string[]): ParsedRunArgs {
  const parsed: ParsedRunArgs = {
    pauseOnFailure: false,
    runAll: false,
    noMatrix: false,
    commitStatus: false,
    cliVars: {},
    varFiles: [],
  };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--workflow" || arg === "-w") && args[i + 1]) {
      parsed.workflow = args[++i];
    } else if (arg === "--pause-on-failure" || arg === "-p") {
      parsed.pauseOnFailure = true;
    } else if (arg === "--all" || arg === "-a") {
      parsed.runAll = true;
    } else if (arg === "--quiet" || arg === "-q") {
      setQuietMode(true);
    } else if (arg === "--json") {
      setJsonMode(true);
    } else if (arg === "--no-matrix") {
      parsed.noMatrix = true;
    } else if ((arg === "--jobs" || arg === "-j") && args[i + 1]) {
      parsed.maxJobs = parseJobsFlag(args[++i]);
    } else if (arg.startsWith("--jobs=")) {
      parsed.maxJobs = parseJobsFlag(arg.slice("--jobs=".length));
    } else if (arg === "--prewarm-through" && args[i + 1]) {
      parsed.prewarmThrough = args[++i];
    } else if (arg.startsWith("--prewarm-through=")) {
      parsed.prewarmThrough = arg.slice("--prewarm-through=".length);
    } else if (arg === "--commit-status") {
      parsed.commitStatus = true;
    } else if (arg === "--var" && args[i + 1]) {
      const [key, value] = parseVarFlag(args[++i]);
      parsed.cliVars[key] = value;
    } else if (arg === "--var-file") {
      const file = args[++i];
      if (!file) {
        exitWithError("[Agent CI] Error: --var-file expects a path or - for stdin");
      }
      parsed.varFiles.push(file);
    } else if (arg.startsWith("--var-file=")) {
      const file = arg.slice("--var-file=".length);
      if (!file) {
        exitWithError("[Agent CI] Error: --var-file expects a path or - for stdin");
      }
      parsed.varFiles.push(file);
    } else if (arg === "--github-token") {
      const { token, consumedNext } = resolveGithubTokenFlag(args, i);
      parsed.githubToken = token;
      if (consumedNext) {
        i++;
      }
    } else if (!arg.startsWith("-")) {
      parsed.sha = arg;
    }
  }

  // Also accept AGENT_CI_GITHUB_TOKEN env var (CLI flag takes precedence)
  if (!parsed.githubToken && process.env.AGENT_CI_GITHUB_TOKEN) {
    parsed.githubToken = process.env.AGENT_CI_GITHUB_TOKEN;
  }

  if (!parsed.prewarmThrough && process.env.AGENT_CI_PREWARM_THROUGH) {
    parsed.prewarmThrough = process.env.AGENT_CI_PREWARM_THROUGH;
  }

  return parsed;
}

function materializeStdinVarFileArgs(args: string[], varFiles: string[]): string[] {
  const stdinCount = varFiles.filter((file) => file === "-").length;
  if (stdinCount === 0) {
    return args;
  }
  if (stdinCount > 1) {
    exitWithError("[Agent CI] Error: --var-file - can only be used once");
  }

  let content: string;
  try {
    content = fs.readFileSync(0, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    exitWithError(`[Agent CI] Error: Failed to read --var-file stdin: ${msg}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-vars-"));
  const tmpPath = path.join(tmpDir, "stdin-vars.json");
  fs.writeFileSync(tmpPath, content, "utf-8");

  const materialized = [...args];
  for (let i = 1; i < materialized.length; i++) {
    const arg = materialized[i];
    if (arg === "--var-file" && materialized[i + 1] === "-") {
      materialized[i + 1] = tmpPath;
      i++;
    } else if (arg === "--var-file=-") {
      materialized[i] = `--var-file=${tmpPath}`;
    }
  }
  return materialized;
}

function resolveWorkflowVars(parsed: ParsedRunArgs): Record<string, string> {
  try {
    return { ...loadVarFiles(parsed.varFiles), ...parsed.cliVars };
  } catch (err) {
    exitWithError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Discover every workflow under `<repoRoot>/.github/workflows` whose
 * trigger filters would fire for the current branch and changed-file set.
 */
async function discoverRelevantWorkflows(
  repoRoot: string,
  branch: string,
  changedFiles: string[],
): Promise<string[]> {
  const workflowsDir = path.resolve(repoRoot, ".github", "workflows");
  if (!fs.existsSync(workflowsDir)) {
    exitWithError(`[Agent CI] No .github/workflows directory found in ${repoRoot}`);
  }
  const files = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => path.join(workflowsDir, f));
  const { parse: parseYaml } = await import("yaml");

  const relevant: string[] = [];
  for (const file of files) {
    try {
      const raw = parseYaml(fs.readFileSync(file, "utf8"));
      const onDef = raw?.on || raw?.true;
      if (!onDef) {
        continue;
      }
      const events: Record<string, any> = {};
      if (Array.isArray(onDef)) {
        for (const e of onDef) {
          events[e] = {};
        }
      } else if (typeof onDef === "string") {
        events[onDef] = {};
      } else {
        Object.assign(events, onDef);
      }
      if (isWorkflowRelevant({ events }, branch, changedFiles)) {
        relevant.push(file);
      }
    } catch {
      // Skip unparsable workflows
    }
  }
  return relevant;
}

/** Resolve a possibly relative workflow path against cwd, repo root, and the workflows dir. */
function resolveWorkflowArgPath(workflow: string, repoRoot: string): string {
  if (path.isAbsolute(workflow)) {
    return workflow;
  }
  const cwd = process.cwd();
  const workflowsDir = path.resolve(repoRoot, ".github", "workflows");
  const pathsToTry = [
    path.resolve(cwd, workflow),
    path.resolve(repoRoot, workflow),
    path.resolve(workflowsDir, workflow),
  ];
  return pathsToTry.find((p) => fs.existsSync(p)) || pathsToTry[1];
}

/**
 * Print the summary, post a commit status, persist the run, emit the
 * finish sentinel, and exit. Used by both the --all and single-workflow
 * code paths so they share the same shutdown sequence.
 */
async function finalizeRun(opts: {
  results: JobResult[];
  parsed: ParsedRunArgs;
  repoRoot: string;
  startedAt: Date;
  branch?: string;
}): Promise<never> {
  const { results, parsed, repoRoot, startedAt, branch } = opts;
  if (results.length > 0) {
    printSummary(results);
  }
  if (parsed.commitStatus) {
    postCommitStatus(results, parsed.sha, parsed.githubToken);
  }
  await persistRunResult({ results, repoRoot, startedAt, sha: parsed.sha, branch });
  const anyFailed = results.length === 0 || results.some((r) => !r.succeeded);
  emitRunFinishSentinel(anyFailed ? "failed" : "passed");
  process.exit(anyFailed ? 1 : 0);
}

export default async function runCmd(args: string[]): Promise<void> {
  const parsed = parseRunArgs(args);

  // ── Detached-worker dispatch (issue #315) ────────────────────────────────
  // When --pause-on-failure is set and stdout is a pipe/redirect (and we're
  // not already inside an agent harness that monitors live output), the CLI
  // would otherwise hang forever on pause — output buffered until EOF, which
  // never comes until retry, which the caller can't discover. Hand off to a
  // launcher that spawns the real run as a detached worker and exits 77 the
  // moment the worker emits the pause sentinel.
  if (
    shouldLaunchDetached({
      pauseOnFailure: parsed.pauseOnFailure,
      stdoutIsTTY: Boolean(process.stdout.isTTY),
      agentMode: isAgentMode(),
      alreadyWorker: isDetachedWorker(),
      forceDetached: isForceDetachedRequested(),
    })
  ) {
    const launcherArgs = materializeStdinVarFileArgs(args, parsed.varFiles);
    const { exitCode } = await runDetachedLauncher(launcherArgs);
    process.exit(exitCode);
  }

  let workingDir = process.env.AGENT_CI_WORKING_DIR;
  if (workingDir) {
    if (!path.isAbsolute(workingDir)) {
      workingDir = path.resolve(PROJECT_ROOT, workingDir);
    }
    setWorkingDirectory(workingDir);
  }

  // Opportunistic, throttled cleanup of old per-run log dirs. Never fails the run.
  try {
    pruneLogs();
  } catch {
    /* noop */
  }

  const startedAt = new Date();
  const workflowVars = resolveWorkflowVars(parsed);
  const runWorkflowsOpts = {
    sha: parsed.sha,
    pauseOnFailure: parsed.pauseOnFailure,
    noMatrix: parsed.noMatrix,
    githubToken: parsed.githubToken,
    maxJobs: parsed.maxJobs,
    prewarmThrough: parsed.prewarmThrough,
    vars: workflowVars,
  };

  if (parsed.runAll) {
    const repoRoot = resolveRepoRoot();
    // Branch and changed-files are independent — kick both off together.
    const [{ stdout: branchOut }, changedFiles] = await Promise.all([
      execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot }),
      getChangedFiles(repoRoot),
    ]);
    const branch = branchOut.trim();
    const relevant = await discoverRelevantWorkflows(repoRoot, branch, changedFiles);
    if (relevant.length === 0) {
      console.log(`[Agent CI] No relevant workflows found for branch '${branch}'.`);
      process.exit(0);
    }
    const results = await runWorkflows({ workflowPaths: relevant, ...runWorkflowsOpts });
    await finalizeRun({ results, parsed, repoRoot, startedAt, branch });
  }

  if (!parsed.workflow) {
    console.error("[Agent CI] Error: You must specify --workflow <path> or --all");
    console.log("");
    printUsageMinimal();
    process.exit(1);
  }

  const repoRoot = resolveRepoRoot();
  const workflowPath = resolveWorkflowArgPath(parsed.workflow, repoRoot);
  const results = await runWorkflows({ workflowPaths: [workflowPath], ...runWorkflowsOpts });
  await finalizeRun({ results, parsed, repoRoot, startedAt });
}

// ─── runPrewarmThrough ──────────────────────────────────────────────────────
// Optional dependency-cache primer. Runs one disposable copy of a real workflow job
// from the beginning through a user-selected step id, so setup actions and the
// install command are exactly the repo's own workflow steps.
async function isDependencyCacheReadyForWorkflow(workflowPath: string): Promise<boolean> {
  const repoRoot = resolveRepoRootFromWorkflow(workflowPath);
  const packageManager = detectPackageManager(repoRoot);
  if (!packageManager) {
    return false;
  }
  config.GITHUB_REPO ??= await resolveRepoSlug(repoRoot);
  const repoSlug = config.GITHUB_REPO.replace("/", "-");
  let lockfileHash = "no-lockfile";
  try {
    lockfileHash = computeLockfileHash(repoRoot);
  } catch {}
  return isDependencyCacheComplete(
    resolveDependencyCacheDir(getWorkingDirectory(), repoSlug, {
      packageManager,
      lockfileHash,
    }),
  );
}

async function warnIfPrewarmLikelyNeeded(workflowPaths: string[]): Promise<void> {
  if (workflowPaths.length === 0 || (await isDependencyCacheReadyForWorkflow(workflowPaths[0]))) {
    return;
  }
  const candidates = workflowPaths.flatMap(findPrewarmInstallCandidates);
  if (candidates.length < 2) {
    return;
  }
  const diagnostic = prewarmDiagnosticEvent(candidates);
  process.stderr.write(`${diagnostic.message}\n`);
  emitJsonDiagnostic(diagnostic);
}

async function runPrewarmThrough(options: {
  spec: PrewarmThroughSpec;
  sha?: string;
  pauseOnFailure: boolean;
  store: RunStateStore;
  githubToken?: string;
  vars?: Record<string, string>;
  workflowPaths: string[];
}): Promise<void> {
  const repoRootForArg = resolveRepoRoot();
  const workflowPath = resolveWorkflowArgPath(options.spec.workflowPath, repoRootForArg);
  if (!options.workflowPaths.includes(workflowPath)) {
    options.store.addWorkflow(workflowPath);
  }
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`[Agent CI] Prewarm workflow not found: ${workflowPath}`);
  }

  const repoRoot = resolveRepoRootFromWorkflow(workflowPath);
  config.GITHUB_REPO ??= await resolveRepoSlug(repoRoot);
  if (await isDependencyCacheReadyForWorkflow(workflowPath)) {
    debugCli("[Agent CI] Prewarm skipped — dependency cache is already complete.");
    return;
  }

  const kind = classifyRunsOn(parseJobRunsOn(workflowPath, options.spec.jobId));
  if (isUnsupportedOS(kind)) {
    throw new Error(
      `[Agent CI] Prewarm job '${options.spec.jobId}' targets unsupported runs-on kind '${kind}'.`,
    );
  }

  const [explicitHead, dirtySha, headSlug] = await Promise.all([
    options.sha ? resolveHeadSha(repoRoot, options.sha) : Promise.resolve(undefined),
    options.sha ? Promise.resolve(undefined) : computeDirtySha(repoRoot),
    resolveHeadSha(repoRoot, "HEAD"),
  ]);
  const { headSha, shaRef } = explicitHead ?? { headSha: undefined, shaRef: undefined };
  const realHeadSha = headSha ?? dirtySha ?? headSlug.headSha;
  const baseSha = await resolveBaseSha(repoRoot, realHeadSha);
  const [owner, name] = config.GITHUB_REPO.split("/");
  const workflowExpressionContext = {
    repoPath: repoRoot,
    vars: options.vars,
    githubContext: {
      repository: config.GITHUB_REPO,
      repository_owner: owner,
      actor: owner,
      sha: realHeadSha,
    },
  };

  const requiredRefs = extractSecretRefs(workflowPath, options.spec.jobId);
  const secrets = loadMachineSecrets(repoRoot, requiredRefs);
  if (options.githubToken && !secrets["GITHUB_TOKEN"]) {
    secrets["GITHUB_TOKEN"] = options.githubToken;
  }
  validateSecrets(workflowPath, options.spec.jobId, secrets, path.join(repoRoot, ".env.agent-ci"));
  validateVars(workflowPath, options.spec.jobId, options.vars ?? {});

  const steps = truncateStepsThroughId(
    await parseWorkflowSteps(
      workflowPath,
      options.spec.jobId,
      secrets,
      undefined,
      undefined,
      undefined,
      options.vars,
    ),
    options.spec.stepId,
  );

  debugCli(
    `[Agent CI] Prewarming node_modules through ${path.basename(workflowPath)}:${options.spec.jobId}:${options.spec.stepId}...`,
  );
  const result = await executeLocalJob(
    {
      deliveryId: `prewarm-${Date.now()}`,
      eventType: "workflow_job",
      githubJobId: Math.floor(Math.random() * 1000000).toString(),
      githubRepo: config.GITHUB_REPO,
      githubToken: "mock_token",
      headSha,
      baseSha,
      realHeadSha,
      repoRoot,
      shaRef,
      env: { AGENT_CI_LOCAL: "true" },
      repository: {
        name,
        full_name: config.GITHUB_REPO,
        owner: { login: owner },
        default_branch: "main",
      },
      runnerName: `agent-ci-prewarm-${getNextLogNum("agent-ci")}-j1`,
      steps,
      services: await parseWorkflowServices(workflowPath, options.spec.jobId, {
        ...workflowExpressionContext,
        secrets,
      }),
      container:
        (await parseWorkflowContainer(workflowPath, options.spec.jobId, {
          ...workflowExpressionContext,
          secrets,
        })) ?? undefined,
      workflowPath,
      taskId: `prewarm:${options.spec.jobId}:${options.spec.stepId}`,
    },
    { pauseOnFailure: options.pauseOnFailure, store: options.store },
  );

  if (!result.succeeded) {
    throw new Error(
      `[Agent CI] Prewarm failed for ${path.basename(workflowPath)}:${options.spec.jobId}:${options.spec.stepId}`,
    );
  }
}

// ─── prefetchRunnerImages ──────────────────────────────────────────────────
// Pull (and, if necessary, build) every runner image that the upcoming
// workflows will need — once, before any job starts. Without this, each
// parallel workflow independently races to pull/build the same image, which
// with `--all` means dozens of concurrent `docker pull` calls on a cold
// cache. The per-job calls in local-job.ts remain as a safety net and take
// the inspect() fast path since images are already warm.
async function prefetchRunnerImages(workflowPaths: string[]): Promise<void> {
  const docker = getDocker();

  // The upstream runner image is always needed: default mode uses it
  // directly, direct-container mode uses it to seed the runner binary.
  // Check whether it's already cached — if not, pull with visible progress
  // so first-time users understand what's happening instead of seeing a
  // frozen spinner. See https://github.com/redwoodjs/agent-ci/issues/242
  const pulls: Promise<unknown>[] = [pullUpstreamRunnerImage(docker)];

  // Additionally, each unique repo root may resolve to a custom runner
  // image (env override or Dockerfile). Build/pull each unique one.
  const seenRepos = new Set<string>();
  const seenImages = new Set<string>([UPSTREAM_RUNNER_IMAGE]);
  for (const wf of workflowPaths) {
    const repoRoot = resolveRepoRootFromWorkflow(wf);
    if (seenRepos.has(repoRoot)) {
      continue;
    }
    seenRepos.add(repoRoot);
    const resolved = discoverRunnerImage(repoRoot);
    if (seenImages.has(resolved.image)) {
      continue;
    }
    seenImages.add(resolved.image);
    pulls.push(ensureRunnerImage(docker, resolved));
  }

  try {
    await Promise.all(pulls);
  } catch (err) {
    // Surface the error so users know what went wrong. Per-job calls in
    // local-job.ts will retry, so this doesn't block startup.
    console.error(`[Agent CI] Image prefetch failed: ${(err as Error).message}`);
  }
}

/**
 * Pull the upstream runner image with user-visible progress output.
 * On a cold cache (first run), pulling ~300 MB can take 30-60s — without
 * feedback the CLI appears stuck. This mirrors the progress tracking that
 * direct-container mode already does in local-job.ts.
 */
async function pullUpstreamRunnerImage(docker: Docker): Promise<void> {
  try {
    await docker.getImage(UPSTREAM_RUNNER_IMAGE).inspect();
    return; // already cached
  } catch {
    // not present — fall through to pull
  }

  process.stderr.write(
    `\nPulling runner image ${UPSTREAM_RUNNER_IMAGE}...\n` +
      `  First run downloads the image (~300 MB); subsequent runs use the cache.\n\n`,
  );

  await new Promise<void>((resolve, reject) => {
    docker.pull(UPSTREAM_RUNNER_IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        return reject(
          new Error(`Failed to pull runner image '${UPSTREAM_RUNNER_IMAGE}': ${err.message}`),
        );
      }

      const layerProgress = new Map<string, { current: number; total: number }>();
      let currentPhase: "downloading" | "extracting" = "downloading";
      let lastUpdate = 0;

      const flushProgress = (force = false) => {
        const now = Date.now();
        if (!force && now - lastUpdate < 500) {
          return;
        }
        lastUpdate = now;
        let totalBytes = 0;
        let currentBytes = 0;
        for (const l of layerProgress.values()) {
          totalBytes += l.total;
          currentBytes += l.current;
        }
        if (totalBytes > 0) {
          const pct = Math.round((currentBytes / totalBytes) * 100);
          const currentMB = (currentBytes / 1_048_576).toFixed(0);
          const totalMB = (totalBytes / 1_048_576).toFixed(0);
          const label = currentPhase === "downloading" ? "Downloading" : "Extracting";
          process.stderr.write(`\r  ${label}: ${pct}% (${currentMB} MB / ${totalMB} MB)  `);
        }
      };

      docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          process.stderr.write("\r" + " ".repeat(60) + "\r");
          if (err) {
            reject(
              new Error(`Failed to pull runner image '${UPSTREAM_RUNNER_IMAGE}': ${err.message}`),
            );
          } else {
            process.stderr.write(`  Done.\n\n`);
            resolve();
          }
        },
        (event: {
          status?: string;
          id?: string;
          progressDetail?: { current?: number; total?: number };
        }) => {
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
            layerProgress.set(event.id, { current: detail.current!, total: detail.total! });
          } else if (event.status === "Download complete") {
            const existing = layerProgress.get(event.id);
            if (existing) {
              existing.current = existing.total;
            }
          } else if (event.status === "Extracting" && hasByteCounts) {
            if (currentPhase !== "extracting") {
              currentPhase = "extracting";
              layerProgress.clear();
              flushProgress(true);
            }
            layerProgress.set(event.id, { current: detail.current!, total: detail.total! });
          } else if (event.status === "Pull complete") {
            const existing = layerProgress.get(event.id);
            if (existing) {
              existing.current = existing.total;
            }
          } else {
            return;
          }
          flushProgress();
        },
      );
    });
  });
}

/**
 * Scan every workflow for `${{ vars.FOO }}` references and exit with a
 * combined error listing the missing vars and the `--var` / `--var-file` inputs needed.
 * Called at the start of a run so users find out before any setup work
 * happens.
 */
function preflightVars(workflowPaths: string[], vars: Record<string, string>): void {
  const perFile: { file: string; missing: string[] }[] = [];
  const allMissing = new Set<string>();
  for (const wf of workflowPaths) {
    let refs: string[];
    try {
      refs = extractVarRefs(wf);
    } catch {
      continue;
    }
    const missing = refs.filter((n) => !vars[n]);
    if (missing.length > 0) {
      perFile.push({ file: wf, missing });
      for (const n of missing) {
        allMissing.add(n);
      }
    }
  }
  if (allMissing.size === 0) {
    return;
  }
  const lines: string[] = [
    `[Agent CI] Missing vars required by workflow(s):`,
    "",
    ...perFile.map((m) => {
      const rel = path.relative(process.cwd(), m.file);
      const display = rel.startsWith("..") ? m.file : rel;
      return `  ${display}: ${m.missing.join(", ")}`;
    }),
    "",
    `Pass them via --var NAME=value (one flag per variable) or --var-file <path>:`,
    "",
    ...Array.from(allMissing)
      .sort()
      .map((n) => `  --var ${n}=<value>`),
    "",
  ];
  console.error(lines.join("\n"));
  process.exit(1);
}

// ─── runWorkflows ──────────────────────────────────────────────────────────────
// Single entry point for both `--workflow` and `--all`.
// One workflow = --all with a single entry.

async function runWorkflows(options: {
  workflowPaths: string[];
  sha?: string;
  pauseOnFailure: boolean;
  noMatrix?: boolean;
  githubToken?: string;
  maxJobs?: number;
  prewarmThrough?: string;
  vars?: Record<string, string>;
}): Promise<JobResult[]> {
  const {
    workflowPaths,
    sha,
    pauseOnFailure,
    noMatrix = false,
    githubToken,
    vars,
    prewarmThrough,
  } = options;

  // Pre-flight: scan all workflows for required vars before doing any setup
  // work. Catches missing vars up front instead of mid-run.
  preflightVars(workflowPaths, vars ?? {});

  // Suppress EventEmitter MaxListenersExceeded warnings when running many
  // parallel jobs (each job adds SIGINT/SIGTERM listeners).
  process.setMaxListeners(0);

  // Create the run state store — single source of truth for all progress
  const runId = `run-${Date.now()}`;
  const storeFilePath = path.join(getWorkingDirectory(), "runs", runId, "run-state.json");
  const store = new RunStateStore(runId, storeFilePath);

  // ── NDJSON event stream (issues #289 + #315) ─────────────────────────────
  // Two emit modes share one listener:
  //   - Full stream (`--json` / `AGENT_CI_JSON=1`): all lifecycle events on
  //     stdout for agent harnesses. Decoupled from `--quiet` so `-q` doesn't
  //     silently swap stdout for a JSON stream.
  //   - Sentinel-only (detached worker, #315): just `run.paused` and
  //     `run.finish` so the launcher can disown + exit 77 / drive exit code.
  // The launcher's tailer filters non-sentinel events anyway, so when the
  // user runs `-p` without `--json` we save the work by gating lifecycle
  // events on the full-stream check below.
  const fullEventStream = isJsonMode();
  if (fullEventStream || isDetachedWorker()) {
    const emit = (event: LogEvent) => process.stdout.write(formatEvent(event) + "\n");
    if (fullEventStream) {
      emit({
        event: "run.start",
        ts: new Date().toISOString(),
        schemaVersion: EVENT_SCHEMA_VERSION,
        runId,
      });
    }

    const pausesEmitted = new Set<string>();
    const jobsStarted = new Set<string>();
    const jobsFinished = new Set<string>();
    const stepsStarted = new Set<string>();
    const stepsFinished = new Set<string>();
    store.onUpdate((state) => {
      for (const wf of state.workflows) {
        for (const job of wf.jobs) {
          if (fullEventStream) {
            if (
              !jobsStarted.has(job.runnerId) &&
              (job.status === "running" ||
                job.status === "paused" ||
                job.status === "completed" ||
                job.status === "failed")
            ) {
              jobsStarted.add(job.runnerId);
              emit({
                event: "job.start",
                ts: job.startedAt ?? new Date().toISOString(),
                job: job.id,
                runner: job.runnerId,
                workflow: wf.id,
              });
            }
            for (const step of job.steps) {
              const startKey = `${job.runnerId}:${step.index}:start`;
              if (
                !stepsStarted.has(startKey) &&
                (step.status === "running" ||
                  step.status === "completed" ||
                  step.status === "failed" ||
                  step.status === "skipped")
              ) {
                stepsStarted.add(startKey);
                emit({
                  event: "step.start",
                  ts: step.startedAt ?? new Date().toISOString(),
                  job: job.id,
                  runner: job.runnerId,
                  step: step.name,
                  index: step.index,
                });
              }
              const finishKey = `${job.runnerId}:${step.index}:finish`;
              if (
                !stepsFinished.has(finishKey) &&
                (step.status === "completed" ||
                  step.status === "failed" ||
                  step.status === "skipped")
              ) {
                stepsFinished.add(finishKey);
                emit({
                  event: "step.finish",
                  ts: step.completedAt ?? new Date().toISOString(),
                  job: job.id,
                  runner: job.runnerId,
                  step: step.name,
                  index: step.index,
                  status:
                    step.status === "completed"
                      ? "passed"
                      : step.status === "failed"
                        ? "failed"
                        : "skipped",
                  durationMs: step.durationMs,
                });
              }
            }
          }
          if (job.status === "paused") {
            const key = `${job.runnerId}:${job.attempt ?? 1}`;
            if (!pausesEmitted.has(key)) {
              pausesEmitted.add(key);
              emit({
                event: "run.paused",
                ts: new Date().toISOString(),
                runner: job.runnerId,
                step: job.pausedAtStep,
                attempt: job.attempt,
                workflow: wf.id,
                retry_cmd: `agent-ci retry --name ${job.runnerId}`,
              });
            }
          }
          if (
            fullEventStream &&
            !jobsFinished.has(job.runnerId) &&
            (job.status === "completed" || job.status === "failed")
          ) {
            jobsFinished.add(job.runnerId);
            emit({
              event: "job.finish",
              ts: job.completedAt ?? new Date().toISOString(),
              job: job.id,
              runner: job.runnerId,
              workflow: wf.id,
              status: job.status === "completed" ? "passed" : "failed",
              durationMs: job.durationMs,
            });
          }
        }
      }
    });
  }

  // Start the render loop — reads from store, never touches execution logic.
  // Skip animated rendering and emit structured stderr lines instead when:
  //   - agent mode (AI_AGENT=1 or --quiet),
  //   - --json (ANSI on stdout would collide with the NDJSON stream), or
  //   - detached worker (stdout is a log file, not a terminal).
  let renderInterval: ReturnType<typeof setInterval> | null = null;
  let renderer: ReturnType<typeof createDiffRenderer> | null = null;
  if (isAgentMode() || isJsonMode() || isDetachedWorker()) {
    const reportedPauses = new Set<string>();
    const reportedSteps = new Map<string, Set<string>>();
    const reportedRunners = new Set<string>();
    const emit = (msg: string) => process.stderr.write(msg + "\n");
    store.onUpdate((state) => {
      for (const wf of state.workflows) {
        for (const job of wf.jobs) {
          if (job.status !== "queued" && !reportedRunners.has(job.runnerId)) {
            reportedRunners.add(job.runnerId);
            const degradedTag = job.classification === "degraded" ? " [degraded]" : "";
            emit(`[Agent CI] Starting runner ${job.runnerId}${degradedTag} (${wf.id} > ${job.id})`);
            if (job.logDir) {
              emit(`  Logs: ${job.logDir}`);
            }
          }
          if (!reportedSteps.has(job.runnerId)) {
            reportedSteps.set(job.runnerId, new Set());
          }
          const seen = reportedSteps.get(job.runnerId)!;
          for (const step of job.steps) {
            const key = `${step.index}:${step.status}`;
            if (seen.has(key)) {
              continue;
            }
            if (step.status === "completed" || step.status === "running") {
              seen.add(key);
            } else if (step.status === "failed") {
              seen.add(key);
              emit(`  ✗ ${step.name}`);
            }
          }
          if (job.status === "paused" && !reportedPauses.has(job.runnerId)) {
            reportedPauses.add(job.runnerId);
            const lines: string[] = [];
            lines.push(`\n[Agent CI] Step failed: "${job.pausedAtStep}" (${wf.id} > ${job.id})`);
            if (job.attempt && job.attempt > 1) {
              lines.push(`  Attempt: ${job.attempt}`);
            }
            if (job.lastOutputLines && job.lastOutputLines.length > 0) {
              lines.push("  Last output:");
              for (const l of job.lastOutputLines) {
                lines.push(`    ${l}`);
              }
            }
            lines.push(`  To retry:  agent-ci retry --name ${job.runnerId}`);
            emit(lines.join("\n"));
          } else if (job.status !== "paused" && reportedPauses.has(job.runnerId)) {
            reportedPauses.delete(job.runnerId);
          }
        }
      }
    });
  } else {
    renderer = createDiffRenderer();
    const render = renderer;
    renderInterval = setInterval(() => {
      const state = store.getState();
      if (state.workflows.length > 0) {
        render.update(renderRunState(state));
      }
    }, 80);
  }

  // Top-level signal handler: exit the process after per-job handlers have
  // cleaned up their containers. All listeners fire synchronously in
  // registration order, so we defer the exit to let per-job handlers
  // (registered later in local-job.ts) run first.
  const exitOnSignal = () => {
    setTimeout(() => process.exit(1), 0);
  };
  process.on("SIGINT", exitOnSignal);
  process.on("SIGTERM", exitOnSignal);
  process.on("SIGHUP", exitOnSignal);

  // Pre-register all workflows so they appear immediately in the render
  // loop (as "queued") before any bootstrap or execution starts.
  for (const wp of workflowPaths) {
    store.addWorkflow(wp);
  }

  // ── Session bootstrap ─────────────────────────────────────────────────────
  // Global Docker/workspace cleanup + image prefetch run once per session
  // instead of per-workflow. With `--all` launching many workflows in
  // parallel, running these inside handleWorkflow() hammered the Docker
  // daemon (N× `docker volume prune`, N× cold-start image pulls) and
  // serialized work that should have been free. See issue #211.
  // Skip Docker cleanup when running nested inside a container (e.g.
  // smoke-bun-setup step 8). The shared Docker socket exposes the host's
  // containers, and killOrphanedContainers would kill our parent container
  // because host PIDs don't exist in the container's PID namespace.
  if (!fs.existsSync("/.dockerenv")) {
    pruneOrphanedDockerResources();
    killOrphanedContainers();
  }
  pruneStaleWorkspaces(getWorkingDirectory(), 24 * 60 * 60 * 1000);
  await prefetchRunnerImages(workflowPaths);

  if (prewarmThrough) {
    await runPrewarmThrough({
      spec: parsePrewarmThroughSpec(prewarmThrough),
      sha,
      pauseOnFailure,
      store,
      githubToken,
      vars,
      workflowPaths,
    });
  } else {
    await warnIfPrewarmLikelyNeeded(workflowPaths);
  }

  // Global concurrency limiter shared across all workflows. Without this,
  // --all mode launches every workflow in parallel — leading to 20+
  // simultaneous containers that exhaust available memory and trigger
  // OOM kills (exit 137). See issue #225.
  const globalLimiter = createConcurrencyLimiter(options.maxJobs ?? getDefaultMaxConcurrentJobs());

  try {
    const allResults: JobResult[] = [];

    if (workflowPaths.length === 1) {
      // A single workflow still uses the shared global concurrency limiter.
      const results = await handleWorkflow({
        workflowPath: workflowPaths[0],
        sha,
        pauseOnFailure,
        noMatrix,
        store,
        githubToken,
        globalLimiter,
        vars,
      });
      allResults.push(...results);
    } else {
      // Every workflow gets private node_modules, so cold workflows are safe to
      // launch together. Pre-allocate run numbers to avoid container collisions.
      const baseRunNum = getNextLogNum("agent-ci");
      const runNums = workflowPaths.map((_, i) => baseRunNum + i);
      const settled = await Promise.allSettled(
        workflowPaths.map((wf, i) =>
          handleWorkflow({
            workflowPath: wf,
            sha,
            pauseOnFailure,
            noMatrix,
            store,
            baseRunNum: runNums[i],
            githubToken,
            globalLimiter,
            vars,
          }),
        ),
      );
      for (const s of settled) {
        if (s.status === "fulfilled") {
          allResults.push(...s.value);
        } else {
          console.error(`\n[Agent CI] Workflow failed: ${s.reason?.message || String(s.reason)}`);
        }
      }
    }

    store.complete(allResults.some((r) => !r.succeeded) ? "failed" : "completed");
    return allResults;
  } finally {
    process.removeListener("SIGINT", exitOnSignal);
    process.removeListener("SIGTERM", exitOnSignal);
    process.removeListener("SIGHUP", exitOnSignal);
    if (renderInterval) {
      clearInterval(renderInterval);
    }
    if (renderer) {
      // Final render — show the completed state
      const finalState = store.getState();
      if (finalState.workflows.length > 0) {
        renderer.update(renderRunState(finalState));
      }
      renderer.done();
    }
  }
}

type ExpandedJob = {
  workflowPath: string;
  taskName: string;
  sourceTaskName?: string;
  matrixContext?: Record<string, string>;
  inputs?: Record<string, string>;
  inputDefaults?: Record<string, string>;
  workflowCallOutputDefs?: Record<string, string>;
  callerJobId?: string;
  runnerName: string;
  services?: Awaited<ReturnType<typeof parseWorkflowServices>>;
  container?: Awaited<ReturnType<typeof parseWorkflowContainer>>;
  classification?: ResourceFidelity;
  classificationSummary?: string;
  classificationReasons?: string[];
};

/**
 * Expand each reusable-job entry into one ExpandedJob per matrix combination,
 * or a single ExpandedJob when the entry has no matrix. `nextRunnerName`
 * assigns the deterministic `agent-ci-<run>-jN[-mM]` runner id.
 */
async function expandJobs(
  expandedEntries: ExpandedJobEntry[],
  noMatrix: boolean,
  nextRunnerName: (matrixContext?: Record<string, string>) => string,
): Promise<ExpandedJob[]> {
  const out: ExpandedJob[] = [];
  for (const entry of expandedEntries) {
    const matrixDef = await parseMatrixDef(entry.workflowPath, entry.sourceTaskName);
    if (!matrixDef) {
      out.push({
        workflowPath: entry.workflowPath,
        taskName: entry.id,
        sourceTaskName: entry.sourceTaskName,
        runnerName: nextRunnerName(),
        inputs: entry.inputs,
        inputDefaults: entry.inputDefaults,
        workflowCallOutputDefs: entry.workflowCallOutputDefs,
        callerJobId: entry.callerJobId,
      });
      continue;
    }
    const combos = noMatrix
      ? collapseMatrixToSingle(matrixDef)
      : expandMatrixCombinations(matrixDef);
    const total = combos.length;
    for (let ci = 0; ci < combos.length; ci++) {
      const matrixContext = noMatrix
        ? combos[ci]
        : { ...combos[ci], __job_total: String(total), __job_index: String(ci) };
      out.push({
        workflowPath: entry.workflowPath,
        taskName: entry.id,
        sourceTaskName: entry.sourceTaskName,
        runnerName: nextRunnerName(matrixContext),
        matrixContext,
        inputs: entry.inputs,
        inputDefaults: entry.inputDefaults,
        workflowCallOutputDefs: entry.workflowCallOutputDefs,
        callerJobId: entry.callerJobId,
      });
    }
  }
  return out;
}

/**
 * Classify every job's resource needs against the host. Mutates each job in
 * place with `services`, `container`, `classification`, `classificationSummary`,
 * and `classificationReasons`.
 */
async function classifyJobsResources(
  jobs: ExpandedJob[],
  workflowPath: string,
  hostResources: ReturnType<typeof getHostResources>,
): Promise<void> {
  for (const job of jobs) {
    const labels = parseJobRunsOnLabels(workflowPath, job.taskName);
    const matrixDef = await parseMatrixDef(workflowPath, job.taskName);
    const services = await parseWorkflowServices(workflowPath, job.taskName);
    const container = await parseWorkflowContainer(workflowPath, job.taskName);
    const hints = collectJobResourceHints({
      labels,
      matrixJobTotal:
        matrixDef && job.matrixContext
          ? Number.parseInt(job.matrixContext.__job_total ?? "1", 10)
          : 1,
      matrixJobIndex:
        matrixDef && job.matrixContext
          ? Number.parseInt(job.matrixContext.__job_index ?? "0", 10)
          : 0,
      hasServices: services.length > 0,
      hasContainer: container !== null,
    });
    const classification = classifyJobResources(hints, hostResources);
    job.services = services;
    job.container = container;
    job.classification = classification.fidelity;
    job.classificationSummary =
      classification.fidelity === "degraded"
        ? `${classification.summary}. ${classification.action}`
        : classification.summary;
    job.classificationReasons = classification.reasons;
  }
}

/**
 * Run every job in a wave through the concurrency limiter, collect results,
 * and convert rejections into failed JobResults. `seenErrorMessages` is shared
 * across waves so duplicate error lines are not printed.
 */
async function runWaveJobs(
  waveJobs: ExpandedJob[],
  limiter: ReturnType<typeof createConcurrencyLimiter>,
  runOrSkipJob: (ej: ExpandedJob) => Promise<JobResult>,
  workflowPath: string,
  seenErrorMessages: Set<string>,
): Promise<JobResult[]> {
  const settled = await Promise.allSettled(
    waveJobs.map((ej) =>
      limiter.run(() =>
        runOrSkipJob(ej).catch((error) => {
          throw wrapJobError(ej.taskName, error);
        }),
      ),
    ),
  );
  const out: JobResult[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") {
      out.push(r.value);
      continue;
    }
    const taskName = isJobError(r.reason) ? r.reason.taskName : "unknown";
    const errorMessage = isJobError(r.reason) ? r.reason.message : String(r.reason);
    if (!seenErrorMessages.has(errorMessage)) {
      seenErrorMessages.add(errorMessage);
      console.error(`\n[Agent CI] Job failed with error: ${taskName}`);
      console.error(`  Error: ${errorMessage}`);
    }
    out.push(createFailedJobResult(taskName, workflowPath, r.reason));
  }
  return out;
}

// ─── handleWorkflow ───────────────────────────────────────────────────────────
// Processes a single workflow file: parses jobs, handles matrix expansion,
// dependency-aware wave scheduling, and concurrency limiting.

async function handleWorkflow(options: {
  workflowPath: string;
  sha?: string;
  pauseOnFailure: boolean;
  noMatrix?: boolean;
  store: RunStateStore;
  baseRunNum?: number;
  githubToken?: string;
  globalLimiter: ReturnType<typeof createConcurrencyLimiter>;
  vars?: Record<string, string>;
}): Promise<JobResult[]> {
  const { sha, pauseOnFailure, noMatrix = false, store, githubToken } = options;
  const vars = options.vars ?? {};
  let workflowPath = options.workflowPath;

  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Workflow file not found: ${workflowPath}`);
  }

  const repoRoot = resolveRepoRootFromWorkflow(workflowPath);

  if (!process.env.AGENT_CI_WORKING_DIR) {
    setWorkingDirectory(DEFAULT_WORKING_DIR);
  }

  // Resolve startup git / remote calls concurrently. headSha, dirtySha, the
  // repo slug, and the upstream remote URL are independent — running them in
  // parallel saves ~half a second on every invocation.
  // Always resolve a SHA that represents the code being executed: an explicit
  // --sha wins, then a dirty-tree ephemeral SHA, then plain HEAD. Information
  // only — actions/checkout is stubbed, so no workflow tries to fetch it.
  const [explicitHead, dirtySha, headSlug, slugFromRemote] = await Promise.all([
    sha ? resolveHeadSha(repoRoot, sha) : Promise.resolve(undefined),
    sha ? Promise.resolve(undefined) : computeDirtySha(repoRoot),
    resolveHeadSha(repoRoot, "HEAD"),
    config.GITHUB_REPO ? Promise.resolve(config.GITHUB_REPO) : resolveRepoSlug(repoRoot),
  ]);
  const { headSha, shaRef } = explicitHead ?? { headSha: undefined, shaRef: undefined };
  const realHeadSha = headSha ?? dirtySha ?? headSlug.headSha;
  const baseSha = await resolveBaseSha(repoRoot, realHeadSha);
  const githubRepo = slugFromRemote;
  config.GITHUB_REPO = githubRepo;
  const [owner, name] = githubRepo.split("/");
  const workflowGithubContext = {
    repository: githubRepo,
    repository_owner: owner,
    actor: owner,
    sha: realHeadSha,
  };

  const remoteCacheDir = path.resolve(getWorkingDirectory(), "cache", "remote-workflows");
  const remoteCache = await prefetchRemoteWorkflows(workflowPath, remoteCacheDir, githubToken);
  const expandedEntries = expandReusableJobs(workflowPath, repoRoot, remoteCache);

  if (expandedEntries.length === 0) {
    debugCli(`[Agent CI] No jobs found in workflow: ${path.basename(workflowPath)}`);
    return [];
  }

  // ── Collect expanded jobs (with matrix expansion) ─────────────────────────
  const baseRunNum = options.baseRunNum ?? getNextLogNum("agent-ci");
  let globalIdx = 0;
  const nextRunnerName = (matrixContext?: Record<string, string>): string => {
    const idx = globalIdx++;
    let suffix = `-j${idx + 1}`;
    if (matrixContext) {
      const shardIdx = parseInt(matrixContext.__job_index ?? "0", 10) + 1;
      suffix += `-m${shardIdx}`;
    }
    return `agent-ci-${baseRunNum}${suffix}`;
  };

  const expandedJobs = await expandJobs(expandedEntries, noMatrix, nextRunnerName);

  // Pre-register all jobs so they appear as "queued" in the render loop
  // before execution starts. Uses the same naming convention as buildJob.
  // Only in multi-workflow mode (baseRunNum is set) where naming is deterministic.
  if (expandedJobs.length > 1 && options.baseRunNum != null) {
    for (let i = 0; i < expandedJobs.length; i++) {
      const ej = expandedJobs[i];
      let suffix = `-j${i + 1}`;
      if (ej.matrixContext) {
        const shardIdx = parseInt(ej.matrixContext.__job_index ?? "0", 10) + 1;
        suffix += `-m${shardIdx}`;
      }
      const runnerId = `agent-ci-${options.baseRunNum}${suffix}`;
      const storeWfPath = ej.callerJobId ? workflowPath : ej.workflowPath;
      store.addJob(storeWfPath, ej.taskName, runnerId, {
        matrixValues: ej.matrixContext
          ? Object.fromEntries(
              Object.entries(ej.matrixContext).filter(([k]) => !k.startsWith("__")),
            )
          : undefined,
      });
    }
  }

  // ── Unsupported-OS skip (shared between single- and multi-job paths) ──────
  // Jobs with `runs-on: macos-*` or `windows-*` can't be executed locally
  // today — agent-ci only runs jobs in a Linux container. Rather than
  // silently landing them there and failing at the first OS-specific step,
  // we skip them with a visible warning. See:
  //   https://github.com/redwoodjs/agent-ci/issues/254  (this guardrail)
  //   https://github.com/redwoodjs/agent-ci/issues/258  (real macOS support)
  const skippedResult = (ej: ExpandedJob): JobResult => ({
    name: `agent-ci-skipped-${ej.taskName}`,
    workflow: path.basename(ej.workflowPath),
    taskId: ej.taskName,
    succeeded: true,
    durationMs: 0,
    debugLogPath: "",
    steps: [],
  });
  const warnedUnsupportedOS = new Set<string>();
  const macosVmHost = checkMacosVmHost();
  const classifyJob = (ej: ExpandedJob) => {
    const labels = parseJobRunsOn(ej.workflowPath, ej.sourceTaskName ?? ej.taskName);
    return { labels, kind: classifyRunsOn(labels) };
  };
  const canRunMacosHere = (kind: RunnerOSKind) => kind === "macos" && macosVmHost.supported;
  const maybeSkipUnsupportedOS = (ej: ExpandedJob): JobResult | null => {
    const { labels, kind } = classifyJob(ej);
    if (!isUnsupportedOS(kind) || canRunMacosHere(kind)) {
      return null;
    }
    if (!warnedUnsupportedOS.has(ej.taskName)) {
      warnedUnsupportedOS.add(ej.taskName);
      const capability = kind === "macos" && !macosVmHost.supported ? macosVmHost : undefined;
      process.stderr.write(
        formatUnsupportedOSWarning(ej.taskName, labels, kind, capability) + "\n\n",
      );
    }
    return skippedResult(ej);
  };
  // Returns the executor for a job. Callers have already filtered out
  // OS-skipped jobs via maybeSkipUnsupportedOS.
  const runJobExecutor = (ej: ExpandedJob, job: Job): Promise<JobResult> => {
    if (canRunMacosHere(classifyJob(ej).kind)) {
      return executeMacosVmJob(job);
    }
    return executeLocalJob(job, { pauseOnFailure, store });
  };

  // For single-job workflows, run directly without extra orchestration
  const limiter = options.globalLimiter;
  await classifyJobsResources(expandedJobs, workflowPath, getHostResources());

  const degradedWarnings = new Set<string>();
  const warnDegradedJob = (job: ExpandedJob): void => {
    if (job.classification !== "degraded" || degradedWarnings.has(job.runnerName)) {
      return;
    }

    degradedWarnings.add(job.runnerName);
    console.warn(
      `[Agent CI] Running ${path.basename(workflowPath)}:${job.taskName} in degraded mode: ${job.classificationSummary}`,
    );
  };

  if (expandedJobs.length === 1) {
    const ej = expandedJobs[0];
    const osSkip = maybeSkipUnsupportedOS(ej);
    if (osSkip) {
      return [osSkip];
    }
    const actualTaskName = ej.sourceTaskName ?? ej.taskName;
    const requiredRefs = extractSecretRefs(ej.workflowPath, actualTaskName);
    const secrets = loadMachineSecrets(repoRoot, requiredRefs);
    if (githubToken && !secrets["GITHUB_TOKEN"]) {
      secrets["GITHUB_TOKEN"] = githubToken;
    }
    const secretsFilePath = path.join(repoRoot, ".env.agent-ci");
    validateSecrets(ej.workflowPath, actualTaskName, secrets, secretsFilePath);
    validateVars(ej.workflowPath, actualTaskName, vars);

    // Resolve inputs for called workflow jobs
    let inputsContext: Record<string, string> | undefined;
    if (ej.callerJobId) {
      inputsContext = { ...ej.inputDefaults };
      if (ej.inputs) {
        for (const [k, v] of Object.entries(ej.inputs)) {
          inputsContext[k] = expandExpressions(
            v,
            repoRoot,
            secrets,
            undefined,
            undefined,
            undefined,
            vars,
          );
        }
      }
      if (Object.keys(inputsContext).length === 0) {
        inputsContext = undefined;
      }
    }

    const steps = await parseWorkflowSteps(
      ej.workflowPath,
      actualTaskName,
      secrets,
      ej.matrixContext,
      undefined,
      inputsContext,
      vars,
    );
    const expressionContext = {
      repoPath: repoRoot,
      secrets,
      matrixContext: ej.matrixContext,
      inputsContext,
      vars,
      githubContext: workflowGithubContext,
    };
    const services = await parseWorkflowServices(
      ej.workflowPath,
      actualTaskName,
      expressionContext,
    );
    const container = await parseWorkflowContainer(
      ej.workflowPath,
      actualTaskName,
      expressionContext,
    );

    store.addJob(ej.workflowPath, actualTaskName, ej.runnerName, {
      classification: ej.classification,
      classificationSummary: ej.classificationSummary,
      classificationReasons: ej.classificationReasons,
    });
    warnDegradedJob(ej);

    const job: Job = {
      deliveryId: `run-${Date.now()}`,
      eventType: "workflow_job",
      githubJobId: `local-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      githubRepo: githubRepo,
      githubToken: "mock_token",
      headSha: headSha,
      baseSha: baseSha,
      realHeadSha: realHeadSha,
      repoRoot: repoRoot,
      shaRef: shaRef,
      env: { AGENT_CI_LOCAL: "true" },
      repository: {
        name: name,
        full_name: githubRepo,
        owner: { login: owner },
        default_branch: "main",
      },
      runnerName: ej.runnerName,
      steps,
      services,
      container: container ?? undefined,
      workflowPath: ej.workflowPath,
      parentWorkflowPath: ej.callerJobId ? workflowPath : undefined,
      taskId: ej.taskName,
    };

    const result = await limiter.run(() => runJobExecutor(ej, job));
    return [result];
  }

  const buildJob = (ej: ExpandedJob): Job => {
    const actualTaskName = ej.sourceTaskName ?? ej.taskName;
    const requiredRefs = extractSecretRefs(ej.workflowPath, actualTaskName);
    const secrets = loadMachineSecrets(repoRoot, requiredRefs);
    if (githubToken && !secrets["GITHUB_TOKEN"]) {
      secrets["GITHUB_TOKEN"] = githubToken;
    }
    const secretsFilePath = path.join(repoRoot, ".env.agent-ci");
    validateSecrets(ej.workflowPath, actualTaskName, secrets, secretsFilePath);
    validateVars(ej.workflowPath, actualTaskName, vars);

    // Use the job's position in expandedJobs (not a mutable counter) so the
    // runnerId is deterministic and matches the pre-registration at line 716.
    const idx = expandedJobs.indexOf(ej);
    let suffix = `-j${idx + 1}`;
    if (ej.matrixContext) {
      const shardIdx = parseInt(ej.matrixContext.__job_index ?? "0", 10) + 1;
      suffix += `-m${shardIdx}`;
    }
    const derivedRunnerName = `agent-ci-${baseRunNum}${suffix}`;

    return {
      deliveryId: `run-${Date.now()}`,
      eventType: "workflow_job",
      githubJobId: Math.floor(Math.random() * 1000000).toString(),
      githubRepo: githubRepo,
      githubToken: "mock_token",
      headSha: headSha,
      baseSha: baseSha,
      realHeadSha: realHeadSha,
      repoRoot: repoRoot,
      shaRef: shaRef,
      env: { AGENT_CI_LOCAL: "true" },
      repository: {
        name: name,
        full_name: githubRepo,
        owner: { login: owner },
        default_branch: "main",
      },
      runnerName: derivedRunnerName,
      steps: undefined as any,
      services: undefined as any,
      container: undefined,
      workflowPath: ej.workflowPath,
      parentWorkflowPath: ej.callerJobId ? workflowPath : undefined,
      taskId: ej.taskName,
    };
  };

  // Cache resolved inputs per callerJobId (all sub-jobs share the same inputs)
  const resolvedInputsCache = new Map<string, Record<string, string>>();

  const resolveInputsForJob = (
    ej: ExpandedJob,
    secrets: Record<string, string>,
    needsContext?: Record<string, Record<string, string>>,
    vars?: Record<string, string>,
  ): Record<string, string> | undefined => {
    if (!ej.callerJobId) {
      return undefined;
    }
    const cached = resolvedInputsCache.get(ej.callerJobId);
    if (cached) {
      return cached;
    }

    // Start with defaults, then override with caller's `with:` values (expanded)
    const resolved: Record<string, string> = { ...ej.inputDefaults };
    if (ej.inputs) {
      for (const [k, v] of Object.entries(ej.inputs)) {
        resolved[k] = expandExpressions(
          v,
          repoRoot,
          secrets,
          undefined,
          needsContext,
          undefined,
          vars,
        );
      }
    }
    resolvedInputsCache.set(ej.callerJobId, resolved);
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  };

  const runJob = async (
    ej: ExpandedJob,
    needsContext?: Record<string, Record<string, string>>,
  ): Promise<JobResult> => {
    const { taskName, matrixContext } = ej;
    const actualTaskName = ej.sourceTaskName ?? taskName;
    debugCli(
      `Running: ${path.basename(ej.workflowPath)} | Task: ${taskName}${matrixContext ? ` | Matrix: ${JSON.stringify(Object.fromEntries(Object.entries(matrixContext).filter(([k]) => !k.startsWith("__"))))}` : ""}`,
    );
    const requiredRefs = extractSecretRefs(ej.workflowPath, actualTaskName);
    const secrets = loadMachineSecrets(repoRoot, requiredRefs);
    if (githubToken && !secrets["GITHUB_TOKEN"]) {
      secrets["GITHUB_TOKEN"] = githubToken;
    }
    const secretsFilePath = path.join(repoRoot, ".env.agent-ci");
    validateSecrets(ej.workflowPath, actualTaskName, secrets, secretsFilePath);
    validateVars(ej.workflowPath, actualTaskName, vars);
    const inputsContext = resolveInputsForJob(ej, secrets, needsContext, vars);
    const steps = await parseWorkflowSteps(
      ej.workflowPath,
      actualTaskName,
      secrets,
      matrixContext,
      needsContext,
      inputsContext,
      vars,
    );
    const expressionContext = {
      repoPath: repoRoot,
      secrets,
      matrixContext,
      needsContext,
      inputsContext,
      vars,
      githubContext: workflowGithubContext,
    };
    const services = await parseWorkflowServices(
      ej.workflowPath,
      actualTaskName,
      expressionContext,
    );
    const container = await parseWorkflowContainer(
      ej.workflowPath,
      actualTaskName,
      expressionContext,
    );

    const job = buildJob(ej);
    job.steps = steps;
    job.services = services;
    job.container = container ?? undefined;

    const result = await runJobExecutor(ej, job);

    // result.outputs now contains raw step outputs (extracted inside executeLocalJob
    // before workspace cleanup). Resolve them to job-level outputs using the
    // output definitions from the workflow YAML.
    if (result.outputs && Object.keys(result.outputs).length > 0) {
      const outputDefs = parseJobOutputDefs(ej.workflowPath, actualTaskName);
      if (Object.keys(outputDefs).length > 0) {
        result.outputs = resolveJobOutputs(outputDefs, result.outputs);
      }
    }

    return result;
  };

  const allResults: JobResult[] = [];
  // Accumulate job outputs across waves for needs.*.outputs.* resolution
  const jobOutputs = new Map<string, Record<string, string>>();

  // ── Dependency-aware wave scheduling ──────────────────────────────────────
  const deps = new Map<string, string[]>();
  for (const entry of expandedEntries) {
    deps.set(entry.id, entry.needs);
  }
  const waves = topoSort(deps);

  const taskNamesInWf = new Set(expandedJobs.map((j) => j.taskName));
  const filteredWaves = waves
    .map((wave) => wave.filter((jobId) => taskNamesInWf.has(jobId)))
    .filter((wave) => wave.length > 0);

  if (filteredWaves.length === 0) {
    filteredWaves.push(Array.from(taskNamesInWf));
  }

  /** Build a needsContext for a job from its dependencies' accumulated outputs */
  const buildNeedsContext = (jobId: string): Record<string, Record<string, string>> | undefined => {
    const jobDeps = deps.get(jobId);
    if (!jobDeps || jobDeps.length === 0) {
      return undefined;
    }
    const ctx: Record<string, Record<string, string>> = {};
    for (const depId of jobDeps) {
      ctx[depId] = jobOutputs.get(depId) ?? {};
      if (depId.includes("/")) {
        const callerJobId = depId.split("/")[0];
        const calledJobId = depId.split("/").slice(1).join("/");
        // For composite IDs like "lint/setup", also add the called job ID ("setup")
        // so intra-workflow `needs.setup.outputs.*` references resolve correctly
        if (!ctx[calledJobId]) {
          ctx[calledJobId] = jobOutputs.get(depId) ?? {};
        }
        // If workflow_call outputs were resolved for the caller (e.g. "lint"),
        // add them so downstream `needs.lint.outputs.*` references work
        if (jobOutputs.has(callerJobId)) {
          ctx[callerJobId] = jobOutputs.get(callerJobId)!;
        }
      }
    }
    return Object.keys(ctx).length > 0 ? ctx : undefined;
  };

  /** Collect outputs from a completed job result */
  const collectOutputs = (result: JobResult, taskName: string) => {
    if (result.outputs && Object.keys(result.outputs).length > 0) {
      jobOutputs.set(taskName, result.outputs);
    }
  };

  /**
   * After a wave completes, resolve workflow_call outputs for any caller jobs
   * whose sub-jobs have all finished. This allows downstream jobs to access
   * `needs.<callerJobId>.outputs.*`.
   */
  const resolveWorkflowCallOutputs = () => {
    // Group expanded jobs by callerJobId
    const byCallerJobId = new Map<string, ExpandedJob[]>();
    for (const ej of expandedJobs) {
      if (ej.callerJobId) {
        const group = byCallerJobId.get(ej.callerJobId) ?? [];
        group.push(ej);
        byCallerJobId.set(ej.callerJobId, group);
      }
    }

    for (const [callerJobId, subJobs] of byCallerJobId) {
      // Check if all sub-jobs have completed (have results)
      const allDone = subJobs.every((sj) => jobResultStatus.has(sj.taskName));
      if (!allDone) {
        continue;
      }
      // Already resolved
      if (jobOutputs.has(callerJobId)) {
        continue;
      }

      // Find the output defs (all sub-jobs share the same defs)
      const outputDefs = subJobs[0]?.workflowCallOutputDefs;
      if (!outputDefs || Object.keys(outputDefs).length === 0) {
        continue;
      }

      // Resolve each output value expression: ${{ jobs.<id>.outputs.<name> }}
      const resolved: Record<string, string> = {};
      for (const [outputName, valueExpr] of Object.entries(outputDefs)) {
        resolved[outputName] = valueExpr.replace(
          /\$\{\{\s*jobs\.([^.]+)\.outputs\.([^}\s]+)\s*\}\}/g,
          (_match, jobId, outputKey) => {
            const compositeId = `${callerJobId}/${jobId}`;
            return jobOutputs.get(compositeId)?.[outputKey] ?? "";
          },
        );
      }
      jobOutputs.set(callerJobId, resolved);
    }
  };

  // Track job results for if-condition evaluation (success/failure status)
  const jobResultStatus = new Map<string, string>();

  /** Check if a job should be skipped based on its if: condition */
  const shouldSkipJob = (jobId: string, ej?: ExpandedJob): boolean => {
    const ejWorkflowPath = ej?.workflowPath ?? workflowPath;
    const actualTaskName = ej?.sourceTaskName ?? jobId;
    const ifExpr = parseJobIf(ejWorkflowPath, actualTaskName);
    if (ifExpr === null) {
      // No if: condition — default behavior is success() (skip if any upstream failed)
      const jobDeps = deps.get(jobId);
      if (jobDeps && jobDeps.length > 0) {
        const anyFailed = jobDeps.some((d) => jobResultStatus.get(d) === "failure");
        if (anyFailed) {
          return true;
        }
      }
      return false;
    }
    // Build upstream job results for the evaluator
    const upstreamResults: Record<string, string> = {};
    const jobDeps = deps.get(jobId) ?? [];
    for (const depId of jobDeps) {
      upstreamResults[depId] = jobResultStatus.get(depId) ?? "success";
    }
    const needsCtx = buildNeedsContext(jobId);
    return !evaluateJobIf(ifExpr, upstreamResults, needsCtx);
  };

  /** Run a job or skip it based on if: condition or unsupported OS */
  const runOrSkipJob = async (ej: ExpandedJob): Promise<JobResult> => {
    const osSkip = maybeSkipUnsupportedOS(ej);
    if (osSkip) {
      jobResultStatus.set(ej.taskName, "skipped");
      return osSkip;
    }
    if (shouldSkipJob(ej.taskName, ej)) {
      debugCli(`Skipping ${ej.taskName} (if: condition is false)`);
      const result = skippedResult(ej);
      jobResultStatus.set(ej.taskName, "skipped");
      return result;
    }
    const ctx = buildNeedsContext(ej.taskName);
    const result = await runJob(ej, ctx);
    jobResultStatus.set(ej.taskName, result.succeeded ? "success" : "failure");
    collectOutputs(result, ej.taskName);
    return result;
  };

  const seenErrorMessages = new Set<string>();

  for (let wi = 0; wi < filteredWaves.length; wi++) {
    const waveJobIds = new Set(filteredWaves[wi]);
    const waveJobs = expandedJobs.filter((j) => waveJobIds.has(j.taskName));

    if (waveJobs.length === 0) {
      continue;
    }

    const results = await runWaveJobs(
      waveJobs,
      limiter,
      runOrSkipJob,
      workflowPath,
      seenErrorMessages,
    );
    allResults.push(...results);

    // After each wave, resolve workflow_call outputs for completed caller jobs
    resolveWorkflowCallOutputs();

    // Check whether to abort remaining waves on failure
    const waveHadFailures = allResults.some((r) => !r.succeeded);
    if (waveHadFailures && wi < filteredWaves.length - 1) {
      // Check fail-fast setting for jobs in this wave
      const waveFailFastSettings = waveJobs.map((ej) =>
        parseFailFast(ej.workflowPath, ej.sourceTaskName ?? ej.taskName),
      );
      // Abort unless ALL jobs in the wave explicitly set fail-fast: false
      const shouldAbort = !waveFailFastSettings.every((ff) => ff === false);
      if (shouldAbort) {
        debugCli(
          `Wave ${wi + 1} had failures — aborting remaining waves for ${path.basename(workflowPath)}`,
        );
        break;
      } else {
        debugCli(`Wave ${wi + 1} had failures but fail-fast is disabled — continuing`);
      }
    }
  }

  return allResults;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function resolveRepoRoot() {
  let repoRoot = process.cwd();
  while (repoRoot !== "/" && !fs.existsSync(path.join(repoRoot, ".git"))) {
    repoRoot = path.dirname(repoRoot);
  }
  return repoRoot === "/" ? process.cwd() : repoRoot;
}

function resolveRepoRootFromWorkflow(workflowPath: string): string {
  let repoRoot = path.dirname(workflowPath);
  while (repoRoot !== "/" && !fs.existsSync(path.join(repoRoot, ".git"))) {
    repoRoot = path.dirname(repoRoot);
  }
  return repoRoot === "/" ? resolveRepoRoot() : repoRoot;
}

async function resolveHeadSha(repoRoot: string, sha: string) {
  try {
    const { stdout } = await execFileP("git", ["rev-parse", sha], { cwd: repoRoot });
    return { headSha: stdout.trim(), shaRef: sha };
  } catch {
    throw new Error(`Failed to resolve ref: ${sha}`);
  }
}

/**
 * Emit the final `run.finish` NDJSON event when running under an agent harness
 * or as a detached worker. In detached mode the launcher (and a sibling
 * `agent-ci retry` tailing this log) reads it to drive its own exit code.
 * No-op in normal interactive runs.
 */
function emitRunFinishSentinel(status: "passed" | "failed"): void {
  if (!isJsonMode() && !isDetachedWorker()) {
    return;
  }
  process.stdout.write(
    formatEvent({ event: "run.finish", ts: new Date().toISOString(), status }) + "\n",
  );
}

async function persistRunResult(opts: {
  results: JobResult[];
  repoRoot: string;
  startedAt: Date;
  sha?: string;
  branch?: string;
}): Promise<void> {
  try {
    const [repo, branch, headSha] = await Promise.all([
      config.GITHUB_REPO ?? resolveRepoSlug(opts.repoRoot),
      opts.branch ??
        execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: opts.repoRoot }).then((r) =>
          r.stdout.trim(),
        ),
      opts.sha ??
        execFileP("git", ["rev-parse", "HEAD"], { cwd: opts.repoRoot }).then((r) =>
          r.stdout.trim(),
        ),
    ]);
    writeRunResult({
      repo,
      branch,
      worktreePath: opts.repoRoot,
      headSha,
      startedAt: opts.startedAt,
      finishedAt: new Date(),
      results: opts.results,
    });
  } catch {
    // Best-effort: never let result persistence fail the run.
  }
}

/** Resolve the parent commit SHA for push-event `before` context. */
async function resolveBaseSha(repoRoot: string, headSha?: string): Promise<string | undefined> {
  try {
    const ref = headSha && headSha !== "HEAD" ? `${headSha}~1` : "HEAD~1";
    const { stdout } = await execFileP("git", ["rev-parse", ref], { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

// Minimal usage hint emitted when `run` is missing required args.
// The full --help text lives in cli.ts to avoid forcing run.ts's heavy
// dependency graph onto bare `--help` invocations.
function printUsageMinimal() {
  console.log("Usage: agent-ci run [sha] (--workflow <path> | --all) [options]");
  console.log("Run 'agent-ci --help' for full usage.");
}
