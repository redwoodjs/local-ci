import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import { classifyRunsOn } from "../runner/runs-on-compat.ts";

const execFileP = promisify(execFile);

/**
 * Values used to resolve `${{ runner.os }}` / `${{ runner.arch }}` at
 * expression-expansion time. GitHub Actions evaluates these per-job based on
 * the job's `runs-on:` label. Prior to issue #279 we hardcoded Linux/X64,
 * which broke scripts gated on `runner.os == 'macOS'` in tart-backed VM jobs.
 */
export type RunnerContext = {
  os: string;
  arch: string;
};

/**
 * Derive a `RunnerContext` from a job's `runs-on:` labels. Defaults to
 * Linux/X64 for unknown labels so existing self-hosted configurations keep
 * working. macOS is mapped to ARM64 because local-ci's macOS backend (tart)
 * only runs Apple Silicon VMs.
 */
export function runnerContextFromRunsOn(labels: string[]): RunnerContext {
  switch (classifyRunsOn(labels)) {
    case "macos":
      return { os: "macOS", arch: "ARM64" };
    case "windows":
      return { os: "Windows", arch: "X64" };
    default:
      return { os: "Linux", arch: "X64" };
  }
}

// @actions/workflow-parser imports .json files without `with { type: "json" }`,
// which Node 22+ rejects. Register a custom ESM loader hook that transparently
// adds the missing attribute before we dynamically import the module.
import { register } from "node:module";
import { fileURLToPath } from "node:url";

let hookRegistered = false;

async function loadWorkflowParser() {
  if (!hookRegistered) {
    hookRegistered = true;
    try {
      // Source builds run the .ts file directly under Node's native TS support;
      // published builds run the .js compiled by tsc. Pick whichever exists so
      // the same code works in both contexts.
      const srcUrl = new URL("../hooks/json-loader.ts", import.meta.url);
      const distUrl = new URL("../hooks/json-loader.js", import.meta.url);
      const url = fs.existsSync(fileURLToPath(srcUrl)) ? srcUrl : distUrl;
      register(url);
    } catch {
      // In test environments (Vitest), the hook file may not resolve and
      // Vite already handles JSON imports via its inline config.
    }
  }
  return await import("@actions/workflow-parser");
}

/**
 * Check if a string value is truthy following GitHub Actions semantics.
 * Falsy values: empty string, "false", "0".
 */
function isExprTruthy(val: string): boolean {
  return val !== "" && val !== "false" && val !== "0";
}

/**
 * Split a function's argument list on commas, respecting quotes and nested parens.
 */
function splitFunctionArgs(argsStr: string): string[] {
  const result: string[] = [];
  let current = "";
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
    }
    if (ch === ")") {
      depth--;
    }
    if (ch === "," && depth === 0) {
      result.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

/** Strip surrounding quotes from a string if present. */
function unquote(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Compare two string values using the given operator. */
function compareValues(left: string, right: string, op: string): boolean {
  // GitHub Actions coerces both sides to numbers when possible: empty string,
  // null (surfaced here as ""), and numeric strings all become valid numeric
  // operands. A genuinely non-numeric string coerces to NaN and comparisons
  // involving NaN are all false, so bothNumeric stays false for those.
  const ln = Number(left);
  const rn = Number(right);
  const bothNumeric = !isNaN(ln) && !isNaN(rn);

  switch (op) {
    case "==":
      return bothNumeric ? ln === rn : left.toLowerCase() === right.toLowerCase();
    case "!=":
      return bothNumeric ? ln !== rn : left.toLowerCase() !== right.toLowerCase();
    case "<":
      return bothNumeric ? ln < rn : left.toLowerCase() < right.toLowerCase();
    case ">":
      return bothNumeric ? ln > rn : left.toLowerCase() > right.toLowerCase();
    case "<=":
      return bothNumeric ? ln <= rn : left.toLowerCase() <= right.toLowerCase();
    case ">=":
      return bothNumeric ? ln >= rn : left.toLowerCase() >= right.toLowerCase();
    default:
      return false;
  }
}

/**
 * Bundle for the per-call expansion context. Used by the expression
 * evaluator so each helper takes one argument instead of eight. The
 * public `expandExpressions` keeps its positional signature for callers.
 */
type ExprContext = {
  repoPath?: string;
  secrets?: Record<string, string>;
  matrixContext?: Record<string, string>;
  needsContext?: Record<string, Record<string, string>>;
  inputsContext?: Record<string, string>;
  vars?: Record<string, string>;
  runnerContext?: RunnerContext;
  envContext?: Record<string, string>;
  githubContext?: Record<string, string>;
};

const ZERO_SHA = "0000000000000000000000000000000000000000";

/**
 * Evaluate a function argument that may be a quoted string literal or a
 * full expression. Used by single-arg functions (fromJSON, toJSON).
 */
function evalArgOrLiteral(inner: string, ctx: ExprContext): string {
  const t = inner.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return evaluateExprValue(t, ctx);
}

function evalHashFiles(rawArgs: string, ctx: ExprContext): string {
  if (!ctx.repoPath) {
    return ZERO_SHA;
  }
  try {
    // Parse the argument list: quoted strings separated by commas
    const args = rawArgs.match(/['"][^'"]*['"]/g) ?? [];
    const patterns = args.map((a) => a.replace(/^['"]|['"]$/g, ""));
    const hash = crypto.createHash("sha256");
    let hasAny = false;
    for (const pattern of patterns) {
      let files: string[];
      try {
        files = findFiles(ctx.repoPath, pattern);
      } catch {
        files = [];
      }
      for (const f of files.sort()) {
        try {
          hash.update(fs.readFileSync(f));
          hasAny = true;
        } catch {
          // File not readable, skip
        }
      }
    }
    return hasAny ? hash.digest("hex") : ZERO_SHA;
  } catch {
    return ZERO_SHA;
  }
}

function evalContains(rawArgs: string, ctx: ExprContext): string {
  const args = splitFunctionArgs(rawArgs);
  if (args.length < 2) {
    return "false";
  }
  const haystack = evaluateExprValue(args[0], ctx);
  const needle = evaluateExprValue(args[1], ctx);
  try {
    const arr = JSON.parse(haystack);
    if (Array.isArray(arr)) {
      return arr.some((item) => String(item).toLowerCase() === needle.toLowerCase())
        ? "true"
        : "false";
    }
  } catch {
    // Not JSON — fall through to string search
  }
  return haystack.toLowerCase().includes(needle.toLowerCase()) ? "true" : "false";
}

function evalStartsWith(rawArgs: string, ctx: ExprContext): string {
  const args = splitFunctionArgs(rawArgs);
  if (args.length < 2) {
    return "false";
  }
  const str = evaluateExprValue(args[0], ctx);
  const prefix = evaluateExprValue(args[1], ctx);
  return str.toLowerCase().startsWith(prefix.toLowerCase()) ? "true" : "false";
}

function evalEndsWith(rawArgs: string, ctx: ExprContext): string {
  const args = splitFunctionArgs(rawArgs);
  if (args.length < 2) {
    return "false";
  }
  const str = evaluateExprValue(args[0], ctx);
  const suffix = evaluateExprValue(args[1], ctx);
  return str.toLowerCase().endsWith(suffix.toLowerCase()) ? "true" : "false";
}

function evalJoin(rawArgs: string, ctx: ExprContext): string {
  const args = splitFunctionArgs(rawArgs);
  const val = evaluateExprValue(args[0], ctx);
  const sep = args.length >= 2 ? evaluateExprValue(args[1], ctx) : ", ";
  try {
    const arr = JSON.parse(val);
    if (Array.isArray(arr)) {
      return arr.map(String).join(sep);
    }
  } catch {
    // Not an array — return as-is
  }
  return val;
}

function evalFormat(rawArgs: string, ctx: ExprContext): string {
  const formatArgs = splitFunctionArgs(rawArgs);
  const template = unquote(formatArgs[0] || "");
  const args = formatArgs.slice(1);
  return template.replace(/\{(\d+)\}/g, (_m, idx) => {
    const i = parseInt(idx, 10);
    return i < args.length ? evaluateExprValue(args[i], ctx) : "";
  });
}

function evalFromJson(rawArgs: string, ctx: ExprContext): string {
  const rawValue = evalArgOrLiteral(rawArgs, ctx);
  try {
    const parsed = JSON.parse(rawValue);
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  } catch {
    return "";
  }
}

// toJSON pretty-prints with 2-space indentation, matching GitHub Actions.
// We parse rawValue first so `toJSON(fromJSON(...))` round-trips with
// pretty-printing instead of re-quoting a compact-JSON string.
function evalToJson(rawArgs: string, ctx: ExprContext): string {
  const rawValue = evalArgOrLiteral(rawArgs, ctx);
  try {
    return JSON.stringify(JSON.parse(rawValue), null, 2);
  } catch {
    return JSON.stringify(rawValue, null, 2);
  }
}

const FUNCTION_HANDLERS: Record<string, (rawArgs: string, ctx: ExprContext) => string> = {
  hashFiles: evalHashFiles,
  fromJSON: evalFromJson,
  toJSON: evalToJson,
  format: evalFormat,
  contains: evalContains,
  startsWith: evalStartsWith,
  endsWith: evalEndsWith,
  join: evalJoin,
};

const FUNCTION_CALL_RE = /^([A-Za-z][A-Za-z0-9_]*)\(([\s\S]+)\)$/;

// In expression context, status functions resolve to their string name.
const STATUS_FUNCTIONS: Record<string, string> = {
  "success()": "true",
  "failure()": "false",
  "always()": "true",
  "cancelled()": "false",
};

// Constant `github.*` context refs that don't depend on ctx state.
const CONST_CONTEXT_REFS: Record<string, string> = {
  "github.run_id": "1",
  "github.run_number": "1",
  "github.sha": ZERO_SHA,
  "github.head_sha": ZERO_SHA,
  "github.ref_name": "main",
  "github.head_ref": "main",
  "github.repository": "local/repo",
  "github.actor": "local",
  "github.event.pull_request.number": "",
  "github.event.pull_request.title": "",
  "github.event.pull_request.user.login": "",
};

function resolveNeedsRef(
  trimmed: string,
  needsContext: Record<string, Record<string, string>> | undefined,
): string {
  if (!needsContext) {
    return "";
  }
  const parts = trimmed.split(".");
  const jobOutputs = needsContext[parts[1]];
  if (parts[2] === "outputs" && parts[3]) {
    return jobOutputs?.[parts[3]] ?? "";
  }
  if (parts[2] === "result") {
    return jobOutputs ? (jobOutputs["__result"] ?? "success") : "";
  }
  return "";
}

/**
 * Resolve a context-variable reference (runner.os, matrix.foo, secrets.X,
 * needs.X.outputs.Y, …). Returns `undefined` when the atom is not a known
 * context ref so the caller can fall through to "unknown atom".
 */
function resolveContextRef(trimmed: string, ctx: ExprContext): string | undefined {
  if (trimmed === "runner.os") {
    return ctx.runnerContext?.os ?? "Linux";
  }
  if (trimmed === "runner.arch") {
    return ctx.runnerContext?.arch ?? "X64";
  }
  if (trimmed === "strategy.job-total") {
    return ctx.matrixContext?.["__job_total"] ?? "1";
  }
  if (trimmed === "strategy.job-index") {
    return ctx.matrixContext?.["__job_index"] ?? "0";
  }
  if (trimmed.startsWith("github.")) {
    const key = trimmed.slice("github.".length);
    const dynamicValue = ctx.githubContext?.[key];
    if (dynamicValue !== undefined) {
      return dynamicValue;
    }
  }
  if (trimmed in CONST_CONTEXT_REFS) {
    return CONST_CONTEXT_REFS[trimmed];
  }
  if (trimmed.startsWith("matrix.")) {
    return ctx.matrixContext?.[trimmed.slice("matrix.".length)] ?? "";
  }
  if (trimmed.startsWith("secrets.")) {
    return ctx.secrets?.[trimmed.slice("secrets.".length)] ?? "";
  }
  if (trimmed.startsWith("vars.")) {
    return ctx.vars?.[trimmed.slice("vars.".length)] ?? "";
  }
  if (trimmed.startsWith("inputs.")) {
    return ctx.inputsContext?.[trimmed.slice("inputs.".length)] ?? "";
  }
  if (trimmed.startsWith("steps.")) {
    // Step-output references can't be resolved at parse time — the producing
    // step hasn't run yet — and the runner does not re-evaluate `${{ }}`
    // inside run-script bodies at runtime. Returning the sentinel used to
    // leak the literal `${{ }}` to bash and trigger "bad substitution".
    // Per the compatibility contract, resolve to an empty string at parse time.
    return "";
  }
  if (trimmed.startsWith("needs.")) {
    return resolveNeedsRef(trimmed, ctx.needsContext);
  }
  if (trimmed.startsWith("env.")) {
    return ctx.envContext?.[trimmed.slice("env.".length)] ?? "";
  }
  return undefined;
}

/**
 * Resolve a single atomic expression (function call or context variable).
 * Does not handle boolean operators, parentheses, or string literals.
 */
function resolveExprAtom(trimmed: string, ctx: ExprContext): string {
  const fnMatch = trimmed.match(FUNCTION_CALL_RE);
  if (fnMatch) {
    const handler = FUNCTION_HANDLERS[fnMatch[1]];
    if (handler) {
      return handler(fnMatch[2], ctx);
    }
  }

  if (trimmed in STATUS_FUNCTIONS) {
    return STATUS_FUNCTIONS[trimmed];
  }

  const ctxRef = resolveContextRef(trimmed, ctx);
  if (ctxRef !== undefined) {
    return ctxRef;
  }

  // Unknown atoms — return empty string
  return "";
}

/**
 * If `trimmed` is wrapped in matching outer parentheses, return the inner
 * string. Otherwise return null. Quotes are skipped so parens inside string
 * literals don't fool the matcher.
 */
function stripOuterParens(trimmed: string): string | null {
  if (!trimmed.startsWith("(")) {
    return null;
  }
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    }
    if (depth === 0) {
      return i === trimmed.length - 1 ? trimmed.slice(1, -1) : null;
    }
  }
  return null;
}

/**
 * Evaluate the left/right operands and apply the comparison if `trimmed`
 * splits cleanly on `op`. Returns null when the operator isn't a top-level
 * split point.
 */
function evalComparison(trimmed: string, op: string, ctx: ExprContext): string | null {
  const parts = splitOnOperator(trimmed, op);
  if (parts.length !== 2) {
    return null;
  }
  const left = evaluateExprValue(parts[0].trim(), ctx);
  const right = evaluateExprValue(parts[1].trim(), ctx);
  return compareValues(left, right, op) ? "true" : "false";
}

/**
 * Evaluate an expression that may contain ||, &&, !, parentheses,
 * string literals, function calls, and context variable references.
 * Returns the string result following GitHub Actions expression semantics.
 */
function evaluateExprValue(expr: string, ctx: ExprContext): string {
  const trimmed = expr.trim();
  if (!trimmed) {
    return "";
  }

  const stripped = stripOuterParens(trimmed);
  if (stripped !== null) {
    return evaluateExprValue(stripped, ctx);
  }

  // || (lowest precedence) — return first truthy, else the last value.
  const orParts = splitOnOperator(trimmed, "||");
  if (orParts.length > 1) {
    let lastVal = "";
    for (const part of orParts) {
      lastVal = evaluateExprValue(part.trim(), ctx);
      if (isExprTruthy(lastVal)) {
        return lastVal;
      }
    }
    return lastVal;
  }

  // && (higher precedence than ||) — return first falsy, else the last value.
  const andParts = splitOnOperator(trimmed, "&&");
  if (andParts.length > 1) {
    let lastVal = "";
    for (const part of andParts) {
      lastVal = evaluateExprValue(part.trim(), ctx);
      if (!isExprTruthy(lastVal)) {
        return lastVal;
      }
    }
    return lastVal;
  }

  // Comparison operators. Longer operators first so `<=` doesn't get split as `<`.
  for (const op of ["!=", "==", "<=", ">=", "<", ">"]) {
    const result = evalComparison(trimmed, op, ctx);
    if (result !== null) {
      return result;
    }
  }

  // ! prefix (negation)
  if (trimmed.startsWith("!")) {
    const inner = evaluateExprValue(trimmed.slice(1).trim(), ctx);
    return isExprTruthy(inner) ? "false" : "true";
  }

  // String literal
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }

  // Boolean / null literals
  if (trimmed === "true") {
    return "true";
  }
  if (trimmed === "false") {
    return "false";
  }
  if (trimmed === "null") {
    return "";
  }

  // Numeric literal
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }

  // Atom: function call or context variable
  return resolveExprAtom(trimmed, ctx);
}

/**
 * Expand `${{ expr }}` placeholders in a string.
 * Handles boolean operators (&&, ||, !), parentheses, string literals,
 * built-in functions (hashFiles, fromJSON, toJSON, format), and context
 * variable references (runner.*, github.*, matrix.*, secrets.*, etc.).
 */
export function expandExpressions(
  value: string,
  repoPath?: string,
  secrets?: Record<string, string>,
  matrixContext?: Record<string, string>,
  needsContext?: Record<string, Record<string, string>>,
  inputsContext?: Record<string, string>,
  vars?: Record<string, string>,
  runnerContext?: RunnerContext,
  envContext?: Record<string, string>,
  githubContext?: Record<string, string>,
): string {
  const ctx: ExprContext = {
    repoPath,
    secrets,
    matrixContext,
    needsContext,
    inputsContext,
    vars,
    runnerContext,
    envContext,
    githubContext,
  };
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expr: string) =>
    evaluateExprValue(expr, ctx),
  );
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
}

export function parseJobRunsOnLabels(filePath: string, jobId: string): string[] {
  try {
    const rawYaml = parseYaml(fs.readFileSync(filePath, "utf8"));
    const rawRunsOn = rawYaml?.jobs?.[jobId]?.["runs-on"];

    if (typeof rawRunsOn === "string") {
      return [rawRunsOn];
    }

    if (Array.isArray(rawRunsOn)) {
      return rawRunsOn.map(String);
    }

    if (rawRunsOn == null) {
      return [];
    }

    return [String(rawRunsOn)];
  } catch {
    return [];
  }
}

export function parseMergedJobEnv(
  filePath: string,
  jobId: string,
  matrixContext?: Record<string, string>,
): Record<string, string> {
  try {
    const rawYaml = parseYaml(fs.readFileSync(filePath, "utf8"));
    const workflowEnv = toStringRecord(rawYaml?.env);
    const jobEnv = toStringRecord(rawYaml?.jobs?.[jobId]?.env);
    const merged = { ...workflowEnv, ...jobEnv };

    if (!matrixContext) {
      return merged;
    }

    return Object.fromEntries(
      Object.entries(merged).map(([key, value]) => [
        key,
        expandExpressions(value, undefined, undefined, matrixContext),
      ]),
    );
  } catch {
    return {};
  }
}

/**
 * Simple recursive file finder using minimatch patterns.
 * Searches under rootDir for files matching pattern.
 */
function findFiles(rootDir: string, pattern: string): string[] {
  const results: string[] = [];
  const normPattern = pattern.replace(/^\.\//, "");

  function walk(dir: string, relative: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip node_modules only. Dotted directories (`.github`, `.cargo`, …)
      // are common hashFiles targets and GitHub Actions' hashFiles descends
      // into them when the pattern asks for them.
      if (entry.name === "node_modules") {
        continue;
      }
      const relChild = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relChild);
      } else if (minimatch(relChild, normPattern, { dot: true })) {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  walk(rootDir, "");
  return results;
}

export async function getWorkflowTemplate(filePath: string) {
  const { parseWorkflow, NoOperationTraceWriter, convertWorkflowTemplate } =
    await loadWorkflowParser();
  const content = fs.readFileSync(filePath, "utf8");
  const result = parseWorkflow({ name: filePath, content }, new NoOperationTraceWriter());

  if (result.value === undefined) {
    throw new Error(
      `Failed to parse workflow: ${result.context.errors
        .getErrors()
        .map((e: any) => e.message)
        .join(", ")}`,
    );
  }

  return await convertWorkflowTemplate(result.context, result.value);
}

/**
 * Collapse a matrix definition to a single job using the first value of each key.
 * Sets __job_total to "1" and __job_index to "0".
 * Used by the --no-matrix flag to run a matrix workflow as a single container.
 */
export function collapseMatrixToSingle(matrixDef: Record<string, any[]>): Record<string, string>[] {
  const combo: Record<string, string> = {};
  for (const [key, values] of Object.entries(matrixDef)) {
    if (values.length > 0) {
      combo[key] = String(values[0]);
    }
  }
  combo.__job_total = "1";
  combo.__job_index = "0";
  return [combo];
}

/**
 * Compute the Cartesian product of a matrix definition.
 * Values are always coerced to strings.
 * Returns [{}] for an empty matrix so callers always get at least one combination.
 */
export function expandMatrixCombinations(
  matrixDef: Record<string, any[]>,
): Record<string, string>[] {
  const keys = Object.keys(matrixDef);
  if (keys.length === 0) {
    return [{}];
  }
  let combos: Record<string, string>[] = [{}];
  for (const key of keys) {
    const values = matrixDef[key];
    const next: Record<string, string>[] = [];
    for (const combo of combos) {
      for (const val of values) {
        next.push({ ...combo, [key]: String(val) });
      }
    }
    combos = next;
  }
  return combos;
}

/**
 * Read the `strategy.matrix` object for a given job from the raw YAML.
 * Returns null if the job has no matrix.
 */
export async function parseMatrixDef(
  filePath: string,
  jobId: string,
): Promise<Record<string, any[]> | null> {
  const yaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const matrix = yaml?.jobs?.[jobId]?.strategy?.matrix;
  if (!matrix || typeof matrix !== "object") {
    return null;
  }
  // Only keep keys whose values are arrays
  const result: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(matrix)) {
    if (Array.isArray(v)) {
      result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Shells we wrap scripts for, by invoking them as a child process via heredoc.
 * The runner always executes Script steps with bash; when the user asks for a
 * non-bash shell we need to hand the script off to the requested interpreter
 * ourselves. Flags mirror what the GitHub-hosted runner uses by default.
 */
const SHELL_INVOCATIONS: Record<string, string> = {
  sh: "sh -e",
  python: "python3",
  pwsh: "pwsh -NoLogo -NoProfile -NonInteractive -Command -",
};

function wrapScriptForShell(script: string, shell: string): string {
  const invocation = SHELL_INVOCATIONS[shell];
  if (!invocation) {
    // bash, or something we don't know how to wrap — leave the script alone.
    // The runner's default shell is bash, which is what most workflows expect.
    return script;
  }
  // Use a delimiter that is extremely unlikely to appear in real scripts.
  const delimiter = "__LOCAL_CI_SHELL_WRAP_EOF__";
  return `${invocation} <<'${delimiter}'\n${script}\n${delimiter}`;
}

/**
 * Resolve a `defaults.run.<key>` value with GitHub Actions precedence:
 * step override beats job `defaults.run.<key>`, which beats workflow-level
 * `defaults.run.<key>`. Returns undefined when none is declared at any level.
 */
function resolveStepRunDefault(
  rawYaml: unknown,
  rawJob: unknown,
  rawStep: unknown,
  key: string,
): string | undefined {
  const pick = (source: unknown): string | undefined => {
    if (!source || typeof source !== "object") {
      return undefined;
    }
    const v = (source as Record<string, unknown>)[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const pickDefault = (source: unknown): string | undefined => {
    if (!source || typeof source !== "object") {
      return undefined;
    }
    const run = (source as { defaults?: { run?: unknown } }).defaults?.run;
    return pick(run);
  };
  return pick(rawStep) ?? pickDefault(rawJob) ?? pickDefault(rawYaml);
}

/**
 * Build a step's effective env by merging workflow-level, job-level, and
 * step-level `env:` blocks in that order — step overrides job overrides
 * workflow, per GitHub Actions semantics — then expanding each value's
 * `${{ }}` expressions.
 *
 * Returns undefined when no env is declared at any level, matching the
 * prior shape so a step with no env produces no `Env` field.
 */
function buildStepEnv(
  rawYaml: unknown,
  rawJob: unknown,
  rawStep: unknown,
  repoPath: string | undefined,
  secrets: Record<string, string> | undefined,
  matrixContext: Record<string, string> | undefined,
  needsContext: Record<string, Record<string, string>> | undefined,
  inputsContext: Record<string, string> | undefined,
  vars: Record<string, string> | undefined,
  runnerContext: RunnerContext | undefined,
): Record<string, string> | undefined {
  const pick = (source: unknown): Record<string, unknown> => {
    if (!source || typeof source !== "object") {
      return {};
    }
    const env = (source as { env?: unknown }).env;
    return env && typeof env === "object" ? (env as Record<string, unknown>) : {};
  };
  const workflowEnv = pick(rawYaml);
  const jobEnv = pick(rawJob);
  const stepEnv = pick(rawStep);
  if (
    Object.keys(workflowEnv).length === 0 &&
    Object.keys(jobEnv).length === 0 &&
    Object.keys(stepEnv).length === 0
  ) {
    return undefined;
  }
  // Resolve in scope order so each scope can reference the previous one via
  // `${{ env.* }}` — workflow alone, then job (with workflow env), then step
  // (with workflow + job env). Mirrors GitHub's outer-to-inner resolution.
  const resolveScope = (
    raw: Record<string, unknown>,
    envContext: Record<string, string>,
  ): Record<string, string> => {
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [
        k,
        expandExpressions(
          String(v),
          repoPath,
          secrets,
          matrixContext,
          needsContext,
          inputsContext,
          vars,
          runnerContext,
          envContext,
        ),
      ]),
    );
  };
  const resolvedWorkflow = resolveScope(workflowEnv, {});
  const resolvedJob = resolveScope(jobEnv, resolvedWorkflow);
  const baseEnv: Record<string, string> = { ...resolvedWorkflow, ...resolvedJob };
  const resolvedStep = resolveScope(stepEnv, baseEnv);
  return { ...baseEnv, ...resolvedStep };
}

function splitRemoteActionReference(name: string): { name: string; path: string } {
  const parts = name.split("/");
  if (parts.length <= 2) {
    return { name, path: "" };
  }
  return {
    name: parts.slice(0, 2).join("/"),
    path: parts.slice(2).join("/"),
  };
}

export async function parseWorkflowSteps(
  filePath: string,
  taskName: string,
  secrets?: Record<string, string>,
  matrixContext?: Record<string, string>,
  needsContext?: Record<string, Record<string, string>>,
  inputsContext?: Record<string, string>,
  vars?: Record<string, string>,
) {
  const template = await getWorkflowTemplate(filePath);
  const rawYaml = parseYaml(fs.readFileSync(filePath, "utf8"));

  // Derive repoPath from filePath (.../repoPath/.github/workflows/foo.yml → repoPath)
  const repoPath = path.dirname(path.dirname(path.dirname(filePath)));
  // Resolve ${{ runner.os }} / ${{ runner.arch }} from the job's runs-on so
  // that macOS/Windows jobs don't expand to Linux/X64 (issue #279).
  const runnerContext = runnerContextFromRunsOn(parseJobRunsOn(filePath, taskName));
  // Find the job by ID or Name
  if (!template.jobs) {
    throw new Error(`No jobs found in workflow "${filePath}"`);
  }
  const job = template.jobs.find((j) => {
    if (j.type !== "job") {
      return false;
    }
    return j.id.toString() === taskName || (j.name && j.name.toString() === taskName);
  });

  if (!job || job.type !== "job") {
    throw new Error(`Task "${taskName}" not found in workflow "${filePath}"`);
  }

  const rawJob = rawYaml.jobs?.[taskName] || {};
  const rawSteps = rawJob.steps || [];

  return job.steps
    .map((step, index) => {
      const stepId = step.id || `step-${index + 1}`;
      const rawStep = rawSteps[index] || {};

      const stepEnv = buildStepEnv(
        rawYaml,
        rawJob,
        rawStep,
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      );

      // Prefer raw YAML name to preserve ${{ }} expressions for our own expansion.
      // Computed after stepEnv so that env.* references in step names resolve correctly.
      const rawName = rawStep.name != null ? String(rawStep.name) : step.name?.toString();
      let stepName = rawName
        ? expandExpressions(
            rawName,
            repoPath,
            secrets,
            matrixContext,
            needsContext,
            inputsContext,
            vars,
            runnerContext,
            stepEnv,
          )
        : stepId;

      // If a step lacks an explicit name, we map it to standard GitHub Actions defaults
      if (!step.name) {
        if ("run" in step) {
          const runText = rawStep.run != null ? String(rawStep.run) : step.run.toString();
          // Extract the first non-empty line of the script
          const firstLine =
            runText
              .split("\n")
              .map((l: string) => l.trim())
              .find(Boolean) || "command";
          stepName = `Run ${firstLine}`;
        } else if ((step as any).uses) {
          stepName = `Run ${(step as any).uses.toString()}`;
        }
      }

      if ("run" in step) {
        // Prefer the raw YAML value over step.run.toString(): the workflow-parser
        // stringifies expression trees in ways that can truncate multiline scripts
        // (e.g. dropping the text after an embedded ${{ }} boundary). The raw YAML
        // string is always the complete literal block scalar.
        const rawScript = rawStep.run != null ? String(rawStep.run) : step.run.toString();
        const expandedScript = expandExpressions(
          rawScript,
          repoPath,
          secrets,
          matrixContext,
          needsContext,
          inputsContext,
          vars,
          runnerContext,
          stepEnv,
        );
        const shell = resolveStepRunDefault(rawYaml, rawJob, rawStep, "shell");
        const inputs: Record<string, string> = {
          script: shell ? wrapScriptForShell(expandedScript, shell) : expandedScript,
        };
        const workingDirectory = resolveStepRunDefault(
          rawYaml,
          rawJob,
          rawStep,
          "working-directory",
        );
        if (workingDirectory) {
          inputs.workingDirectory = workingDirectory;
        }
        const condition = parseStepIf(rawStep.if);
        return {
          Type: "Action",
          Name: stepName,
          DisplayName: stepName,
          Id: crypto.randomUUID(),
          ContextName: step.id ? step.id.toString() : undefined,
          Reference: {
            Type: "Script",
          },
          Inputs: inputs,
          Env: stepEnv,
          ...(condition !== undefined ? { condition } : {}),
        };
      } else if ("uses" in step) {
        // Basic support for 'uses' steps.
        // Parse uses string: owner/repo[/path]@ref or ./.github/actions/foo (local).
        // The runner expects remote sub-actions to be split into the parent
        // repository name plus a separate path; otherwise it extracts the repo
        // tarball under _actions/owner/repo/path/ref and then looks for
        // action.yml at the wrong directory level.
        const uses = step.uses.toString();
        const isLocalAction = uses.startsWith("./");
        let name = uses;
        let ref = "";
        let actionPath = "";

        if (!isLocalAction && uses.indexOf("@") >= 0) {
          const at = uses.lastIndexOf("@");
          const rawName = uses.slice(0, at);
          ref = uses.slice(at + 1);
          const split = splitRemoteActionReference(rawName);
          name = split.name;
          actionPath = split.path;
        }

        const isCheckout =
          !isLocalAction && actionPath === "" && name.trim().toLowerCase() === "actions/checkout";
        const stepWith = rawStep.with || {};
        const condition = parseStepIf(rawStep.if);

        return {
          Type: "Action",
          Name: stepName,
          DisplayName: stepName,
          Id: crypto.randomUUID(),
          ContextName: step.id ? step.id.toString() : undefined,
          Reference: {
            Type: "Repository",
            Name: isLocalAction ? "" : name,
            Ref: isLocalAction ? "" : ref,
            RepositoryType: isLocalAction ? "self" : "GitHub",
            Path: isLocalAction ? uses : actionPath,
          },
          Inputs: {
            // with: values from @actions/workflow-parser are expression objects; call toString() on each.
            ...((step as any).with
              ? Object.fromEntries(
                  Object.entries((step as any).with).map(([k, v]) => [
                    k,
                    expandExpressions(
                      String(v),
                      repoPath,
                      secrets,
                      matrixContext,
                      needsContext,
                      inputsContext,
                      vars,
                      runnerContext,
                      stepEnv,
                    ),
                  ]),
                )
              : {}),
            // Merge from raw YAML (overrides parsed values), expanding expressions
            ...Object.fromEntries(
              Object.entries(stepWith).map(([k, v]) => [
                k,
                expandExpressions(
                  String(v),
                  repoPath,
                  secrets,
                  matrixContext,
                  needsContext,
                  inputsContext,
                  vars,
                  runnerContext,
                  stepEnv,
                ),
              ]),
            ),
            ...(isCheckout
              ? {
                  clean: "false",
                  "fetch-depth": "0",
                  lfs: "false",
                  submodules: "false",
                  ...Object.fromEntries(
                    Object.entries(stepWith).map(([k, v]) => {
                      let expanded = expandExpressions(
                        String(v),
                        repoPath,
                        secrets,
                        undefined,
                        needsContext,
                        inputsContext,
                        vars,
                        runnerContext,
                        stepEnv,
                      );
                      // The zero hash is a placeholder for "no SHA available" —
                      // normalize it to empty string so actions/checkout uses the
                      // default branch instead of trying to fetch a nonexistent ref.
                      if (k === "ref" && expanded === "0000000000000000000000000000000000000000") {
                        expanded = "";
                      }
                      return [k, expanded];
                    }),
                  ),
                }
              : {}), // Prevent actions/checkout from wiping the rsynced workspace
          },
          Env: stepEnv,
          ...(condition !== undefined ? { condition } : {}),
        };
      }
      return null;
    })
    .filter(Boolean);
}

export interface WorkflowRegistryCredentials {
  username: string;
  password: string;
}

export interface WorkflowExpressionContext {
  repoPath?: string;
  secrets?: Record<string, string>;
  matrixContext?: Record<string, string>;
  needsContext?: Record<string, Record<string, string>>;
  inputsContext?: Record<string, string>;
  vars?: Record<string, string>;
  envContext?: Record<string, string>;
  githubContext?: Record<string, string>;
}

export interface WorkflowService {
  name: string;
  image: string;
  credentials?: WorkflowRegistryCredentials;
  env?: Record<string, string>;
  ports?: string[];
  options?: string;
}

function expandWorkflowExpression(value: unknown, context: WorkflowExpressionContext): string {
  return expandExpressions(
    String(value),
    context.repoPath,
    context.secrets,
    context.matrixContext,
    context.needsContext,
    context.inputsContext,
    context.vars,
    undefined,
    context.envContext,
    context.githubContext,
  );
}

function resolveWorkflowJobEnv(
  rawYaml: unknown,
  rawJob: unknown,
  context: WorkflowExpressionContext,
): Record<string, string> {
  const pick = (source: unknown): Record<string, unknown> => {
    if (!source || typeof source !== "object") {
      return {};
    }
    const env = (source as { env?: unknown }).env;
    return env && typeof env === "object" && !Array.isArray(env)
      ? (env as Record<string, unknown>)
      : {};
  };
  const resolveScope = (
    values: Record<string, unknown>,
    envContext: Record<string, string>,
  ): Record<string, string> =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        expandWorkflowExpression(value, { ...context, envContext }),
      ]),
    );

  const outerEnv = context.envContext ?? {};
  const workflowEnv = resolveScope(pick(rawYaml), outerEnv);
  const jobEnv = resolveScope(pick(rawJob), { ...outerEnv, ...workflowEnv });
  return { ...outerEnv, ...workflowEnv, ...jobEnv };
}

function parseRegistryCredentials(
  value: unknown,
  context: WorkflowExpressionContext,
): WorkflowRegistryCredentials | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  if (raw.username === undefined || raw.password === undefined) {
    return undefined;
  }

  return {
    username: expandWorkflowExpression(raw.username, context),
    password: expandWorkflowExpression(raw.password, context),
  };
}

export async function parseWorkflowServices(
  filePath: string,
  taskName: string,
  context: WorkflowExpressionContext = {},
): Promise<WorkflowService[]> {
  const rawYaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const rawJob = rawYaml.jobs?.[taskName] || {};
  const rawServices = rawJob.services;
  if (!rawServices || typeof rawServices !== "object") {
    return [];
  }
  const expressionContext = {
    ...context,
    envContext: resolveWorkflowJobEnv(rawYaml, rawJob, context),
  };

  return Object.entries(rawServices).map(([name, def]: [string, any]) => {
    const svc: WorkflowService = {
      name,
      image: expandWorkflowExpression(def.image || "", expressionContext),
    };
    const credentials = parseRegistryCredentials(def.credentials, expressionContext);
    if (credentials) {
      svc.credentials = credentials;
    }
    if (def.env && typeof def.env === "object") {
      svc.env = Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, String(v)]));
    }
    if (Array.isArray(def.ports)) {
      svc.ports = def.ports.map(String);
    }
    if (def.options) {
      svc.options = String(def.options);
    }
    return svc;
  });
}

export interface WorkflowContainer {
  image: string;
  credentials?: WorkflowRegistryCredentials;
  env?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  options?: string;
}

/**
 * Parse the `container:` directive from a workflow job.
 * Returns null if the job doesn't specify a container.
 *
 * Supports both short form (`container: node:18`) and
 * long form (`container: { image: ..., env: ..., ... }`).
 */
export async function parseWorkflowContainer(
  filePath: string,
  taskName: string,
  context: WorkflowExpressionContext = {},
): Promise<WorkflowContainer | null> {
  const rawYaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const rawJob = rawYaml.jobs?.[taskName] || {};
  const rawContainer = rawJob.container;
  if (!rawContainer) {
    return null;
  }
  const expressionContext = {
    ...context,
    envContext: resolveWorkflowJobEnv(rawYaml, rawJob, context),
  };

  // Short form: `container: node:18`
  if (typeof rawContainer === "string") {
    return { image: expandWorkflowExpression(rawContainer, expressionContext) };
  }

  if (typeof rawContainer !== "object") {
    return null;
  }

  const result: WorkflowContainer = {
    image: expandWorkflowExpression(rawContainer.image || "", expressionContext),
  };
  if (!result.image) {
    return null;
  }
  const credentials = parseRegistryCredentials(rawContainer.credentials, expressionContext);
  if (credentials) {
    result.credentials = credentials;
  }
  if (rawContainer.env && typeof rawContainer.env === "object") {
    result.env = Object.fromEntries(
      Object.entries(rawContainer.env).map(([k, v]) => [k, String(v)]),
    );
  }
  if (Array.isArray(rawContainer.ports)) {
    result.ports = rawContainer.ports.map(String);
  }
  if (Array.isArray(rawContainer.volumes)) {
    result.volumes = rawContainer.volumes.map(String);
  }
  if (rawContainer.options) {
    result.options = String(rawContainer.options);
  }
  return result;
}

/**
 * Get the list of files changed in the current commit relative to the previous
 * commit. Returns an empty array on error (safe fallback: all workflows run).
 */
export async function getChangedFiles(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP("git", ["diff", "--name-only", "HEAD~1"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    return stdout
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

type WorkflowEventFilters = {
  branches?: string[];
  "branches-ignore"?: string[];
  paths?: string[];
  "paths-ignore"?: string[];
};

interface WorkflowTemplateLike {
  events?: {
    pull_request?: WorkflowEventFilters;
    push?: WorkflowEventFilters;
    [key: string]: WorkflowEventFilters | undefined;
  };
}

/**
 * Check whether the changed files pass the paths / paths-ignore filter for an
 * event definition. Returns true (relevant) when:
 *  - No changedFiles provided or the array is empty (safe fallback).
 *  - No paths / paths-ignore filters are defined.
 *  - At least one changed file matches a `paths` pattern.
 *  - At least one changed file is NOT matched by all `paths-ignore` patterns.
 */
function matchesPaths(eventDef: WorkflowEventFilters, changedFiles?: string[]): boolean {
  if (!changedFiles || changedFiles.length === 0) {
    return true; // No file info → always relevant
  }

  const pathsFilter: string[] | undefined = eventDef.paths;
  const pathsIgnore: string[] | undefined = eventDef["paths-ignore"];

  if (!pathsFilter && !pathsIgnore) {
    return true; // No path filters defined
  }

  if (pathsFilter) {
    // At least one changed file must match one of the path patterns
    return changedFiles.some((file) => pathsFilter.some((pattern) => minimatch(file, pattern)));
  }

  if (pathsIgnore) {
    // At least one changed file must NOT be matched by all ignore patterns
    return changedFiles.some((file) => !pathsIgnore.some((pattern) => minimatch(file, pattern)));
  }

  return true;
}

export function isWorkflowRelevant(
  template: WorkflowTemplateLike,
  branch: string,
  changedFiles?: string[],
) {
  const events = template.events;
  if (!events) {
    return false;
  }

  // 1. Check pull_request
  if (events.pull_request) {
    const pr = events.pull_request;
    // If pull_request has branch filters, check if 'main' (target) is included.
    // This simulates a PR being raised against main.
    let branchMatches = false;
    if (!pr.branches && !pr["branches-ignore"]) {
      branchMatches = true; // No filters, matches all PRs
    } else if (pr.branches) {
      branchMatches = pr.branches.some((pattern: string) => minimatch("main", pattern));
    } else if (pr["branches-ignore"]) {
      branchMatches = !pr["branches-ignore"].some((pattern: string) => minimatch("main", pattern));
    }

    if (branchMatches && matchesPaths(pr, changedFiles)) {
      return true;
    }
  }

  // 2. Check pull_request_target (same logic as pull_request)
  if (events.pull_request_target) {
    const prt = events.pull_request_target;
    let branchMatches = false;
    if (!prt.branches && !prt["branches-ignore"]) {
      branchMatches = true;
    } else if (prt.branches) {
      branchMatches = prt.branches.some((pattern: string) => minimatch("main", pattern));
    } else if (prt["branches-ignore"]) {
      branchMatches = !prt["branches-ignore"].some((pattern: string) => minimatch("main", pattern));
    }

    if (branchMatches && matchesPaths(prt, changedFiles)) {
      return true;
    }
  }

  // 3. Check push
  if (events.push) {
    const push = events.push;
    let branchMatches = false;
    if (!push.branches && !push["branches-ignore"]) {
      branchMatches = true; // No filters, matches all pushes
    } else if (push.branches) {
      branchMatches = push.branches.some((pattern: string) => minimatch(branch, pattern));
    } else if (push["branches-ignore"]) {
      branchMatches = !push["branches-ignore"].some((pattern: string) =>
        minimatch(branch, pattern),
      );
    }

    if (branchMatches && matchesPaths(push, changedFiles)) {
      return true;
    }
  }

  // 4. workflow_dispatch-only workflows are local fixtures (e.g.
  // smoke-resource-mismatch.yml uses an unsatisfiable runner label and is
  // never expected to run on real GitHub Actions). Include them in --all so
  // local-ci can still exercise them locally. Only opt in when
  // workflow_dispatch is the sole event — if the workflow also lists
  // pull_request / push, those checks already had their say above and the
  // user's path/branch filters should be honored.
  if (
    events.workflow_dispatch !== undefined &&
    !events.pull_request &&
    !events.pull_request_target &&
    !events.push
  ) {
    return true;
  }

  return false;
}

/**
 * Scan a workflow file for all `${{ secrets.FOO }}` references.
 * If `taskName` is provided, only the YAML subtree for that job is scanned.
 * Returns a sorted, de-duplicated list of secret names.
 */
export function extractSecretRefs(filePath: string, taskName?: string): string[] {
  const raw = fs.readFileSync(filePath, "utf8");
  // Scope to the job subtree when a taskName is given so we don't pick up
  // secrets from other jobs.
  let source = raw;
  if (taskName) {
    try {
      const parsed = parseYaml(raw);
      const jobDef = parsed?.jobs?.[taskName];
      if (jobDef) {
        source = JSON.stringify(jobDef);
      }
    } catch {
      // Fall back to scanning the whole file
    }
  }
  const names = new Set<string>();
  for (const m of source.matchAll(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    names.add(m[1]);
  }
  return Array.from(names).sort();
}

/**
 * Validate that all secrets referenced in a workflow job are present in the
 * provided secrets map. Throws with a descriptive message listing the missing
 * secret names and the expected file path if any are absent.
 */
export function validateSecrets(
  filePath: string,
  taskName: string,
  secrets: Record<string, string>,
  secretsFilePath: string,
): void {
  const required = extractSecretRefs(filePath, taskName);
  const missing = required.filter((name) => !secrets[name]);
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    `[Local CI] Missing secrets required by workflow job "${taskName}".\n` +
      `Add the following to ${secretsFilePath} or set them as environment variables:\n\n` +
      missing.map((n) => `${n}=`).join("\n") +
      "\n",
  );
}

/**
 * Scan a workflow file for all `${{ vars.FOO }}` references.
 * If `taskName` is provided, only the YAML subtree for that job is scanned.
 * Returns a sorted, de-duplicated list of var names.
 */
export function extractVarRefs(filePath: string, taskName?: string): string[] {
  const raw = fs.readFileSync(filePath, "utf8");
  // Scope to the job subtree when a taskName is given so we don't pick up
  // vars from other jobs.
  let source = raw;
  if (taskName) {
    try {
      const parsed = parseYaml(raw);
      const jobDef = parsed?.jobs?.[taskName];
      if (jobDef) {
        source = JSON.stringify(jobDef);
      }
    } catch {
      // Fall back to scanning the whole file
    }
  }
  const names = new Set<string>();
  for (const m of source.matchAll(/\$\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    names.add(m[1]);
  }
  return Array.from(names).sort();
}

/**
 * Validate that all vars referenced in a workflow job are present in the
 * provided vars map. Throws with a descriptive message listing the missing
 * var names and the `--var` / `--var-file` inputs needed to supply them.
 */
export function validateVars(
  filePath: string,
  taskName: string,
  vars: Record<string, string>,
): void {
  const required = extractVarRefs(filePath, taskName);
  const missing = required.filter((name) => !vars[name]);
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    `[Local CI] Missing vars required by workflow job "${taskName}".\n` +
      `Pass them via --var NAME=value (one flag per variable) or --var-file <path>:\n\n` +
      missing.map((n) => `  --var ${n}=<value>`).join("\n") +
      "\n",
  );
}

/**
 * Parse `jobs.<id>.outputs` definitions from a workflow YAML file.
 * Returns a Record<outputName, expressionTemplate> (e.g. { skip: "${{ steps.check.outputs.skip }}" }).
 * Returns {} if the job has no outputs or doesn't exist.
 */
export function parseJobOutputDefs(filePath: string, jobId: string): Record<string, string> {
  const yaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const outputs = yaml?.jobs?.[jobId]?.outputs;
  if (!outputs || typeof outputs !== "object") {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) {
    result[k] = String(v);
  }
  return result;
}

/**
 * Parse the `if:` condition from a workflow job.
 * Returns the raw expression string (with `${{ }}` wrapper stripped if present),
 * or null if the job has no `if:`.
 */
export function parseJobIf(filePath: string, jobId: string): string | null {
  const yaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const rawIf = yaml?.jobs?.[jobId]?.if;
  if (rawIf == null) {
    return null;
  }
  let expr = String(rawIf).trim();
  // Strip ${{ }} wrapper if present
  const wrapped = expr.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  if (wrapped) {
    expr = wrapped[1];
  }
  return expr;
}

/**
 * Normalize a step-level `if:` value into a condition string for the runner's
 * EvaluateStepIf. Accepts the raw YAML value (may be string, boolean, null).
 * Strips a surrounding `${{ }}` wrapper so the runner sees a bare expression,
 * matching the format it uses for the default `success()`.
 * Returns undefined when no condition should be forwarded (the server then
 * defaults to `success()`).
 */
export function parseStepIf(rawIf: unknown): string | undefined {
  if (rawIf === undefined || rawIf === null) {
    return undefined;
  }
  let expr = String(rawIf).trim();
  if (expr === "") {
    return undefined;
  }
  const wrapped = expr.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  if (wrapped) {
    expr = wrapped[1].trim();
    if (expr === "") {
      return undefined;
    }
  }
  return expr;
}

/**
 * Evaluate a job-level `if:` condition.
 *
 * @param expr       The expression string (already stripped of `${{ }}`)
 * @param jobResults Record<jobId, "success" | "failure"> for upstream jobs
 * @param needsCtx   Optional needs output context (same shape as expandExpressions needsContext)
 * @returns          Whether the job should run
 */
export function evaluateJobIf(
  expr: string,
  jobResults: Record<string, string>,
  needsCtx?: Record<string, Record<string, string>>,
): boolean {
  const trimmed = expr.trim();

  // Empty expression defaults to success()
  if (!trimmed) {
    return evaluateAtom("success()", jobResults, needsCtx);
  }

  // Handle || (split first — lower precedence)
  if (trimmed.includes("||")) {
    const parts = splitOnOperator(trimmed, "||");
    if (parts.length > 1) {
      return parts.some((p) => evaluateJobIf(p.trim(), jobResults, needsCtx));
    }
  }

  // Handle &&
  if (trimmed.includes("&&")) {
    const parts = splitOnOperator(trimmed, "&&");
    if (parts.length > 1) {
      return parts.every((p) => evaluateJobIf(p.trim(), jobResults, needsCtx));
    }
  }

  return evaluateAtom(trimmed, jobResults, needsCtx);
}

/**
 * Split an expression on a logical operator, respecting parentheses and quotes.
 */
function splitOnOperator(expr: string, op: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote: string | null = null;
  let current = "";

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
    }
    if (ch === ")") {
      depth--;
    }
    if (depth === 0 && expr.slice(i, i + op.length) === op) {
      parts.push(current);
      current = "";
      i += op.length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Evaluate a single atomic condition (no && or ||).
 */
function evaluateAtom(
  expr: string,
  jobResults: Record<string, string>,
  needsCtx?: Record<string, Record<string, string>>,
): boolean {
  const trimmed = expr.trim();

  // Status check functions
  if (trimmed === "always()") {
    return true;
  }
  if (trimmed === "cancelled()") {
    return false;
  }
  if (trimmed === "success()") {
    return Object.values(jobResults).every((r) => r === "success");
  }
  if (trimmed === "failure()") {
    return Object.values(jobResults).some((r) => r === "failure");
  }

  // != comparison
  const neqMatch = trimmed.match(/^(.+?)\s*!=\s*(.+)$/);
  if (neqMatch) {
    const left = resolveValue(neqMatch[1].trim(), needsCtx);
    const right = resolveValue(neqMatch[2].trim(), needsCtx);
    return left !== right;
  }

  // == comparison
  const eqMatch = trimmed.match(/^(.+?)\s*==\s*(.+)$/);
  if (eqMatch) {
    const left = resolveValue(eqMatch[1].trim(), needsCtx);
    const right = resolveValue(eqMatch[2].trim(), needsCtx);
    return left === right;
  }

  // Bare truthy value (e.g. needs.setup.outputs.run_tests)
  const val = resolveValue(trimmed, needsCtx);
  return val !== "" && val !== "false" && val !== "0";
}

/**
 * Resolve a value reference in a condition expression.
 */
function resolveValue(raw: string, needsCtx?: Record<string, Record<string, string>>): string {
  const trimmed = raw.trim();
  // Quoted string literal
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  // needs.<jobId>.outputs.<name>
  if (trimmed.startsWith("needs.") && needsCtx) {
    const parts = trimmed.split(".");
    const jobId = parts[1];
    const jobOutputs = needsCtx[jobId];
    if (parts[2] === "outputs" && parts[3]) {
      return jobOutputs?.[parts[3]] ?? "";
    }
    if (parts[2] === "result") {
      return jobOutputs ? (jobOutputs["__result"] ?? "success") : "";
    }
  }
  return trimmed;
}

/**
 * Parse `strategy.fail-fast` for a job.
 * Returns true/false if explicitly set, undefined if not specified.
 */
/**
 * Parse the `runs-on:` field of a workflow job and return the labels as a flat
 * array of strings. Accepts all three shapes GitHub allows:
 *
 *   - String:        `runs-on: ubuntu-latest`
 *   - Array:         `runs-on: [self-hosted, macos, arm64]`
 *   - Object form:   `runs-on: { group: foo, labels: [x, y] }`
 *
 * Returns an empty array if the job has no `runs-on:` (or the workflow is
 * unparseable). Callers that need to detect a missing value should treat an
 * empty array as "unknown".
 */
export function parseJobRunsOn(filePath: string, jobId: string): string[] {
  const yaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const raw = yaml?.jobs?.[jobId]?.["runs-on"];
  if (raw == null) {
    return [];
  }
  if (typeof raw === "string") {
    return [raw];
  }
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v));
  }
  if (typeof raw === "object") {
    const labels = (raw as Record<string, unknown>).labels;
    if (Array.isArray(labels)) {
      return labels.map((v) => String(v));
    }
    if (typeof labels === "string") {
      return [labels];
    }
  }
  return [];
}

export function parseFailFast(filePath: string, jobId: string): boolean | undefined {
  const yaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const strategy = yaml?.jobs?.[jobId]?.strategy;
  if (!strategy || typeof strategy !== "object") {
    return undefined;
  }
  if ("fail-fast" in strategy) {
    return Boolean(strategy["fail-fast"]);
  }
  return undefined;
}
