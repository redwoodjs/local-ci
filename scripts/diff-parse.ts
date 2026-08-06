#!/usr/bin/env -S node --experimental-strip-types
// Differential parse check.
//
// For each workflow file, walk its raw YAML at three scopes — workflow,
// job, step — and confirm every recognized key is either preserved by
// our parser or listed as a documented expected drop. A "drift" is a
// raw-YAML key that our code silently ignores without policy. That's
// the class of bug the `defaults.run.working-directory` gap (#290)
// belonged to before it had a smoke.
//
// Sources scanned:
//   - .github/workflows/*.yml          — our own workflows
//   - third-party-workflows/*.yml      — vendored public workflows
//
// Run with `pnpm parse:diff`. Exits 1 if any drift is found.

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  parseWorkflowSteps,
  parseJobIf,
  parseJobOutputDefs,
  parseJobRunsOn,
  parseFailFast,
  parseMatrixDef,
  parseWorkflowContainer,
  parseWorkflowServices,
  getWorkflowTemplate,
} from "../packages/cli/src/workflow/workflow-parser.ts";
import { parseJobDependencies } from "../packages/cli/src/workflow/job-scheduler.ts";

// ─── Shared types ──────────────────────────────────────────────────────────────

type ParsedStep = {
  Name?: string;
  ContextName?: string;
  Reference?: { Type?: string; Name?: string; Path?: string; Ref?: string };
  Inputs?: Record<string, string>;
  Env?: Record<string, string>;
};

type Scope = "workflow" | "job" | "step";

type Drift = {
  file: string;
  scope: Scope;
  location: string; // "" for workflow, "job:<id>" for job, "job:<id> step:<idx>" for step
  key: string;
  rawValue: string;
};

function summarize(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  }
  return JSON.stringify(value).slice(0, 40);
}

function isPresent(v: unknown): boolean {
  if (v === undefined || v === null || v === "") {
    return false;
  }
  if (Array.isArray(v) && v.length === 0) {
    return false;
  }
  if (typeof v === "object" && Object.keys(v as object).length === 0) {
    return false;
  }
  return true;
}

// ─── Step-level scan ───────────────────────────────────────────────────────────

const STEP_KEYS = [
  "id",
  "name",
  "run",
  "uses",
  "with",
  "env",
  "if",
  "working-directory",
  "shell",
  "continue-on-error",
  "timeout-minutes",
] as const;

type StepKey = (typeof STEP_KEYS)[number];

const STEP_EXPECTED_DROP: Record<string, string> = {
  "continue-on-error": "unsupported — see compatibility.json",
  "timeout-minutes": "unsupported — see compatibility.json",
  shell: "partial / runner ignores inputs.shell — tracked by #293",
};

const STEP_PRESERVED: Record<StepKey, (parsed: ParsedStep) => boolean> = {
  id: (p) => p.ContextName !== undefined && p.ContextName !== null,
  name: (p) => typeof p.Name === "string" && p.Name.length > 0,
  run: (p) => typeof p.Inputs?.script === "string" && p.Inputs.script.length > 0,
  uses: (p) =>
    p.Reference?.Type === "Repository" && (Boolean(p.Reference.Name) || Boolean(p.Reference.Path)),
  with: (p) => {
    if (!p.Inputs) {
      return false;
    }
    const keys = Object.keys(p.Inputs).filter(
      (k) => k !== "script" && k !== "workingDirectory" && k !== "shell",
    );
    return keys.length > 0;
  },
  env: (p) => typeof p.Env === "object" && p.Env !== null && Object.keys(p.Env).length > 0,
  if: () => true, // runner-evaluated at runtime — see compatibility.json
  "working-directory": (p) => typeof p.Inputs?.workingDirectory === "string",
  shell: (p) => typeof p.Inputs?.shell === "string",
  "continue-on-error": () => false,
  "timeout-minutes": () => false,
};

function shortStepLabel(rawStep: Record<string, unknown>): string {
  if (typeof rawStep.name === "string") {
    return rawStep.name;
  }
  if (typeof rawStep.uses === "string") {
    return `uses: ${rawStep.uses}`;
  }
  if (typeof rawStep.run === "string") {
    const first = rawStep.run.split("\n")[0].trim();
    return `run: ${first.slice(0, 40)}${first.length > 40 ? "…" : ""}`;
  }
  return "?";
}

async function diffSteps(
  filePath: string,
  jobId: string,
  rawJob: Record<string, unknown>,
): Promise<Drift[]> {
  const rawSteps = rawJob.steps as Record<string, unknown>[] | undefined;
  if (!Array.isArray(rawSteps)) {
    return [];
  }

  let parsedSteps: ParsedStep[];
  try {
    parsedSteps = (await parseWorkflowSteps(filePath, jobId)) as ParsedStep[];
  } catch (err) {
    if (rawJob.uses) {
      return [];
    }
    console.error(`  skip ${jobId} steps: ${(err as Error).message}`);
    return [];
  }

  const drifts: Drift[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const rawStep = rawSteps[i];
    const parsedStep = parsedSteps[i];
    if (!parsedStep) {
      continue;
    }
    for (const key of STEP_KEYS) {
      const value = rawStep[key];
      if (!isPresent(value)) {
        continue;
      }
      if (STEP_PRESERVED[key](parsedStep)) {
        continue;
      }
      if (key in STEP_EXPECTED_DROP) {
        continue;
      }
      drifts.push({
        file: filePath,
        scope: "step",
        location: `job:${jobId} step:${i} (${shortStepLabel(rawStep)})`,
        key,
        rawValue: summarize(value),
      });
    }
  }
  return drifts;
}

// ─── Job-level scan ────────────────────────────────────────────────────────────

const JOB_EXPECTED_DROP: Record<string, string> = {
  name: "display only — surfaced in state renderer",
  permissions: "ignored — mock GITHUB_TOKEN has full access",
  environment: "ignored — environment protection rules are GitHub-side",
  concurrency: "not-planned — see compatibility.json",
  "timeout-minutes": "unsupported — see compatibility.json",
  "continue-on-error": "unsupported — see compatibility.json",
  "strategy.matrix.include": "unsupported — see compatibility.json",
  "strategy.matrix.exclude": "unsupported — see compatibility.json",
  "strategy.max-parallel": "unsupported — see compatibility.json",
  uses: "consumed by reusable-workflow expander (expandReusableJobs)",
  with: "consumed by reusable-workflow expander (caller inputs)",
  secrets: "consumed by reusable-workflow expander (caller secrets)",
};

async function jobLevelEnvFlowsToSteps(
  filePath: string,
  jobId: string,
  jobEnvKeys: string[],
): Promise<boolean> {
  try {
    const parsedSteps = (await parseWorkflowSteps(filePath, jobId)) as ParsedStep[];
    if (parsedSteps.length === 0) {
      return false;
    }
    // Find a step whose Env is populated and contains at least one job-level key.
    return parsedSteps.some((s) => s.Env && jobEnvKeys.every((k) => Object.hasOwn(s.Env!, k)));
  } catch {
    return false;
  }
}

// Marker emitted by wrapScriptForShell in workflow-parser.ts when wrapping a
// non-bash shell into a heredoc. Presence of this marker in the parsed script
// is how we detect that the shell directive was honored.
const SHELL_WRAP_MARKER = "__LOCAL_CI_SHELL_WRAP_EOF__";

function shellPreserved(script: string, expected: string): boolean {
  if (expected === "bash") {
    // bash is the runner's natural shell — the parser intentionally leaves
    // the script unwrapped. Treat unwrapped scripts as preserved-by-default.
    return !script.includes(SHELL_WRAP_MARKER);
  }
  return script.includes(SHELL_WRAP_MARKER);
}

async function defaultRunFlowsToSteps(
  filePath: string,
  jobId: string,
  field: "workingDirectory" | "shell",
  expected: string,
  rawSteps: Record<string, unknown>[],
): Promise<boolean> {
  try {
    const parsedSteps = (await parseWorkflowSteps(filePath, jobId)) as ParsedStep[];
    for (let i = 0; i < parsedSteps.length; i++) {
      const rawStep = rawSteps[i] ?? {};
      const overrideKey = field === "workingDirectory" ? "working-directory" : "shell";
      if ((rawStep as Record<string, unknown>)[overrideKey]) {
        continue;
      }
      if (field === "shell") {
        const script = parsedSteps[i]?.Inputs?.script ?? "";
        if (shellPreserved(script, expected)) {
          return true;
        }
      } else {
        const got = parsedSteps[i]?.Inputs?.[field];
        if (got === expected) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function diffJob(
  filePath: string,
  jobId: string,
  rawJob: Record<string, unknown>,
): Promise<Drift[]> {
  const drifts: Drift[] = [];
  const here = (key: string, value: unknown) =>
    drifts.push({
      file: filePath,
      scope: "job",
      location: `job:${jobId}`,
      key,
      rawValue: summarize(value),
    });

  // Walk every top-level job key. Keys not in our recognized list are
  // silently ignored (we only grade what we know about).
  for (const [key, value] of Object.entries(rawJob)) {
    if (!isPresent(value)) {
      continue;
    }
    if (key === "steps") {
      continue; // handled by diffSteps
    }
    if (key in JOB_EXPECTED_DROP) {
      continue;
    }

    switch (key) {
      case "if": {
        if (parseJobIf(filePath, jobId) === null) {
          here(key, value);
        }
        break;
      }
      case "runs-on": {
        if (parseJobRunsOn(filePath, jobId).length === 0) {
          here(key, value);
        }
        break;
      }
      case "needs": {
        const deps = parseJobDependencies(filePath).get(jobId) ?? [];
        if (deps.length === 0) {
          here(key, value);
        }
        break;
      }
      case "outputs": {
        const declared = Object.keys(value as object);
        const parsed = Object.keys(parseJobOutputDefs(filePath, jobId));
        if (!declared.every((k) => parsed.includes(k))) {
          here(key, value);
        }
        break;
      }
      case "container": {
        const parsed = await parseWorkflowContainer(filePath, jobId);
        if (!parsed || !parsed.image) {
          here(key, value);
        }
        break;
      }
      case "services": {
        const parsed = await parseWorkflowServices(filePath, jobId);
        const declared = Object.keys(value as object);
        if (!declared.every((name) => parsed.some((p) => p.name === name))) {
          here(key, value);
        }
        break;
      }
      case "env": {
        const declared = Object.keys(value as object);
        const ok = await jobLevelEnvFlowsToSteps(filePath, jobId, declared);
        if (!ok) {
          here(key, value);
        }
        break;
      }
      case "defaults": {
        const run = (value as { run?: Record<string, unknown> }).run;
        if (!run) {
          break;
        }
        const rawSteps = (rawJob.steps as Record<string, unknown>[]) ?? [];
        for (const [field, raw] of Object.entries(run)) {
          if (!isPresent(raw)) {
            continue;
          }
          const internalField = field === "working-directory" ? "workingDirectory" : "shell";
          if (field !== "working-directory" && field !== "shell") {
            here(`defaults.run.${field}`, raw);
            continue;
          }
          const ok = await defaultRunFlowsToSteps(
            filePath,
            jobId,
            internalField,
            String(raw),
            rawSteps,
          );
          if (!ok) {
            here(`defaults.run.${field}`, raw);
          }
        }
        break;
      }
      case "strategy": {
        const strategy = value as Record<string, unknown>;
        if (isPresent(strategy.matrix)) {
          const matrix = strategy.matrix as Record<string, unknown>;
          const arrayKeys = Object.entries(matrix)
            .filter(([k, v]) => k !== "include" && k !== "exclude" && Array.isArray(v))
            .map(([k]) => k);
          if (arrayKeys.length > 0) {
            const parsed = await parseMatrixDef(filePath, jobId);
            if (!parsed || !arrayKeys.every((k) => k in parsed)) {
              here("strategy.matrix", strategy.matrix);
            }
          }
        }
        if ("fail-fast" in strategy) {
          const raw = strategy["fail-fast"];
          const parsed = parseFailFast(filePath, jobId);
          if (parsed !== raw) {
            here("strategy.fail-fast", raw);
          }
        }
        // include / exclude / max-parallel are expected drops; skip.
        break;
      }
      default: {
        // Unknown key — record as drift so we notice new GHA features
        // (or our own typos).
        here(key, value);
      }
    }
  }

  // Recursively diff steps for this job.
  drifts.push(...(await diffSteps(filePath, jobId, rawJob)));
  return drifts;
}

// ─── Workflow-level scan ───────────────────────────────────────────────────────

const WORKFLOW_EXPECTED_DROP: Record<string, string> = {
  name: "display only — surfaced in state renderer",
  "run-name": "ignored — see compatibility.json",
  permissions: "ignored — mock GITHUB_TOKEN has full access",
  concurrency: "not-planned — see compatibility.json",
};

async function workflowEnvFlowsToSteps(
  filePath: string,
  rawYaml: Record<string, unknown>,
  envKeys: string[],
): Promise<boolean> {
  const jobs = (rawYaml.jobs ?? {}) as Record<string, Record<string, unknown>>;
  for (const jobId of Object.keys(jobs)) {
    const job = jobs[jobId];
    if (job.uses) {
      continue;
    }
    try {
      const steps = (await parseWorkflowSteps(filePath, jobId)) as ParsedStep[];
      for (const step of steps) {
        if (step.Env && envKeys.every((k) => Object.hasOwn(step.Env!, k))) {
          return true;
        }
      }
    } catch {
      // Skip jobs whose steps can't be parsed.
    }
  }
  return false;
}

async function workflowDefaultRunFlowsToSteps(
  filePath: string,
  rawYaml: Record<string, unknown>,
  field: "workingDirectory" | "shell",
  expected: string,
): Promise<boolean> {
  const jobs = (rawYaml.jobs ?? {}) as Record<string, Record<string, unknown>>;
  const overrideKey = field === "workingDirectory" ? "working-directory" : "shell";
  for (const jobId of Object.keys(jobs)) {
    const job = jobs[jobId];
    if (job.uses) {
      continue;
    }
    // Skip jobs whose own defaults.run.<field> override.
    const jobDefault = (job.defaults as { run?: Record<string, unknown> } | undefined)?.run?.[
      overrideKey
    ];
    if (jobDefault) {
      continue;
    }
    const rawSteps = (job.steps as Record<string, unknown>[]) ?? [];
    try {
      const parsedSteps = (await parseWorkflowSteps(filePath, jobId)) as ParsedStep[];
      for (let i = 0; i < parsedSteps.length; i++) {
        const rawStep = rawSteps[i] ?? {};
        if ((rawStep as Record<string, unknown>)[overrideKey]) {
          continue;
        }
        if (field === "shell") {
          const script = parsedSteps[i]?.Inputs?.script ?? "";
          if (shellPreserved(script, expected)) {
            return true;
          }
        } else {
          const got = parsedSteps[i]?.Inputs?.[field];
          if (got === expected) {
            return true;
          }
        }
      }
    } catch {
      // skip
    }
  }
  return false;
}

async function diffWorkflowLevel(
  filePath: string,
  rawYaml: Record<string, unknown>,
): Promise<Drift[]> {
  const drifts: Drift[] = [];
  const here = (key: string, value: unknown) =>
    drifts.push({
      file: filePath,
      scope: "workflow",
      location: "",
      key,
      rawValue: summarize(value),
    });

  for (const [key, value] of Object.entries(rawYaml)) {
    if (!isPresent(value)) {
      continue;
    }
    if (key === "jobs") {
      continue;
    }
    if (key in WORKFLOW_EXPECTED_DROP) {
      continue;
    }

    switch (key) {
      case "on": {
        const tpl = await getWorkflowTemplate(filePath);
        if (!tpl?.events || Object.keys(tpl.events).length === 0) {
          here(key, value);
        }
        break;
      }
      case "env": {
        const declared = Object.keys(value as object);
        const ok = await workflowEnvFlowsToSteps(filePath, rawYaml, declared);
        if (!ok) {
          here(key, value);
        }
        break;
      }
      case "defaults": {
        const run = (value as { run?: Record<string, unknown> }).run;
        if (!run) {
          break;
        }
        for (const [field, raw] of Object.entries(run)) {
          if (!isPresent(raw)) {
            continue;
          }
          if (field !== "working-directory" && field !== "shell") {
            here(`defaults.run.${field}`, raw);
            continue;
          }
          const internalField = field === "working-directory" ? "workingDirectory" : "shell";
          const ok = await workflowDefaultRunFlowsToSteps(
            filePath,
            rawYaml,
            internalField,
            String(raw),
          );
          if (!ok) {
            here(`defaults.run.${field}`, raw);
          }
        }
        break;
      }
      default: {
        here(key, value);
      }
    }
  }

  return drifts;
}

// ─── Driver ────────────────────────────────────────────────────────────────────

async function diffWorkflow(filePath: string): Promise<Drift[]> {
  const text = await fs.readFile(filePath, "utf8");
  const raw = YAML.parse(text);
  if (!raw || typeof raw !== "object") {
    return [];
  }

  const drifts: Drift[] = [];
  drifts.push(...(await diffWorkflowLevel(filePath, raw)));

  const jobs = raw.jobs ?? {};
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    drifts.push(...(await diffJob(filePath, jobId, rawJob as Record<string, unknown>)));
  }

  return drifts;
}

async function collectWorkflowFiles(repoRoot: string): Promise<string[]> {
  const dirs = [
    path.join(repoRoot, ".github/workflows"),
    path.join(repoRoot, "third-party-workflows"),
  ];
  const files: string[] = [];
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.endsWith(".yml") || f.endsWith(".yaml")) {
        files.push(path.join(dir, f));
      }
    }
  }
  return files.sort();
}

async function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const files = await collectWorkflowFiles(repoRoot);

  const allDrifts: Drift[] = [];
  for (const file of files) {
    const relFile = path.relative(repoRoot, file);
    console.error(`… ${relFile}`);
    try {
      const drifts = await diffWorkflow(file);
      allDrifts.push(...drifts);
    } catch (err) {
      console.error(`  error: ${(err as Error).message}`);
    }
  }

  const reportLines = [
    "# Differential parse report",
    "",
    `Scanned ${files.length} workflows. ${allDrifts.length} drift(s) found.`,
    "",
    "A drift is a workflow/job/step-level YAML key our parser silently",
    "dropped without a documented expected-drop policy.",
    "",
    "## Expected drops",
    "",
    "**Workflow scope:**",
  ];
  for (const [k, reason] of Object.entries(WORKFLOW_EXPECTED_DROP)) {
    reportLines.push(`- \`${k}\` — ${reason}`);
  }
  reportLines.push("", "**Job scope:**");
  for (const [k, reason] of Object.entries(JOB_EXPECTED_DROP)) {
    reportLines.push(`- \`${k}\` — ${reason}`);
  }
  reportLines.push("", "**Step scope:**");
  for (const [k, reason] of Object.entries(STEP_EXPECTED_DROP)) {
    reportLines.push(`- \`${k}\` — ${reason}`);
  }
  reportLines.push("", "## Drifts", "");

  if (allDrifts.length === 0) {
    reportLines.push("_None._");
  } else {
    const byFile = new Map<string, Drift[]>();
    for (const d of allDrifts) {
      const rel = path.relative(repoRoot, d.file);
      const list = byFile.get(rel) ?? [];
      list.push(d);
      byFile.set(rel, list);
    }
    for (const [rel, list] of byFile) {
      reportLines.push(`### ${rel}`);
      reportLines.push("");
      for (const d of list) {
        const where = d.location ? ` ${d.location}` : "";
        reportLines.push(
          `- [${d.scope}]${where} — key \`${d.key}\` = \`${d.rawValue}\` not carried into parser output`,
        );
      }
      reportLines.push("");
    }
  }

  console.log(reportLines.join("\n"));
  process.exit(allDrifts.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
