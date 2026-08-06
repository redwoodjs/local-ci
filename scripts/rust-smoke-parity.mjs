#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustBin = path.join(root, "target", "debug", "local-ci");
const smokeWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-rust-smoke-"));
const smokeWorkflowTimeoutMs = Number(
  process.env.RUST_SMOKE_TIMEOUT_MS ?? (process.env.GITHUB_ACTIONS === "true" ? 5 : 20) * 60 * 1000,
);
const smokeWorkflowAttempts = Number(process.env.RUST_SMOKE_ATTEMPTS ?? 1);
const heartbeatIntervalMs = Number(process.env.RUST_SMOKE_HEARTBEAT_MS ?? 30_000);
const tailLineLimit = Number(process.env.RUST_SMOKE_TAIL_LINES ?? 200);
const logTailLineLimit = Number(process.env.RUST_SMOKE_LOG_TAIL_LINES ?? 120);
const cleanupContainersOnFailure =
  process.env.RUST_SMOKE_CLEANUP_CONTAINERS === "1" ||
  (process.env.RUST_SMOKE_CLEANUP_CONTAINERS !== "0" && process.env.GITHUB_ACTIONS === "true");
const ledgerPath = process.env.RUST_SMOKE_LEDGER ?? path.join(smokeWorkDir, "status.jsonl");
const skipAllSmoke = process.env.RUST_SMOKE_SKIP_ALL === "1";
const results = [];
const workflowStates = new Map();
let terminating = false;

console.log(`Rust smoke work dir: ${smokeWorkDir}`);
console.log(`Rust smoke status ledger: ${ledgerPath}`);
console.log(
  `Rust smoke settings: timeout=${smokeWorkflowTimeoutMs}ms attempts=${smokeWorkflowAttempts} heartbeat=${heartbeatIntervalMs}ms cleanupContainers=${cleanupContainersOnFailure}`,
);

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "pipe",
    timeout: options.timeout,
  });
}

function appendLedger(event) {
  fs.appendFileSync(
    ledgerPath,
    `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`,
  );
}

function setWorkflowState(workflow, status, details = {}) {
  workflowStates.set(workflow, {
    status,
    updatedAt: new Date().toISOString(),
    ...details,
  });
  appendLedger({ workflow, status, ...details });
}

function killChildProcessGroup(child, signal) {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

function activeLocalCiContainers() {
  const result = run(
    "docker",
    ["ps", "-a", "--filter", "name=local-ci", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}"],
    { timeout: 30_000 },
  );
  if (result.status !== 0) {
    return [
      `<docker ps failed: ${result.stderr?.trim() || result.error?.message || result.status}>`,
    ];
  }
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

function printActiveContainers(stream = process.stderr) {
  const containers = activeLocalCiContainers();
  if (containers.length === 0) {
    stream.write("active local-ci containers: <none>\n");
    return;
  }
  stream.write("active local-ci containers:\n");
  for (const line of containers) {
    stream.write(`  ${line}\n`);
  }
}

function cleanupLocalCiContainers(reason) {
  if (!cleanupContainersOnFailure) {
    console.error(`container cleanup disabled after ${reason}`);
    return;
  }
  const ids = run("docker", ["ps", "-aq", "--filter", "name=local-ci"], { timeout: 30_000 });
  if (ids.status !== 0) {
    console.error(`failed to list containers for cleanup: ${ids.stderr?.trim() || ids.status}`);
    return;
  }
  const containerIds = ids.stdout.trim().split(/\s+/).filter(Boolean);
  if (containerIds.length === 0) {
    console.error(`no local-ci containers to clean after ${reason}`);
    return;
  }
  console.error(`cleaning ${containerIds.length} local-ci container(s) after ${reason}`);
  run("docker", ["rm", "-f", ...containerIds], { stdio: "inherit", timeout: 60_000 });
}

function smokeEnvironment(workDir) {
  // Successful workflows do not need retained state, logs, or worktrees. Keep
  // all three under their own work directory so the parity suite can delete
  // them before moving to the next workflow instead of filling a CI runner.
  return {
    LOCAL_CI_WORKING_DIR: workDir,
    LOCAL_CI_LOG_DIR: path.join(workDir, "logs"),
    LOCAL_CI_STATE_DIR: path.join(workDir, "state"),
  };
}

function removeSuccessfulWorkDir(workDir) {
  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    console.warn(`failed to clean successful smoke work directory ${workDir}: ${error.message}`);
  }
}

function runStreaming(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const outputLines = [];
    let buffered = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      detached: process.platform !== "win32",
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rememberLine = (line) => {
      outputLines.push(line);
      while (outputLines.length > tailLineLimit) {
        outputLines.shift();
      }
    };

    const remember = (chunk, stream) => {
      const text = chunk.toString();
      stream.write(text);
      buffered += text;
      const parts = buffered.split(/\r?\n/);
      buffered = parts.pop() ?? "";
      for (const line of parts) {
        rememberLine(line);
      }
    };

    const finish = (status, signal, error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeatTimer);
      resolve({
        status,
        signal,
        error,
        timedOut,
        durationMs: Date.now() - startedAt,
        outputTail: [...outputLines, buffered].filter(Boolean),
      });
    };

    child.stdout.on("data", (chunk) => remember(chunk, process.stdout));
    child.stderr.on("data", (chunk) => remember(chunk, process.stderr));
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (status, signal) => finish(status, signal));

    const heartbeatTimer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const line = `▶ still running ${options.label ?? args.join(" ")} elapsed=${formatDuration(elapsedMs)}`;
      console.log(line);
      rememberLine(line);
      printActiveContainers(process.stdout);
      appendLedger({
        workflow: options.workflow,
        attempt: options.attempt,
        status: "heartbeat",
        elapsedMs,
      });
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();

    const timer = setTimeout(() => {
      timedOut = true;
      appendLedger({
        workflow: options.workflow,
        attempt: options.attempt,
        status: "timeout_signal",
        elapsedMs: Date.now() - startedAt,
      });
      killChildProcessGroup(child, "SIGTERM");
      setTimeout(() => {
        if (!settled) {
          killChildProcessGroup(child, "SIGKILL");
        }
      }, 10_000).unref();
    }, options.timeout ?? smokeWorkflowTimeoutMs);
  });
}

function resultLabel(result) {
  const cause = result.error ? ` (${result.error.message})` : "";
  const signal = result.signal ? `, signal ${result.signal}` : "";
  const timeout = result.timedOut ? ", timed out" : "";
  return `${result.status}${signal}${timeout}${cause}`;
}

function allSmokeWorkflows() {
  return fs
    .readdirSync(path.join(root, ".github/workflows"))
    .filter((file) => file.startsWith("smoke-") && file.endsWith(".yml"))
    .sort()
    .map((file) => ({ path: `.github/workflows/${file}` }));
}

function parseWorkflowList(value) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function workflowMatchesList(workflowPath, list) {
  const basename = path.basename(workflowPath);
  return list.has(workflowPath) || list.has(basename);
}

function selectedSmokeWorkflows() {
  const only = parseWorkflowList(process.env.RUST_SMOKE_ONLY);
  const exclude = parseWorkflowList(process.env.RUST_SMOKE_EXCLUDE);
  return allSmokeWorkflows().filter((workflow) => {
    if (only.size > 0 && !workflowMatchesList(workflow.path, only)) {
      return false;
    }
    if (exclude.size > 0 && workflowMatchesList(workflow.path, exclude)) {
      return false;
    }
    return true;
  });
}

function hasPrivateRemoteAccess() {
  if (process.env.RUST_SMOKE_INCLUDE_PRIVATE === "1") {
    return true;
  }
  const probe = run(
    "gh",
    [
      "api",
      "repos/peterp/agent-ci-private/contents/.github/workflows/lint.yml?ref=cf9992c0af57f77d8ce9d965446dbdb3e062be75",
      "--jq",
      ".sha",
    ],
    {
      stdio: "pipe",
      timeout: 30_000,
    },
  );
  return probe.status === 0;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function readTail(file, maxLines) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-maxLines).join("\n");
  } catch (error) {
    return `<failed to read ${file}: ${error.message}>`;
  }
}

function collectFiles(dir, depth = 0) {
  if (depth > 2) {
    return [];
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(full, depth + 1);
    }
    if (entry.isFile()) {
      return [full];
    }
    return [];
  });
}

function logDirsFromTail(lines) {
  return [
    ...new Set(
      lines
        .map((line) => line.match(/Logs:\s+(\S+)/)?.[1])
        .filter(Boolean)
        .filter((dir) => fs.existsSync(dir)),
    ),
  ];
}

function printFailureDiagnostics(workflowPath, attempt, result) {
  console.error(`::group::Rust smoke diagnostics: ${workflowPath} attempt ${attempt}`);
  console.error(`result=${resultLabel(result)} duration=${formatDuration(result.durationMs)}`);
  console.error("--- captured output tail ---");
  console.error(result.outputTail.join("\n") || "<empty>");

  for (const dir of logDirsFromTail(result.outputTail)) {
    console.error(`--- runner log dir: ${dir} ---`);
    for (const file of collectFiles(dir).sort()) {
      console.error(`--- tail ${file} ---`);
      console.error(readTail(file, logTailLineLimit));
    }
  }

  console.error("--- docker local-ci containers ---");
  printActiveContainers(process.stderr);
  console.error("::endgroup::");
}

function printStateBuckets() {
  console.log("\n━━━ RUST SMOKE PARITY STATE BUCKETS ━━━━━━━━━━━━━━━━━━━━━━━━");
  const buckets = new Map();
  for (const [workflow, state] of workflowStates.entries()) {
    const bucket = buckets.get(state.status) ?? [];
    bucket.push(workflow);
    buckets.set(state.status, bucket);
  }
  for (const status of ["not_started", "running", "passed", "failed", "timed_out", "skipped"]) {
    const workflows = buckets.get(status) ?? [];
    console.log(
      `${status.padEnd(12)} ${String(workflows.length).padStart(2)} ${workflows.join(", ")}`,
    );
  }
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (terminating) {
        process.exit(signal === "SIGINT" ? 130 : 143);
      }
      terminating = true;
      appendLedger({ status: "interrupted", signal });
      console.error(`received ${signal}; cleaning nested smoke containers before exit`);
      printStateBuckets();
      printActiveContainers(process.stderr);
      cleanupLocalCiContainers(`process ${signal}`);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

installSignalHandlers();

const build = run("cargo", ["build", "-p", "local-ci"], { stdio: "inherit" });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const workflows = selectedSmokeWorkflows();
if (process.env.RUST_SMOKE_ONLY || process.env.RUST_SMOKE_EXCLUDE) {
  console.log(
    `Rust smoke workflow filter: only=${process.env.RUST_SMOKE_ONLY ?? "<all>"} exclude=${process.env.RUST_SMOKE_EXCLUDE ?? "<none>"}`,
  );
}
for (const workflow of workflows) {
  setWorkflowState(workflow.path, "not_started");
}
setWorkflowState("--all smoke", "not_started");

const includePrivateRemote = hasPrivateRemoteAccess();
for (const workflow of workflows) {
  if (workflow.path.endsWith("smoke-remote-private-workflow.yml") && !includePrivateRemote) {
    console.log(`↷ ${workflow.path} skipped: private fixture is not accessible to this token`);
    setWorkflowState(workflow.path, "skipped", { reason: "private fixture inaccessible" });
    results.push({
      workflow: workflow.path,
      status: "skipped",
      reason: "private fixture inaccessible",
    });
    continue;
  }
  if (workflow.path.endsWith("smoke-bun-setup.yml") && process.env.GITHUB_ACTIONS === "true") {
    console.log(
      `↷ ${workflow.path} skipped on GitHub: the nested bun launcher stalls under Rust parity; the standalone smoke-bun-setup check covers it directly`,
    );
    setWorkflowState(workflow.path, "skipped", { reason: "standalone GitHub smoke covers it" });
    results.push({
      workflow: workflow.path,
      status: "skipped",
      reason: "standalone GitHub smoke covers it",
    });
    continue;
  }

  let passed = false;
  let finalResult;
  for (let attempt = 1; attempt <= smokeWorkflowAttempts; attempt += 1) {
    const workflowWorkDir = path.join(
      smokeWorkDir,
      `${workflow.path.replaceAll(/[^a-zA-Z0-9]+/g, "-")}-${attempt}`,
    );
    console.log(
      `::group::Rust smoke parity: ${workflow.path} attempt ${attempt}/${smokeWorkflowAttempts}`,
    );
    console.log(`▶ start ${workflow.path} attempt=${attempt} timeoutMs=${smokeWorkflowTimeoutMs}`);
    setWorkflowState(workflow.path, "running", { attempt });
    const result = await runStreaming(
      rustBin,
      ["run", "--workflow", workflow.path, "--quiet", "--jobs", "2"],
      {
        env: smokeEnvironment(workflowWorkDir),
        timeout: smokeWorkflowTimeoutMs,
        label: workflow.path,
        workflow: workflow.path,
        attempt,
      },
    );
    console.log(
      `▶ finish ${workflow.path} attempt=${attempt} result=${resultLabel(result)} duration=${formatDuration(result.durationMs)}`,
    );
    console.log("::endgroup::");
    finalResult = result;
    if (result.status === 0) {
      passed = true;
      setWorkflowState(workflow.path, "passed", { attempt, durationMs: result.durationMs });
      results.push({
        workflow: workflow.path,
        status: "passed",
        attempts: attempt,
        durationMs: result.durationMs,
      });
      removeSuccessfulWorkDir(workflowWorkDir);
      console.log(`✓ ${workflow.path} executed successfully`);
      break;
    }
    setWorkflowState(workflow.path, result.timedOut ? "timed_out" : "failed", {
      attempt,
      durationMs: result.durationMs,
      result: resultLabel(result),
    });
    printFailureDiagnostics(workflow.path, attempt, result);
    cleanupLocalCiContainers(`${workflow.path} attempt ${attempt} ${resultLabel(result)}`);
    if (attempt < smokeWorkflowAttempts) {
      console.log(`↻ ${workflow.path} retrying after failed attempt ${attempt}`);
    }
  }
  if (!passed) {
    results.push({
      workflow: workflow.path,
      status: "failed",
      attempts: smokeWorkflowAttempts,
      durationMs: finalResult?.durationMs ?? 0,
      result: finalResult ? resultLabel(finalResult) : "unknown",
    });
  }
}

if (skipAllSmoke) {
  console.log("↷ --all smoke skipped because RUST_SMOKE_SKIP_ALL=1");
  setWorkflowState("--all smoke", "skipped", { reason: "RUST_SMOKE_SKIP_ALL=1" });
  results.push({ workflow: "--all smoke", status: "skipped", reason: "RUST_SMOKE_SKIP_ALL=1" });
} else {
  const allRepo = path.join(smokeWorkDir, "all-mode-repo");
  fs.mkdirSync(path.join(allRepo, ".github/workflows"), { recursive: true });
  run("git", ["init"], { cwd: allRepo });
  fs.writeFileSync(path.join(allRepo, "README.md"), "all smoke\n");
  fs.writeFileSync(
    path.join(allRepo, ".github/workflows/one.yml"),
    "on: workflow_dispatch\njobs:\n  one:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo one\n",
  );
  fs.writeFileSync(
    path.join(allRepo, ".github/workflows/two.yml"),
    "on: workflow_dispatch\njobs:\n  two:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo two\n",
  );
  run("git", ["add", "."], { cwd: allRepo });
  run(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"],
    {
      cwd: allRepo,
    },
  );
  const allStart = Date.now();
  setWorkflowState("--all smoke", "running", { attempt: 1 });
  const allResult = await runStreaming(rustBin, ["run", "--all", "--quiet", "--jobs", "2"], {
    cwd: allRepo,
    env: smokeEnvironment(path.join(smokeWorkDir, "all-mode-work")),
    timeout: smokeWorkflowTimeoutMs,
    label: "--all smoke",
    workflow: "--all smoke",
    attempt: 1,
  });
  if (allResult.status === 0) {
    setWorkflowState("--all smoke", "passed", { attempt: 1, durationMs: Date.now() - allStart });
    results.push({
      workflow: "--all smoke",
      status: "passed",
      attempts: 1,
      durationMs: Date.now() - allStart,
    });
    removeSuccessfulWorkDir(path.join(smokeWorkDir, "all-mode-work"));
    console.log("✓ --all smoke executed successfully");
  } else {
    setWorkflowState("--all smoke", allResult.timedOut ? "timed_out" : "failed", {
      attempt: 1,
      durationMs: Date.now() - allStart,
      result: resultLabel(allResult),
    });
    results.push({
      workflow: "--all smoke",
      status: "failed",
      attempts: 1,
      durationMs: Date.now() - allStart,
      result: resultLabel(allResult),
    });
    printFailureDiagnostics("--all smoke", 1, allResult);
    cleanupLocalCiContainers(`--all smoke ${resultLabel(allResult)}`);
  }
}

console.log("\n━━━ RUST SMOKE PARITY ATTEMPT SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━");
for (const result of results) {
  console.log(
    `${result.status.padEnd(7)} ${String(result.attempts ?? "-").padStart(2)} attempt(s) ${formatDuration(result.durationMs ?? 0).padStart(7)} ${result.workflow}${result.reason ? ` (${result.reason})` : ""}${result.result ? ` => ${result.result}` : ""}`,
  );
}
printStateBuckets();
console.log(`Rust smoke status ledger: ${ledgerPath}`);

const failures = results.filter((result) => result.status === "failed");
if (failures.length > 0) {
  throw new Error(
    `Rust smoke parity failed for ${failures.map((result) => result.workflow).join(", ")}`,
  );
}
