#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkflows = [
  ".github/workflows/smoke-binary.yml",
  ".github/workflows/smoke-expressions.yml",
  ".github/workflows/smoke-matrix.yml",
  ".github/workflows/smoke-artifacts.yml",
  ".github/workflows/smoke-docker-buildx.yml",
  ".github/workflows/smoke-pause-pipe.yml",
];

function parseArgs(argv) {
  const parsed = {
    iterations: 1,
    workflows: [],
    jobs: 2,
    noBuild: false,
    output: undefined,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--iterations" || arg === "-n") {
      parsed.iterations = parsePositiveInt(argv[++i], arg);
    } else if (arg.startsWith("--iterations=")) {
      parsed.iterations = parsePositiveInt(arg.slice("--iterations=".length), "--iterations");
    } else if (arg === "--workflow" || arg === "-w") {
      parsed.workflows.push(requireValue(argv[++i], arg));
    } else if (arg.startsWith("--workflow=")) {
      parsed.workflows.push(requireValue(arg.slice("--workflow=".length), "--workflow"));
    } else if (arg === "--jobs" || arg === "-j") {
      parsed.jobs = parsePositiveInt(argv[++i], arg);
    } else if (arg.startsWith("--jobs=")) {
      parsed.jobs = parsePositiveInt(arg.slice("--jobs=".length), "--jobs");
    } else if (arg === "--no-build") {
      parsed.noBuild = true;
    } else if (arg === "--output" || arg === "-o") {
      parsed.output = requireValue(argv[++i], arg);
    } else if (arg.startsWith("--output=")) {
      parsed.output = requireValue(arg.slice("--output=".length), "--output");
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (parsed.workflows.length === 0) {
    parsed.workflows = defaultWorkflows;
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: pnpm smoke:bench [options]

Benchmarks the same smoke workflows through the TypeScript and native Rust orchestrators.
Metrics are collected with /usr/bin/time and cover the host orchestrator process tree;
Docker daemon/container CPU and memory are not included.

Options:
  -n, --iterations <N>       Runs per implementation/workflow (default: 1)
  -w, --workflow <path>      Workflow to benchmark; repeat to select multiple
  -j, --jobs <N>             local-ci --jobs value for both implementations (default: 2)
      --no-build             Skip building TS dist and Rust release binary
  -o, --output <path>        Write markdown report to a file
      --json                 Emit JSON instead of markdown
  -h, --help                 Show this help
`);
}

function parsePositiveInt(raw, flag) {
  const value = Number.parseInt(requireValue(raw, flag), 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function requireValue(value, flag) {
  if (!value) {
    throw new Error(`${flag} expects a value`);
  }
  return value;
}

function runRequired(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function timeCommand(command, args, env) {
  const metricsFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-bench-time-")),
    "time.txt",
  );
  const platform = process.platform;
  const timeArgs = platform === "darwin" ? ["-l", "-o", metricsFile] : ["-v", "-o", metricsFile];
  const startedAt = Date.now();
  const result = spawnSync("/usr/bin/time", [...timeArgs, command, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const fallbackWallMs = Date.now() - startedAt;
  const rawMetrics = fs.readFileSync(metricsFile, "utf8");
  const metrics = parseTimeMetrics(rawMetrics, platform, fallbackWallMs);
  return {
    status: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    rawMetrics,
    ...metrics,
  };
}

function parseTimeMetrics(raw, platform, fallbackWallMs) {
  if (platform === "darwin") {
    const header = raw.match(/([\d.,]+)\s+real\s+([\d.,]+)\s+user\s+([\d.,]+)\s+sys/);
    const maxRss = raw.match(/(\d+)\s+maximum resident set size/);
    const peakFootprint = raw.match(/(\d+)\s+peak memory footprint/);
    const maxRssBytes = Number(maxRss?.[1] ?? peakFootprint?.[1] ?? 0);
    return {
      wallMs: header ? secondsToMs(header[1]) : fallbackWallMs,
      userMs: header ? secondsToMs(header[2]) : 0,
      sysMs: header ? secondsToMs(header[3]) : 0,
      maxRssBytes,
    };
  }

  const user = raw.match(/User time \(seconds\):\s+([\d.]+)/);
  const sys = raw.match(/System time \(seconds\):\s+([\d.]+)/);
  const elapsed = raw.match(/Elapsed \(wall clock\) time.*:\s+(.+)/);
  const maxRss = raw.match(/Maximum resident set size \(kbytes\):\s+(\d+)/);
  return {
    wallMs: elapsed ? elapsedToMs(elapsed[1]) : fallbackWallMs,
    userMs: user ? secondsToMs(user[1]) : 0,
    sysMs: sys ? secondsToMs(sys[1]) : 0,
    maxRssBytes: Number(maxRss?.[1] ?? 0) * 1024,
  };
}

function secondsToMs(raw) {
  return Number(raw.replace(",", ".")) * 1000;
}

function elapsedToMs(raw) {
  const parts = raw.trim().split(":");
  if (parts.length === 3) {
    return ((Number(parts[0]) * 60 + Number(parts[1])) * 60 + Number(parts[2])) * 1000;
  }
  if (parts.length === 2) {
    return (Number(parts[0]) * 60 + Number(parts[1])) * 1000;
  }
  return Number(raw) * 1000;
}

function workflowWorkDir(rootDir, implementation, workflow, iteration) {
  const safeWorkflow = workflow.replaceAll(/[^a-zA-Z0-9]+/g, "-");
  return path.join(rootDir, `${implementation}-${iteration}-${safeWorkflow}`);
}

function runBenchmark({ implementation, command, args, workflow, iteration, jobs, rootWorkDir }) {
  const workDir = workflowWorkDir(rootWorkDir, implementation, workflow, iteration);
  fs.mkdirSync(workDir, { recursive: true });
  const env = {
    ...process.env,
    LOCAL_CI_WORKING_DIR: workDir,
  };
  const result = timeCommand(
    command,
    [...args, "run", "--workflow", workflow, "--quiet", "--jobs", String(jobs)],
    env,
  );
  return {
    implementation,
    workflow,
    iteration,
    status: result.status,
    signal: result.signal,
    wallMs: result.wallMs,
    userMs: result.userMs,
    sysMs: result.sysMs,
    maxRssBytes: result.maxRssBytes,
    cpuPercent: result.wallMs > 0 ? ((result.userMs + result.sysMs) / result.wallMs) * 100 : 0,
    stdoutTail: tailLines(result.stdout, 40),
    stderrTail: tailLines(result.stderr, 40),
  };
}

function tailLines(value, count) {
  const lines = value.trimEnd().split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function summarize(results) {
  const groups = new Map();
  for (const result of results) {
    const key = `${result.implementation}\0${result.workflow}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(result);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    return {
      implementation: first.implementation,
      workflow: first.workflow,
      runs: group.length,
      failures: group.filter((result) => result.status !== 0).length,
      avgWallMs: average(group.map((result) => result.wallMs)),
      avgUserMs: average(group.map((result) => result.userMs)),
      avgSysMs: average(group.map((result) => result.sysMs)),
      maxRssBytes: Math.max(...group.map((result) => result.maxRssBytes)),
      avgCpuPercent: average(group.map((result) => result.cpuPercent)),
    };
  });
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderMarkdown(results) {
  const rows = summarize(results);
  const lines = [
    "# Local CI smoke benchmark",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "> Metrics are collected with `/usr/bin/time` around the host orchestrator process tree. Docker daemon and container CPU/memory are not included, so this compares Local CI orchestration overhead rather than total machine load.",
    "",
    "| Impl | Workflow | Runs | Failures | Wall avg | CPU avg | User avg | Sys avg | Max RSS |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.implementation} | ${row.workflow} | ${row.runs} | ${row.failures} | ${formatMs(row.avgWallMs)} | ${row.avgCpuPercent.toFixed(0)}% | ${formatMs(row.avgUserMs)} | ${formatMs(row.avgSysMs)} | ${formatBytes(row.maxRssBytes)} |`,
    );
  }
  lines.push("");
  const failures = results.filter((result) => result.status !== 0);
  if (failures.length > 0) {
    lines.push("## Failures", "");
    for (const failure of failures) {
      lines.push(
        `### ${failure.implementation} ${failure.workflow} iteration ${failure.iteration}`,
        "",
        `Status: ${failure.status}${failure.signal ? ` (${failure.signal})` : ""}`,
        "",
        "```text",
        failure.stderrTail || failure.stdoutTail || "<no output>",
        "```",
        "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatMs(value) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}s`;
  }
  return `${value.toFixed(1)}ms`;
}

function formatBytes(value) {
  if (!value) {
    return "0 B";
  }
  const units = ["B", "KiB", "MiB", "GiB"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit++;
  }
  return `${current.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const options = parseArgs(process.argv.slice(2));
if (!fs.existsSync("/usr/bin/time")) {
  throw new Error("/usr/bin/time is required for smoke benchmarks");
}

if (!options.noBuild) {
  runRequired("pnpm", ["--filter", "run-local-ci...", "-r", "build"]);
  runRequired("cargo", ["build", "-p", "local-ci", "--release"]);
}

const rootWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-smoke-bench-"));
const implementations = [
  {
    implementation: "typescript",
    command: process.execPath,
    args: [path.join(root, "packages/cli/dist/cli.js")],
  },
  {
    implementation: "rust",
    command: path.join(root, "target/release/local-ci"),
    args: [],
  },
];

const results = [];
for (let iteration = 1; iteration <= options.iterations; iteration++) {
  for (const workflow of options.workflows) {
    for (const implementation of implementations) {
      console.error(
        `▶ ${implementation.implementation} ${workflow} (${iteration}/${options.iterations})`,
      );
      const result = runBenchmark({
        ...implementation,
        workflow,
        iteration,
        jobs: options.jobs,
        rootWorkDir,
      });
      results.push(result);
      console.error(
        `  status=${result.status} wall=${formatMs(result.wallMs)} rss=${formatBytes(result.maxRssBytes)}`,
      );
    }
  }
}

const output = options.json
  ? `${JSON.stringify({ results, summary: summarize(results) }, null, 2)}\n`
  : renderMarkdown(results);
if (options.output) {
  fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
  fs.writeFileSync(options.output, output);
} else {
  process.stdout.write(output);
}

if (results.some((result) => result.status !== 0)) {
  process.exit(1);
}
