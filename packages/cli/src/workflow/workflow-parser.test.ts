import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseJobRunsOnLabels,
  parseMergedJobEnv,
  parseWorkflowContainer,
  parseWorkflowServices,
} from "./workflow-parser.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WORKFLOW_WITH_SERVICES = `
name: Unit Tests
on: [push]
jobs:
  unit-tests:
    runs-on: ubuntu-latest
    services:
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: root
          MYSQL_DATABASE: test_db
          MYSQL_USER: app
          MYSQL_PASSWORD: app
        options: >-
          --health-cmd="mysqladmin ping -h localhost -proot"
          --health-interval=5s
          --health-timeout=3s
          --health-retries=10
        ports:
          - 3306:3306
      redis:
        image: redis:7
        ports:
          - 6379:6379
    steps:
      - run: echo hi
`.trimStart();

const WORKFLOW_NO_SERVICES = `
name: Simple
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`.trimStart();

const WORKFLOW_SERVICE_NO_PORTS = `
name: Minimal Service
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: secret
    steps:
      - run: echo hi
`.trimStart();

const WORKFLOW_WITH_PRIVATE_IMAGES = `
name: Private Images
on: [push]
env:
  REGISTRY_NAMESPACE: private-org
  REGISTRY_USER: workflow-user
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      REGISTRY_USER: \${{ vars.registry_user }}
    container:
      image: \${{ vars.registry }}/\${{ github.repository_owner }}/\${{ env.REGISTRY_NAMESPACE }}/ci-image:latest
      credentials:
        username: \${{ github.actor }}
        password: \${{ secrets.CONTAINER_TOKEN }}
    services:
      cache:
        image: \${{ vars.registry }}/\${{ github.repository }}/cache:latest
        credentials:
          username: \${{ env.REGISTRY_USER }}-\${{ matrix.registry_user }}
          password: \${{ secrets.SERVICE_TOKEN }}
    steps:
      - run: echo hi
`.trimStart();

const WORKFLOW_WITH_HINTS = `
name: Resource Hints
on: [push]
env:
  SHARED: workflow
  NUMERIC: 42
  ENABLED: true
jobs:
  string-runs-on:
    runs-on: ubuntu-latest
    env:
      SHARED: job
      JOB_ONLY: yes
  array-runs-on:
    runs-on: [ubuntu-latest, ubuntu-latest-8-cores]
    env:
      NODE_OPTIONS: --max-old-space-size=\${{ matrix.heap }}
      HEAP: \${{ matrix.heap }}
      FLAG: false
    steps:
      - run: echo hi
`.trimStart();

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("parseWorkflowServices", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-svc-test-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("parses MySQL service with env, ports, and health check options", async () => {
    const filePath = writeWorkflow(WORKFLOW_WITH_SERVICES);
    const services = await parseWorkflowServices(filePath, "unit-tests");

    expect(services).toHaveLength(2);

    const mysql = services.find((s) => s.name === "mysql")!;
    expect(mysql).toBeDefined();
    expect(mysql.image).toBe("mysql:8.0");
    expect(mysql.env).toEqual({
      MYSQL_ROOT_PASSWORD: "root",
      MYSQL_DATABASE: "test_db",
      MYSQL_USER: "app",
      MYSQL_PASSWORD: "app",
    });
    expect(mysql.ports).toEqual(["3306:3306"]);
    expect(mysql.options).toContain("--health-cmd");
    expect(mysql.options).toContain("--health-interval=5s");
  });

  it("parses Redis service with ports but no env or options", async () => {
    const filePath = writeWorkflow(WORKFLOW_WITH_SERVICES);
    const services = await parseWorkflowServices(filePath, "unit-tests");

    const redis = services.find((s) => s.name === "redis")!;
    expect(redis).toBeDefined();
    expect(redis.image).toBe("redis:7");
    expect(redis.ports).toEqual(["6379:6379"]);
    expect(redis.env).toBeUndefined();
    expect(redis.options).toBeUndefined();
  });

  it("returns empty array when job has no services", async () => {
    const filePath = writeWorkflow(WORKFLOW_NO_SERVICES);
    const services = await parseWorkflowServices(filePath, "build");

    expect(services).toEqual([]);
  });

  it("returns empty array when job doesn't exist", async () => {
    const filePath = writeWorkflow(WORKFLOW_NO_SERVICES);
    const services = await parseWorkflowServices(filePath, "nonexistent");

    expect(services).toEqual([]);
  });

  it("parses service with env but no ports", async () => {
    const filePath = writeWorkflow(WORKFLOW_SERVICE_NO_PORTS);
    const services = await parseWorkflowServices(filePath, "test");

    expect(services).toHaveLength(1);
    const pg = services[0];
    expect(pg.name).toBe("postgres");
    expect(pg.image).toBe("postgres:16");
    expect(pg.env).toEqual({ POSTGRES_PASSWORD: "secret" });
    expect(pg.ports).toBeUndefined();
    expect(pg.options).toBeUndefined();
  });

  it("resolves GitHub, env, matrix, vars, and secret contexts for private services", async () => {
    const filePath = writeWorkflow(WORKFLOW_WITH_PRIVATE_IMAGES);
    const services = await parseWorkflowServices(filePath, "test", {
      secrets: { SERVICE_TOKEN: "service-secret" },
      matrixContext: { registry_user: "matrix-user" },
      vars: { registry: "ghcr.io", registry_user: "env-service-user" },
      githubContext: {
        repository: "redwoodjs/local-ci",
        repository_owner: "redwoodjs",
        actor: "peterp",
      },
    });

    expect(services[0]).toMatchObject({
      image: "ghcr.io/redwoodjs/local-ci/cache:latest",
      credentials: {
        username: "env-service-user-matrix-user",
        password: "service-secret",
      },
    });
  });

  it("converts env values to strings", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-svc-test-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(
      filePath,
      `name: Env Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      db:
        image: mysql:8.0
        env:
          PORT: 3306
          SKIP_TZINFO: 1
          DEBUG: true
    steps:
      - run: echo hi
`,
    );

    const services = await parseWorkflowServices(filePath, "test");
    const db = services[0];
    // Numeric and boolean YAML values should be coerced to strings
    expect(db.env!.PORT).toBe("3306");
    expect(db.env!.SKIP_TZINFO).toBe("1");
    expect(db.env!.DEBUG).toBe("true");
  });
});

describe("parseWorkflowContainer", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves real GitHub and merged env contexts for private job containers", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-container-test-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, WORKFLOW_WITH_PRIVATE_IMAGES);

    const container = await parseWorkflowContainer(filePath, "test", {
      secrets: { CONTAINER_TOKEN: "container-secret" },
      vars: { registry: "ghcr.io", registry_user: "unused-here" },
      githubContext: {
        repository: "redwoodjs/local-ci",
        repository_owner: "redwoodjs",
        actor: "peterp",
      },
    });

    expect(container).toEqual({
      image: "ghcr.io/redwoodjs/private-org/ci-image:latest",
      credentials: {
        username: "peterp",
        password: "container-secret",
      },
    });
  });
});

describe("workflow resource hint accessors", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-hint-test-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("parses string runs-on labels", async () => {
    const filePath = writeWorkflow(WORKFLOW_WITH_HINTS);

    expect(await parseJobRunsOnLabels(filePath, "string-runs-on")).toEqual(["ubuntu-latest"]);
  });

  it("parses array runs-on labels", async () => {
    const filePath = writeWorkflow(WORKFLOW_WITH_HINTS);

    expect(await parseJobRunsOnLabels(filePath, "array-runs-on")).toEqual([
      "ubuntu-latest",
      "ubuntu-latest-8-cores",
    ]);
  });

  it("merges workflow and job env with job precedence", async () => {
    const filePath = writeWorkflow(WORKFLOW_WITH_HINTS);

    expect(await parseMergedJobEnv(filePath, "string-runs-on")).toEqual({
      SHARED: "job",
      NUMERIC: "42",
      ENABLED: "true",
      JOB_ONLY: "yes",
    });
  });

  it("coerces numeric and boolean env values to strings", async () => {
    const filePath = writeWorkflow(WORKFLOW_WITH_HINTS);

    expect(await parseMergedJobEnv(filePath, "string-runs-on")).toMatchObject({
      NUMERIC: "42",
      ENABLED: "true",
      JOB_ONLY: "yes",
    });
  });

  it("expands matrix expressions in merged env values", async () => {
    const filePath = writeWorkflow(WORKFLOW_WITH_HINTS);

    expect(await parseMergedJobEnv(filePath, "array-runs-on", { heap: "16192" })).toEqual({
      SHARED: "workflow",
      NUMERIC: "42",
      ENABLED: "true",
      NODE_OPTIONS: "--max-old-space-size=16192",
      HEAP: "16192",
      FLAG: "false",
    });
  });
});

// ─── expandExpressions ────────────────────────────────────────────────────────

import { expandExpressions } from "./workflow-parser.ts";

describe("expandExpressions", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeRepo(...files: { name: string; content: string }[]): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-expr-test-"));
    for (const { name, content } of files) {
      const full = path.join(tmpDir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return tmpDir;
  }

  // ── passthrough ──────────────────────────────────────────────────────────────

  it("returns plain strings unchanged", () => {
    expect(expandExpressions("hello-world")).toBe("hello-world");
    expect(expandExpressions("")).toBe("");
    expect(expandExpressions("Linux-vite-build-abc123")).toBe("Linux-vite-build-abc123");
  });

  // ── context variables ────────────────────────────────────────────────────────

  it("expands runner.os to Linux", () => {
    expect(expandExpressions("${{ runner.os }}-build")).toBe("Linux-build");
  });

  it("expands runner.arch to X64", () => {
    expect(expandExpressions("prefix-${{ runner.arch }}")).toBe("prefix-X64");
  });

  it("expands github.run_id to '1'", () => {
    expect(expandExpressions("cache-${{ github.run_id }}")).toBe("cache-1");
  });

  it("expands github.run_number to '1'", () => {
    expect(expandExpressions("run-${{ github.run_number }}")).toBe("run-1");
  });

  it("expands github.sha to zeros", () => {
    expect(expandExpressions("sha-${{ github.sha }}")).toBe(
      "sha-0000000000000000000000000000000000000000",
    );
  });

  it("expands github.ref_name to main", () => {
    expect(expandExpressions("branch-${{ github.ref_name }}")).toBe("branch-main");
  });

  it("expands github.repository", () => {
    expect(expandExpressions("${{ github.repository }}")).toBe("local/repo");
  });

  it("expands secrets.* to empty string when no secrets map provided", () => {
    expect(expandExpressions("token=${{ secrets.MY_TOKEN }}")).toBe("token=");
  });

  it("expands secrets.* to empty string when key is absent from secrets map", () => {
    expect(expandExpressions("token=${{ secrets.MISSING }}", undefined, { OTHER: "value" })).toBe(
      "token=",
    );
  });

  it("expands secrets.* from provided secrets map", () => {
    expect(
      expandExpressions("token=${{ secrets.MY_TOKEN }}", undefined, { MY_TOKEN: "abc123" }),
    ).toBe("token=abc123");
  });

  it("expands multiple secrets from provided secrets map", () => {
    const secrets = { API_TOKEN: "tok-xyz", ACCOUNT_ID: "acc-123" };
    expect(
      expandExpressions("${{ secrets.API_TOKEN }}:${{ secrets.ACCOUNT_ID }}", undefined, secrets),
    ).toBe("tok-xyz:acc-123");
  });

  it("expands matrix.* to empty string when no matrixContext provided", () => {
    expect(expandExpressions("shard-${{ matrix.shard }}")).toBe("shard-");
  });

  it("resolves steps.* expressions to empty string at parse time", () => {
    // The producing step has not run yet, and the runner does not re-evaluate
    // `${{ }}` inside run-script bodies. Leaving the expression literal leaked
    // raw `${{ }}` text to bash ("bad substitution"); resolving to empty here
    // lets cross-step reads degrade to "" instead of crashing the shell.
    expect(expandExpressions("hit-${{ steps.cache.outputs.cache-hit }}")).toBe("hit-");
    expect(expandExpressions("${{ steps.some-step.outputs.result }}")).toBe("");
  });

  it("expands needs.* to empty string", () => {
    expect(expandExpressions("${{ needs.build.result }}")).toBe("");
  });

  // ── inputs.* ──────────────────────────────────────────────────────────────

  it("expands inputs.* from inputsContext", () => {
    const inputs = { "node-version": "20", environment: "staging" };
    expect(
      expandExpressions(
        "node-${{ inputs.node-version }}",
        undefined,
        undefined,
        undefined,
        undefined,
        inputs,
      ),
    ).toBe("node-20");
    expect(
      expandExpressions(
        "env=${{ inputs.environment }}",
        undefined,
        undefined,
        undefined,
        undefined,
        inputs,
      ),
    ).toBe("env=staging");
  });

  it("expands inputs.* to empty string when no inputsContext provided", () => {
    expect(expandExpressions("ver=${{ inputs.node-version }}")).toBe("ver=");
  });

  it("expands inputs.* to empty string when key is absent from inputsContext", () => {
    expect(
      expandExpressions("${{ inputs.missing }}", undefined, undefined, undefined, undefined, {
        other: "val",
      }),
    ).toBe("");
  });

  it("expands inputs.* inside fromJSON()", () => {
    const inputs = { config: '{"key":"value"}' };
    expect(
      expandExpressions(
        "${{ fromJSON(inputs.config) }}",
        undefined,
        undefined,
        undefined,
        undefined,
        inputs,
      ),
    ).toBe('{"key":"value"}');
  });

  it("expands inputs.* inside format()", () => {
    const inputs = { name: "world" };
    expect(
      expandExpressions(
        "${{ format('hello {0}', inputs.name) }}",
        undefined,
        undefined,
        undefined,
        undefined,
        inputs,
      ),
    ).toBe("hello world");
  });

  it("expands unknown expressions to empty string (no commas injected)", () => {
    expect(expandExpressions("${{ some.unknown.expr }}")).toBe("");
    // Especially important: unknown expressions must NOT contain commas
    const result = expandExpressions("key-${{ something.weird('a','b') }}");
    expect(result).not.toContain(",");
  });

  // ── compound strings ─────────────────────────────────────────────────────────

  it("expands multiple expressions in one string", () => {
    const result = expandExpressions("${{ runner.os }}-build-${{ github.run_id }}");
    expect(result).toBe("Linux-build-1");
  });

  it("produces a cache key with no commas even for multi-arg hashFiles", () => {
    const repoDir = makeRepo({ name: "package.json", content: "{}" });
    const result = expandExpressions(
      "${{ runner.os }}-vite-build-${{ hashFiles('package.json', 'pnpm-lock.yaml') }}",
      repoDir,
    );
    expect(result).not.toContain(",");
    expect(result).toMatch(/^Linux-vite-build-[0-9a-f]+$/);
  });

  // ── hashFiles ────────────────────────────────────────────────────────────────

  it("hashFiles with a matching file returns a hex sha256", () => {
    const repoDir = makeRepo({ name: "pnpm-lock.yaml", content: "lockfile: v6" });
    const result = expandExpressions("${{ hashFiles('pnpm-lock.yaml') }}", repoDir);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashFiles is deterministic for the same file content", () => {
    const repoDir = makeRepo({ name: "pnpm-lock.yaml", content: "lockfile: v6" });
    const a = expandExpressions("${{ hashFiles('pnpm-lock.yaml') }}", repoDir);
    const b = expandExpressions("${{ hashFiles('pnpm-lock.yaml') }}", repoDir);
    expect(a).toBe(b);
  });

  it("hashFiles changes when file content changes", () => {
    const repoDir = makeRepo({ name: "lock.yaml", content: "version: 1" });
    const before = expandExpressions("${{ hashFiles('lock.yaml') }}", repoDir);
    fs.writeFileSync(path.join(repoDir, "lock.yaml"), "version: 2");
    const after = expandExpressions("${{ hashFiles('lock.yaml') }}", repoDir);
    expect(before).not.toBe(after);
  });

  it("hashFiles with multiple matching patterns combines all files", () => {
    const repoDir = makeRepo(
      { name: "package.json", content: "{}" },
      { name: "pnpm-lock.yaml", content: "lockfile: v6" },
    );
    const both = expandExpressions("${{ hashFiles('package.json', 'pnpm-lock.yaml') }}", repoDir);
    const justPackage = expandExpressions("${{ hashFiles('package.json') }}", repoDir);
    // Hash of both files is different from hash of just one
    expect(both).toMatch(/^[0-9a-f]{64}$/);
    expect(both).not.toBe(justPackage);
  });

  it("hashFiles with no matching files returns zero hash", () => {
    const repoDir = makeRepo({ name: "package.json", content: "{}" });
    const result = expandExpressions("${{ hashFiles('nonexistent.txt') }}", repoDir);
    expect(result).toBe("0000000000000000000000000000000000000000");
  });

  it("hashFiles without repoPath returns zero hash", () => {
    const result = expandExpressions("${{ hashFiles('package.json') }}");
    expect(result).toBe("0000000000000000000000000000000000000000");
  });

  it("hashFiles matches glob patterns", () => {
    const repoDir = makeRepo(
      { name: "src/foo.ts", content: "const x = 1" },
      { name: "src/bar.ts", content: "const y = 2" },
    );
    const result = expandExpressions("${{ hashFiles('src/**/*.ts') }}", repoDir);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── expandExpressions — matrixContext ────────────────────────────────────────

describe("expandExpressions with matrixContext", () => {
  it("expands matrix.shard to the provided shard value", () => {
    expect(
      expandExpressions("shard-${{ matrix.shard }}", undefined, undefined, { shard: "3" }),
    ).toBe("shard-3");
  });

  it("expands strategy.job-total to __job_total from context", () => {
    expect(
      expandExpressions("total-${{ strategy.job-total }}", undefined, undefined, {
        __job_total: "8",
      }),
    ).toBe("total-8");
  });

  it("expands both matrix.shard and strategy.job-total in a real command", () => {
    const result = expandExpressions(
      "pnpm test:e2e:ci --shard=${{ matrix.shard }}/${{ strategy.job-total }}",
      undefined,
      undefined,
      { shard: "3", __job_total: "8" },
    );
    expect(result).toBe("pnpm test:e2e:ci --shard=3/8");
  });

  it("returns empty string for matrix.* when matrixContext not provided", () => {
    expect(expandExpressions("shard-${{ matrix.shard }}")).toBe("shard-");
  });

  it("returns fallback '1' for strategy.job-total when context not provided", () => {
    expect(expandExpressions("${{ strategy.job-total }}")).toBe("1");
  });
});

// ─── expandMatrixCombinations ─────────────────────────────────────────────────

import { expandMatrixCombinations } from "./workflow-parser.ts";

describe("expandMatrixCombinations", () => {
  it("returns [{}] for an empty matrix", () => {
    expect(expandMatrixCombinations({})).toEqual([{}]);
  });

  it("returns one combination per value for a single dimension", () => {
    const combos = expandMatrixCombinations({ shard: [1, 2, 3] });
    expect(combos).toHaveLength(3);
    expect(combos[0]).toEqual({ shard: "1" });
    expect(combos[1]).toEqual({ shard: "2" });
    expect(combos[2]).toEqual({ shard: "3" });
  });

  it("coerces numeric values to strings", () => {
    const combos = expandMatrixCombinations({ shard: [1, 2] });
    expect(typeof combos[0].shard).toBe("string");
  });

  it("returns 8 combinations for shard [1..8]", () => {
    const combos = expandMatrixCombinations({ shard: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(combos).toHaveLength(8);
    expect(combos[7]).toEqual({ shard: "8" });
  });

  it("returns Cartesian product for multi-dimensional matrix", () => {
    const combos = expandMatrixCombinations({ os: ["ubuntu", "windows"], node: [18, 20] });
    expect(combos).toHaveLength(4);
    // All four combinations must be present
    expect(combos).toContainEqual({ os: "ubuntu", node: "18" });
    expect(combos).toContainEqual({ os: "ubuntu", node: "20" });
    expect(combos).toContainEqual({ os: "windows", node: "18" });
    expect(combos).toContainEqual({ os: "windows", node: "20" });
  });
});

// ─── loadMachineSecrets ───────────────────────────────────────────────────────

// Inline the parser logic rather than importing from config.ts to avoid
// the module-level `configSchema.parse(process.env)` ZodError in test env.
function loadMachineSecrets(baseDir: string): Record<string, string> {
  const envMachinePath = path.join(baseDir, ".env.machine");
  if (!fs.existsSync(envMachinePath)) {
    return {};
  }
  const secrets: Record<string, string> = {};
  for (const line of fs.readFileSync(envMachinePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) {
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      secrets[key] = value;
    }
  }
  return secrets;
}

describe("loadMachineSecrets", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeMachineEnv(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-secrets-test-"));
    fs.writeFileSync(path.join(tmpDir, ".env.machine"), content);
    return tmpDir;
  }

  it("returns empty object when .env.machine does not exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-secrets-test-"));
    // No .env.machine written — file simply absent
    const secrets = loadMachineSecrets(tmpDir);
    expect(secrets).toEqual({});
  });

  it("parses KEY=VALUE pairs into a record", () => {
    const dir = writeMachineEnv(
      "CLOUDFLARE_API_TOKEN=my-fake-cf-token\nCLOUDFLARE_ACCOUNT_ID=acct-abc123\n",
    );
    const secrets = loadMachineSecrets(dir);
    expect(secrets).toEqual({
      CLOUDFLARE_API_TOKEN: "my-fake-cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-abc123",
    });
  });

  it("ignores comment lines and blank lines", () => {
    const dir = writeMachineEnv(
      `# This is a comment
API_KEY=super-secret-key-xyz

# Another comment
OTHER_TOKEN=tok-456
`,
    );
    const secrets = loadMachineSecrets(dir);
    expect(secrets).toEqual({
      API_KEY: "super-secret-key-xyz",
      OTHER_TOKEN: "tok-456",
    });
  });

  it("strips surrounding double quotes from values", () => {
    const dir = writeMachineEnv('QUOTED_TOKEN="my-quoted-token"\n');
    const secrets = loadMachineSecrets(dir);
    expect(secrets["QUOTED_TOKEN"]).toBe("my-quoted-token");
  });

  it("strips surrounding single quotes from values", () => {
    const dir = writeMachineEnv("SINGLE_QUOTED='my-single-quoted'\n");
    const secrets = loadMachineSecrets(dir);
    expect(secrets["SINGLE_QUOTED"]).toBe("my-single-quoted");
  });

  it("handles values containing equals signs", () => {
    const dir = writeMachineEnv("URL=https://example.com?foo=bar&baz=qux\n");
    const secrets = loadMachineSecrets(dir);
    expect(secrets["URL"]).toBe("https://example.com?foo=bar&baz=qux");
  });
});

// ─── extractSecretRefs & validateSecrets ──────────────────────────────────────

import { extractSecretRefs, validateSecrets } from "./workflow-parser.ts";

describe("extractSecretRefs", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-secrets-refs-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("returns empty array when workflow has no secrets references", () => {
    const filePath = writeWorkflow(`
name: No Secrets
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`);
    expect(extractSecretRefs(filePath)).toEqual([]);
  });

  it("extracts unique sorted secret names from the whole file", () => {
    const filePath = writeWorkflow(`
name: Secrets Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.API_TOKEN }}
      ACCT: \${{ secrets.ACCOUNT_ID }}
      DUP: \${{ secrets.API_TOKEN }}
    steps:
      - run: echo ok
`);
    expect(extractSecretRefs(filePath)).toEqual(["ACCOUNT_ID", "API_TOKEN"]);
  });

  it("scopes to the specified job when taskName is provided", () => {
    const filePath = writeWorkflow(`
name: Multi Job
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.BUILD_TOKEN }}
    steps:
      - run: echo build
  test:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.TEST_TOKEN }}
    steps:
      - run: echo test
`);
    expect(extractSecretRefs(filePath, "test")).toEqual(["TEST_TOKEN"]);
    expect(extractSecretRefs(filePath, "build")).toEqual(["BUILD_TOKEN"]);
  });
});

describe("validateSecrets", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-validate-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("does not throw when all required secrets are present", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  run:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.MY_TOKEN }}
    steps:
      - run: echo ok
`);
    expect(() =>
      validateSecrets(filePath, "run", { MY_TOKEN: "abc123" }, "/repo/.env.local-ci"),
    ).not.toThrow();
  });

  it("does not throw when workflow has no secrets", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    expect(() => validateSecrets(filePath, "run", {}, "/repo/.env.local-ci")).not.toThrow();
  });

  it("throws listing missing secrets and the secrets file path", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CF_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
      CF_ACCT: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - run: echo deploy
`);
    expect(() => validateSecrets(filePath, "deploy", {}, "/home/user/repo/.env.local-ci")).toThrow(
      /CLOUDFLARE_ACCOUNT_ID=/,
    );

    expect(() => validateSecrets(filePath, "deploy", {}, "/home/user/repo/.env.local-ci")).toThrow(
      /CLOUDFLARE_API_TOKEN=/,
    );

    expect(() => validateSecrets(filePath, "deploy", {}, "/home/user/repo/.env.local-ci")).toThrow(
      /\/home\/user\/repo\/.env.local-ci/,
    );
  });

  it("only fails for missing secrets, not for ones that are present", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  run:
    runs-on: ubuntu-latest
    env:
      A: \${{ secrets.PRESENT_SECRET }}
      B: \${{ secrets.MISSING_SECRET }}
    steps:
      - run: echo ok
`);
    expect(() =>
      validateSecrets(filePath, "run", { PRESENT_SECRET: "value" }, "/repo/.env.local-ci"),
    ).toThrow(/MISSING_SECRET/);

    expect(() =>
      validateSecrets(filePath, "run", { PRESENT_SECRET: "value" }, "/repo/.env.local-ci"),
    ).not.toThrow(/PRESENT_SECRET/);
  });
});

// ─── isWorkflowRelevant ───────────────────────────────────────────────────────

import { isWorkflowRelevant } from "./workflow-parser.ts";

describe("isWorkflowRelevant", () => {
  // Helper to build a template with push event config
  function pushTemplate(config: Record<string, any> = {}) {
    return { events: { push: config } };
  }

  function prTemplate(config: Record<string, any> = {}) {
    return { events: { pull_request: config } };
  }

  // ── Basic branch matching (existing behavior) ─────────────────────────────

  it("matches push with no branch/path filters", () => {
    expect(isWorkflowRelevant(pushTemplate(), "main")).toBe(true);
  });

  it("matches push when branch matches", () => {
    expect(isWorkflowRelevant(pushTemplate({ branches: ["main"] }), "main")).toBe(true);
  });

  it("does not match push when branch doesn't match", () => {
    expect(isWorkflowRelevant(pushTemplate({ branches: ["main"] }), "feature")).toBe(false);
  });

  // ── paths-ignore ──────────────────────────────────────────────────────────

  it("skips workflow when all changed files match paths-ignore", () => {
    const template = pushTemplate({
      "paths-ignore": ["**/*.md", "docs/**", "LICENSE"],
    });
    const changedFiles = ["README.md", "docs/guide.md", "LICENSE"];
    expect(isWorkflowRelevant(template, "main", changedFiles)).toBe(false);
  });

  it("runs workflow when at least one changed file is not ignored", () => {
    const template = pushTemplate({
      "paths-ignore": ["**/*.md", "docs/**"],
    });
    const changedFiles = ["README.md", "cli/src/cli.ts"];
    expect(isWorkflowRelevant(template, "main", changedFiles)).toBe(true);
  });

  it("runs workflow when paths-ignore is set but no changed files provided", () => {
    const template = pushTemplate({
      "paths-ignore": ["**/*.md"],
    });
    expect(isWorkflowRelevant(template, "main")).toBe(true);
    expect(isWorkflowRelevant(template, "main", [])).toBe(true);
  });

  // ── paths ─────────────────────────────────────────────────────────────────

  it("runs workflow when a changed file matches a paths filter", () => {
    const template = pushTemplate({
      paths: ["cli/**", "dtu-github-actions/**"],
    });
    const changedFiles = ["cli/src/cli.ts"];
    expect(isWorkflowRelevant(template, "main", changedFiles)).toBe(true);
  });

  it("skips workflow when no changed files match paths filter", () => {
    const template = pushTemplate({
      paths: ["cli/**"],
    });
    const changedFiles = ["README.md", "docs/guide.md"];
    expect(isWorkflowRelevant(template, "main", changedFiles)).toBe(false);
  });

  it("runs workflow when paths is set but no changed files provided", () => {
    const template = pushTemplate({
      paths: ["cli/**"],
    });
    expect(isWorkflowRelevant(template, "main")).toBe(true);
    expect(isWorkflowRelevant(template, "main", [])).toBe(true);
  });

  // ── paths + branch interaction ────────────────────────────────────────────

  it("skips when branch matches but all files are ignored", () => {
    const template = pushTemplate({
      branches: ["main"],
      "paths-ignore": ["**/*.md"],
    });
    expect(isWorkflowRelevant(template, "main", ["README.md"])).toBe(false);
  });

  it("skips when branch does not match, even if paths would match", () => {
    const template = pushTemplate({
      branches: ["main"],
      paths: ["cli/**"],
    });
    expect(isWorkflowRelevant(template, "feature", ["cli/src/cli.ts"])).toBe(false);
  });

  // ── pull_request with paths ───────────────────────────────────────────────

  it("skips PR workflow when all changed files match paths-ignore", () => {
    const template = prTemplate({
      "paths-ignore": ["**/*.md"],
    });
    expect(isWorkflowRelevant(template, "feature", ["README.md"])).toBe(false);
  });

  it("runs PR workflow when a changed file is not ignored", () => {
    const template = prTemplate({
      "paths-ignore": ["**/*.md"],
    });
    expect(isWorkflowRelevant(template, "feature", ["cli/src/cli.ts"])).toBe(true);
  });

  // ── pull_request_target ─────────────────────────────────────────────────

  function prtTemplate(config: Record<string, any> = {}) {
    return { events: { pull_request_target: config } };
  }

  it("matches pull_request_target with no filters", () => {
    expect(isWorkflowRelevant(prtTemplate(), "feature")).toBe(true);
  });

  it("matches pull_request_target when branch filter includes main", () => {
    expect(isWorkflowRelevant(prtTemplate({ branches: ["main"] }), "feature")).toBe(true);
  });

  it("skips pull_request_target when branch filter excludes main", () => {
    expect(isWorkflowRelevant(prtTemplate({ branches: ["develop"] }), "feature")).toBe(false);
  });

  it("matches pull_request_target with paths filter when files match", () => {
    const template = prtTemplate({ paths: ["src/**"] });
    expect(isWorkflowRelevant(template, "feature", ["src/index.ts"])).toBe(true);
  });

  it("skips pull_request_target with paths filter when no files match", () => {
    const template = prtTemplate({ paths: ["src/**"] });
    expect(isWorkflowRelevant(template, "feature", ["README.md"])).toBe(false);
  });

  // ── workflow_dispatch ───────────────────────────────────────────────────

  it("matches workflow_dispatch-only workflows (local fixtures)", () => {
    expect(isWorkflowRelevant({ events: { workflow_dispatch: {} } }, "main")).toBe(true);
  });

  it("matches workflow_dispatch-only workflows declared as null (no inputs)", () => {
    // GitHub allows `on: workflow_dispatch:` with no value, which YAML parses to null.
    expect(isWorkflowRelevant({ events: { workflow_dispatch: null as any } }, "main")).toBe(true);
  });

  it("does not match when only event is unknown to the discoverer", () => {
    expect(isWorkflowRelevant({ events: { schedule: [{ cron: "0 0 * * *" }] } }, "main")).toBe(
      false,
    );
  });

  it("honors pull_request paths-ignore even when workflow_dispatch is also listed", () => {
    // workflow_dispatch alongside a real trigger should NOT override the trigger's filters.
    const template = {
      events: {
        pull_request: { "paths-ignore": ["**/*.md"] },
        workflow_dispatch: {},
      },
    };
    expect(isWorkflowRelevant(template, "feature", ["README.md"])).toBe(false);
  });
});

// ─── fromJSON / toJSON ────────────────────────────────────────────────────────

describe("expandExpressions — fromJSON", () => {
  it("fromJSON parses a JSON array string and returns it", () => {
    expect(expandExpressions('${{ fromJSON(\'["a","b","c"]\') }}')).toBe('["a","b","c"]');
  });

  it("fromJSON parses a JSON string value and unwraps it", () => {
    expect(expandExpressions("${{ fromJSON('\"hello\"') }}")).toBe("hello");
  });

  it("fromJSON parses a JSON number and returns it as string", () => {
    expect(expandExpressions("${{ fromJSON('42') }}")).toBe("42");
  });

  it("fromJSON parses a JSON boolean", () => {
    expect(expandExpressions("${{ fromJSON('true') }}")).toBe("true");
    expect(expandExpressions("${{ fromJSON('false') }}")).toBe("false");
  });

  it("fromJSON parses a JSON object string", () => {
    const result = expandExpressions('${{ fromJSON(\'{"key":"val"}\') }}');
    expect(JSON.parse(result)).toEqual({ key: "val" });
  });

  it("fromJSON returns empty string for invalid JSON", () => {
    expect(expandExpressions("${{ fromJSON('not valid json') }}")).toBe("");
  });

  it("fromJSON with a nested expression resolves the inner expr first", () => {
    // Simulates fromJSON(needs.setup.outputs.matrix) — the inner expr resolves first
    const needsCtx = { setup: { matrix: '["x","y"]' } };
    expect(
      expandExpressions(
        "${{ fromJSON(needs.setup.outputs.matrix) }}",
        undefined,
        undefined,
        undefined,
        needsCtx,
      ),
    ).toBe('["x","y"]');
  });
});

describe("expandExpressions — toJSON", () => {
  it("toJSON wraps a string value in quotes", () => {
    expect(expandExpressions("${{ toJSON('hello') }}")).toBe('"hello"');
  });
});

// ─── Cross-job outputs: needs context ─────────────────────────────────────────

import { parseJobOutputDefs } from "./workflow-parser.ts";

describe("parseJobOutputDefs", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-outputs-test-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("parses job output definitions from YAML", () => {
    const filePath = writeWorkflow(`
name: Test Outputs
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    outputs:
      skip: \${{ steps.check.outputs.skip }}
      shard_count: \${{ steps.count.outputs.shard_count }}
    steps:
      - run: echo ok
`);
    const defs = parseJobOutputDefs(filePath, "setup");
    expect(defs).toEqual({
      skip: "${{ steps.check.outputs.skip }}",
      shard_count: "${{ steps.count.outputs.shard_count }}",
    });
  });

  it("returns empty object when job has no outputs", () => {
    const filePath = writeWorkflow(`
name: No Outputs
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    const defs = parseJobOutputDefs(filePath, "build");
    expect(defs).toEqual({});
  });

  it("returns empty object for nonexistent job", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    const defs = parseJobOutputDefs(filePath, "nonexistent");
    expect(defs).toEqual({});
  });
});

describe("expandExpressions with needsContext", () => {
  it("resolves needs.build.outputs.sha to the provided value", () => {
    const needsCtx = { build: { sha: "abc123" } };
    expect(
      expandExpressions(
        "sha=${{ needs.build.outputs.sha }}",
        undefined,
        undefined,
        undefined,
        needsCtx,
      ),
    ).toBe("sha=abc123");
  });

  it("resolves needs.setup.outputs.skip to 'false'", () => {
    const needsCtx = { setup: { skip: "false" } };
    expect(
      expandExpressions(
        "${{ needs.setup.outputs.skip }}",
        undefined,
        undefined,
        undefined,
        needsCtx,
      ),
    ).toBe("false");
  });

  it("returns empty string for unknown needs output", () => {
    const needsCtx = { build: { sha: "abc123" } };
    expect(
      expandExpressions(
        "${{ needs.build.outputs.unknown }}",
        undefined,
        undefined,
        undefined,
        needsCtx,
      ),
    ).toBe("");
  });

  it("returns empty string for unknown needs job", () => {
    const needsCtx = { build: { sha: "abc123" } };
    expect(
      expandExpressions(
        "${{ needs.other.outputs.sha }}",
        undefined,
        undefined,
        undefined,
        needsCtx,
      ),
    ).toBe("");
  });

  it("resolves needs.build.result to success when not explicitly set", () => {
    const needsCtx = { build: {} };
    // needs.build.result should default to 'success' if the job succeeded
    expect(
      expandExpressions("${{ needs.build.result }}", undefined, undefined, undefined, needsCtx),
    ).toBe("success");
  });
});

// ─── expandExpressions with envContext ───────────────────────────────────────

describe("expandExpressions with envContext", () => {
  it("expands env.* from provided envContext", () => {
    expect(
      expandExpressions(
        "path=${{ env.CACHE_PATH }}",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { CACHE_PATH: "tmp/cache" },
      ),
    ).toBe("path=tmp/cache");
  });

  it("expands env.* to empty string when envContext is not provided", () => {
    expect(expandExpressions("${{ env.MISSING }}")).toBe("");
  });

  it("expands env.* to empty string when key is absent from envContext", () => {
    expect(
      expandExpressions(
        "${{ env.MISSING }}",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { OTHER: "val" },
      ),
    ).toBe("");
  });

  it("expands multiple env.* vars in a cache key expression", () => {
    const env = { RUBOCOP_CACHE_ROOT: "tmp/rubocop", DEPENDENCIES_HASH: "abc123" };
    expect(
      expandExpressions(
        "rubocop-${{ runner.os }}-${{ env.DEPENDENCIES_HASH }}-default",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        env,
      ),
    ).toBe("rubocop-Linux-abc123-default");
  });
});

// ─── expandExpressions — boolean operators (issue #224) ──────────────────────

describe("expandExpressions with boolean operators", () => {
  it("evaluates the issue #224 expression correctly", () => {
    // github.event.pull_request is "" (falsy locally), !falsy = true
    // true && format(...) = format result = "host --steps=create --tag=main"
    // "host --steps=create --tag=main" || 'plan' = "host --steps=create --tag=main"
    const result = expandExpressions(
      "dist ${{ (!github.event.pull_request && format('host --steps=create --tag={0}', github.ref_name)) || 'plan' }} --output-format=json",
    );
    expect(result).toBe("dist host --steps=create --tag=main --output-format=json");
  });

  it("evaluates || with truthy left side to left side value", () => {
    const result = expandExpressions("${{ 'hello' || 'fallback' }}");
    expect(result).toBe("hello");
  });

  it("evaluates && with truthy operands", () => {
    const result = expandExpressions("${{ 'a' && 'b' }}");
    expect(result).toBe("b");
  });

  it("evaluates && with falsy left side to empty", () => {
    const result = expandExpressions("${{ '' && 'b' }}");
    expect(result).toBe("");
  });

  it("evaluates ! operator on falsy value", () => {
    // github.event.pull_request is empty (falsy), !falsy = true
    const result = expandExpressions("${{ !github.event.pull_request }}");
    expect(result).toBe("true");
  });

  it("evaluates ! operator on truthy value", () => {
    const result = expandExpressions("${{ !github.actor }}");
    expect(result).toBe("false");
  });

  it("evaluates nested parentheses with && and ||", () => {
    const result = expandExpressions("${{ (github.event.pull_request && 'pr') || 'push' }}");
    expect(result).toBe("push");
  });
});

// ─── expandExpressions — contains, startsWith, endsWith ──────────────────────

describe("expandExpressions with contains()", () => {
  it("returns true when string contains substring (case-insensitive)", () => {
    expect(expandExpressions("${{ contains('Hello World', 'hello') }}")).toBe("true");
  });

  it("returns false when string does not contain substring", () => {
    expect(expandExpressions("${{ contains('Hello World', 'goodbye') }}")).toBe("false");
  });

  it("searches a JSON array for a matching item", () => {
    expect(
      expandExpressions("${{ contains(fromJSON('[\"push\", \"pull_request\"]'), 'push') }}"),
    ).toBe("true");
  });

  it("returns false when array does not contain item", () => {
    expect(
      expandExpressions("${{ contains(fromJSON('[\"push\", \"pull_request\"]'), 'schedule') }}"),
    ).toBe("false");
  });

  it("works with context variables", () => {
    expect(expandExpressions("${{ contains(github.repository, 'local') }}")).toBe("true");
  });
});

describe("expandExpressions with startsWith()", () => {
  it("returns true when string starts with prefix (case-insensitive)", () => {
    expect(expandExpressions("${{ startsWith('Hello World', 'hello') }}")).toBe("true");
  });

  it("returns false when string does not start with prefix", () => {
    expect(expandExpressions("${{ startsWith('Hello World', 'world') }}")).toBe("false");
  });

  it("works with context variables", () => {
    expect(expandExpressions("${{ startsWith(github.ref_name, 'mai') }}")).toBe("true");
  });
});

describe("expandExpressions with endsWith()", () => {
  it("returns true when string ends with suffix (case-insensitive)", () => {
    expect(expandExpressions("${{ endsWith('Hello World', 'WORLD') }}")).toBe("true");
  });

  it("returns false when string does not end with suffix", () => {
    expect(expandExpressions("${{ endsWith('Hello World', 'Hello') }}")).toBe("false");
  });
});

// ─── expandExpressions — join ────────────────────────────────────────────────

describe("expandExpressions with join()", () => {
  it("joins a JSON array with default separator", () => {
    expect(expandExpressions('${{ join(fromJSON(\'["a", "b", "c"]\')) }}')).toBe("a, b, c");
  });

  it("joins a JSON array with custom separator", () => {
    expect(expandExpressions('${{ join(fromJSON(\'["a", "b", "c"]\'), \'-\') }}')).toBe("a-b-c");
  });
});

// ─── expandExpressions — comparison operators ────────────────────────────────

describe("expandExpressions with comparison operators", () => {
  it("== returns true for equal strings (case-insensitive)", () => {
    expect(expandExpressions("${{ 'hello' == 'Hello' }}")).toBe("true");
  });

  it("== returns false for unequal strings", () => {
    expect(expandExpressions("${{ 'hello' == 'world' }}")).toBe("false");
  });

  it("!= returns true for unequal strings", () => {
    expect(expandExpressions("${{ 'hello' != 'world' }}")).toBe("true");
  });

  it("!= returns false for equal strings", () => {
    expect(expandExpressions("${{ 'hello' != 'Hello' }}")).toBe("false");
  });

  it("== works with context variables", () => {
    expect(expandExpressions("${{ github.actor == 'local' }}")).toBe("true");
  });

  it("!= works with context variables", () => {
    expect(expandExpressions("${{ github.actor != 'admin' }}")).toBe("true");
  });

  it("compares numbers with <", () => {
    expect(expandExpressions("${{ 1 < 2 }}")).toBe("true");
  });

  it("compares numbers with >", () => {
    expect(expandExpressions("${{ 2 > 1 }}")).toBe("true");
  });

  it("compares numbers with <=", () => {
    expect(expandExpressions("${{ 2 <= 2 }}")).toBe("true");
  });

  it("compares numbers with >=", () => {
    expect(expandExpressions("${{ 1 >= 2 }}")).toBe("false");
  });
});

// ─── expandExpressions — type literals ───────────────────────────────────────

describe("expandExpressions with type literals", () => {
  it("true literal is truthy", () => {
    expect(expandExpressions("${{ true }}")).toBe("true");
  });

  it("false literal is falsy", () => {
    expect(expandExpressions("${{ false }}")).toBe("false");
  });

  it("null literal resolves to empty string", () => {
    expect(expandExpressions("${{ null }}")).toBe("");
  });

  it("numeric literal passes through", () => {
    expect(expandExpressions("${{ 42 }}")).toBe("42");
  });

  it("true && value returns value", () => {
    expect(expandExpressions("${{ true && 'yes' }}")).toBe("yes");
  });

  it("false || value returns value", () => {
    expect(expandExpressions("${{ false || 'fallback' }}")).toBe("fallback");
  });

  it("false && value returns false", () => {
    expect(expandExpressions("${{ false && 'yes' }}")).toBe("false");
  });
});

// ─── expandExpressions — status functions ────────────────────────────────────

describe("expandExpressions with status functions", () => {
  it("success() returns true", () => {
    expect(expandExpressions("${{ success() }}")).toBe("true");
  });

  it("failure() returns false", () => {
    expect(expandExpressions("${{ failure() }}")).toBe("false");
  });

  it("always() returns true", () => {
    expect(expandExpressions("${{ always() }}")).toBe("true");
  });

  it("cancelled() returns false", () => {
    expect(expandExpressions("${{ cancelled() }}")).toBe("false");
  });
});

// ─── expandExpressions — combined real-world patterns ────────────────────────

describe("expandExpressions real-world patterns", () => {
  it("contains() with fromJSON in a boolean expression", () => {
    const result = expandExpressions(
      "${{ contains(fromJSON('[\"MEMBER\", \"OWNER\"]'), 'OWNER') && 'allowed' || 'denied' }}",
    );
    expect(result).toBe("allowed");
  });

  it("comparison in a ternary-style pattern", () => {
    const result = expandExpressions(
      "${{ github.ref_name == 'main' && 'production' || 'staging' }}",
    );
    expect(result).toBe("production");
  });

  it("startsWith used as a condition", () => {
    const result = expandExpressions(
      "${{ startsWith(github.ref_name, 'release') && 'release' || 'dev' }}",
    );
    expect(result).toBe("dev");
  });
});

// ─── Job-level if conditions ──────────────────────────────────────────────────

import { evaluateJobIf, parseJobIf, parseStepIf } from "./workflow-parser.ts";

describe("parseJobIf", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-job-if-test-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("returns the if expression when present", () => {
    const filePath = writeWorkflow(`
name: If Test
on: [push]
jobs:
  test:
    if: needs.setup.outputs.skip == 'false'
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    expect(parseJobIf(filePath, "test")).toBe("needs.setup.outputs.skip == 'false'");
  });

  it("returns null when job has no if", () => {
    const filePath = writeWorkflow(`
name: No If
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    expect(parseJobIf(filePath, "build")).toBeNull();
  });

  it("strips ${{ }} wrapper if present", () => {
    const filePath = writeWorkflow(`
name: If Wrapped
on: [push]
jobs:
  check:
    if: \${{ always() }}
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    expect(parseJobIf(filePath, "check")).toBe("always()");
  });
});

describe("parseStepIf", () => {
  it("returns undefined for null or undefined", () => {
    expect(parseStepIf(undefined)).toBeUndefined();
    expect(parseStepIf(null)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(parseStepIf("")).toBeUndefined();
    expect(parseStepIf("   ")).toBeUndefined();
  });

  it("returns a naked expression unchanged", () => {
    expect(parseStepIf("contains(runner.name, 'blacksmith')")).toBe(
      "contains(runner.name, 'blacksmith')",
    );
    expect(parseStepIf("always()")).toBe("always()");
  });

  it("strips a ${{ }} wrapper", () => {
    expect(parseStepIf("${{ contains(runner.name, 'blacksmith') }}")).toBe(
      "contains(runner.name, 'blacksmith')",
    );
    expect(parseStepIf("${{ !contains(runner.name, 'blacksmith') }}")).toBe(
      "!contains(runner.name, 'blacksmith')",
    );
  });

  it("coerces boolean YAML values to string", () => {
    expect(parseStepIf(true)).toBe("true");
    expect(parseStepIf(false)).toBe("false");
  });

  it("trims whitespace inside and outside the wrapper", () => {
    expect(parseStepIf("   always()   ")).toBe("always()");
    expect(parseStepIf("${{   always()   }}")).toBe("always()");
  });

  it("returns undefined when the wrapper contains only whitespace", () => {
    expect(parseStepIf("${{  }}")).toBeUndefined();
  });
});

describe("evaluateJobIf", () => {
  it("always() returns true", () => {
    expect(evaluateJobIf("always()", {})).toBe(true);
  });

  it("success() returns true when all upstream jobs succeeded", () => {
    expect(evaluateJobIf("success()", { build: "success", lint: "success" })).toBe(true);
  });

  it("success() returns false when any upstream job failed", () => {
    expect(evaluateJobIf("success()", { build: "success", lint: "failure" })).toBe(false);
  });

  it("failure() returns true when any upstream job failed", () => {
    expect(evaluateJobIf("failure()", { build: "success", lint: "failure" })).toBe(true);
  });

  it("failure() returns false when all upstream succeeded", () => {
    expect(evaluateJobIf("failure()", { build: "success" })).toBe(false);
  });

  it("cancelled() returns false (locally, nothing is ever cancelled)", () => {
    expect(evaluateJobIf("cancelled()", {})).toBe(false);
  });

  it("evaluates string equality with needs outputs", () => {
    const needsCtx = { setup: { run_tests: "true" } };
    expect(evaluateJobIf("needs.setup.outputs.run_tests == 'true'", {}, needsCtx)).toBe(true);
  });

  it("evaluates string inequality with needs outputs", () => {
    const needsCtx = { setup: { run_tests: "false" } };
    expect(evaluateJobIf("needs.setup.outputs.run_tests == 'true'", {}, needsCtx)).toBe(false);
  });

  it("evaluates != operator", () => {
    const needsCtx = { setup: { skip: "false" } };
    expect(evaluateJobIf("needs.setup.outputs.skip != 'true'", {}, needsCtx)).toBe(true);
  });

  it("evaluates compound condition with &&", () => {
    const needsCtx = { setup: { skip: "false", run_tests: "true" } };
    expect(
      evaluateJobIf(
        "needs.setup.outputs.skip == 'false' && needs.setup.outputs.run_tests == 'true'",
        {},
        needsCtx,
      ),
    ).toBe(true);
  });

  it("evaluates compound condition with || where first is false", () => {
    expect(evaluateJobIf("failure() || always()", { build: "success" })).toBe(true);
  });

  it("defaults to success() when expression is empty", () => {
    expect(evaluateJobIf("", { build: "success" })).toBe(true);
    expect(evaluateJobIf("", { build: "failure" })).toBe(false);
  });
});

// ─── strategy.fail-fast ──────────────────────────────────────────────────────

import { parseFailFast } from "./workflow-parser.ts";

describe("parseFailFast", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-failfast-test-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("returns false when strategy.fail-fast is explicitly false", () => {
    const filePath = writeWorkflow(`
name: Fail Fast False
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3]
    steps:
      - run: echo ok
`);
    expect(parseFailFast(filePath, "test")).toBe(false);
  });

  it("returns true when strategy.fail-fast is explicitly true", () => {
    const filePath = writeWorkflow(`
name: Fail Fast True
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: true
      matrix:
        shard: [1, 2]
    steps:
      - run: echo ok
`);
    expect(parseFailFast(filePath, "test")).toBe(true);
  });

  it("returns undefined when strategy has no fail-fast key", () => {
    const filePath = writeWorkflow(`
name: No Fail Fast
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2]
    steps:
      - run: echo ok
`);
    expect(parseFailFast(filePath, "test")).toBeUndefined();
  });

  it("returns undefined when job has no strategy", () => {
    const filePath = writeWorkflow(`
name: No Strategy
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    expect(parseFailFast(filePath, "build")).toBeUndefined();
  });
});

// ─── parseWorkflowSteps with needsContext ─────────────────────────────────────

import { parseWorkflowSteps } from "./workflow-parser.ts";

describe("parseWorkflowSteps with needsContext", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflowTree(content: string): string {
    // Create a minimal repo structure: repoRoot/.github/workflows/test.yml
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-steps-needs-"));
    const workflowDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    const filePath = path.join(workflowDir, "test.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("resolves needs.*.outputs.* in step scripts when needsContext is provided", async () => {
    const filePath = writeWorkflowTree(`
name: Needs Test
on: [push]
jobs:
  test:
    needs: [setup]
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ needs.setup.outputs.skip }}
`);
    const needsCtx = { setup: { skip: "false" } };
    const steps = await parseWorkflowSteps(filePath, "test", undefined, undefined, needsCtx);

    // The step script should have "false" substituted in
    expect((steps[0] as any).Inputs.script).toBe("echo false");
  });

  it("resolves needs context in step names", async () => {
    const filePath = writeWorkflowTree(`
name: Needs Name Test
on: [push]
jobs:
  test:
    needs: [setup]
    runs-on: ubuntu-latest
    steps:
      - name: "Shard \${{ needs.setup.outputs.index }}"
        run: echo hello
`);
    const needsCtx = { setup: { index: "3" } };
    const steps = await parseWorkflowSteps(filePath, "test", undefined, undefined, needsCtx);

    expect((steps[0] as any).Name).toBe("Shard 3");
  });

  it("forwards step-level if: conditions as step.condition", async () => {
    const filePath = writeWorkflowTree(`
name: Step If Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: no-if
        run: echo one
      - name: naked
        if: contains(runner.name, 'blacksmith')
        run: echo two
      - name: wrapped
        if: \${{ !contains(runner.name, 'blacksmith') }}
        run: echo three
      - name: always
        if: always()
        run: echo four
      - name: false-literal
        if: \${{ false }}
        run: echo five
      - name: uses-with-if
        if: \${{ runner.os == 'Linux' }}
        uses: actions/checkout@v4
`);
    const steps = await parseWorkflowSteps(filePath, "test");
    const conds = steps.map((s: any) => s.condition);
    // no-if → undefined (server defaults to success())
    expect(conds[0]).toBeUndefined();
    // naked expression passes through unchanged
    expect(conds[1]).toBe("contains(runner.name, 'blacksmith')");
    // ${{ }} wrapper is stripped
    expect(conds[2]).toBe("!contains(runner.name, 'blacksmith')");
    expect(conds[3]).toBe("always()");
    expect(conds[4]).toBe("false");
    // applies to `uses` steps too
    expect(conds[5]).toBe("runner.os == 'Linux'");
  });
});

// ─── parseWorkflowSteps with env context references ──────────────────────────

describe("parseWorkflowSteps with env context references", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflowTree(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-env-ctx-"));
    const workflowDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    const filePath = path.join(workflowDir, "test.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  // Adapted from the GitHub Actions env context docs:
  // https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#example-usage-of-the-env-context
  const MASCOT_WORKFLOW = `
name: Hi Mascot
on: push
env:
  mascot: Mona
  super_duper_var: totally_awesome

jobs:
  windows_job:
    runs-on: windows-latest
    steps:
      - run: echo 'Hi \${{ env.mascot }}'
      - run: echo 'Hi \${{ env.mascot }}'
        env:
          mascot: Octocat
  linux_job:
    runs-on: ubuntu-latest
    env:
      mascot: Tux
    steps:
      - run: echo 'Hi \${{ env.mascot }}'
`;

  const CACHE_WORKFLOW = `
name: Cache
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      CACHE_PATH: tmp/cache
    steps:
      - uses: actions/cache@v4
        env:
          CACHE_SUFFIX: abc123
        with:
          path: \${{ env.CACHE_PATH }}
          key: build-\${{ runner.os }}-\${{ env.CACHE_SUFFIX }}
`;

  it("resolves workflow-level env", async () => {
    const filePath = writeWorkflowTree(MASCOT_WORKFLOW);
    const steps = await parseWorkflowSteps(filePath, "windows_job");
    expect((steps[0] as any).Inputs.script).toBe("echo 'Hi Mona'");
  });

  it("resolves step-level env overriding workflow-level env", async () => {
    const filePath = writeWorkflowTree(MASCOT_WORKFLOW);
    const steps = await parseWorkflowSteps(filePath, "windows_job");
    expect((steps[1] as any).Inputs.script).toBe("echo 'Hi Octocat'");
  });

  it("resolves job-level env overriding workflow-level env", async () => {
    const filePath = writeWorkflowTree(MASCOT_WORKFLOW);
    const steps = await parseWorkflowSteps(filePath, "linux_job");
    expect((steps[0] as any).Inputs.script).toBe("echo 'Hi Tux'");
  });

  it("resolves job-level env in action input params", async () => {
    const filePath = writeWorkflowTree(CACHE_WORKFLOW);
    const steps = await parseWorkflowSteps(filePath, "build");
    expect((steps[0] as any).Inputs.path).toBe("tmp/cache");
  });

  it("resolves job-level and step-level env in action input params", async () => {
    const filePath = writeWorkflowTree(CACHE_WORKFLOW);
    const steps = await parseWorkflowSteps(filePath, "build");
    expect((steps[0] as any).Inputs.key).toBe("build-Linux-abc123");
  });

  it("returns empty string for env.* when env var does not exist", async () => {
    const filePath = writeWorkflowTree(`
name: Missing Env
on: [push]
jobs:
  repro:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
        with:
          path: \${{ env.NONEXISTENT }}
          key: my-key
`);
    const steps = await parseWorkflowSteps(filePath, "repro");
    expect((steps[0] as any).Inputs.path).toBe("");
  });

  it("expands env.* in step name:", async () => {
    const filePath = writeWorkflowTree(`
name: Named Step Env
on: [push]
env:
  DEPLOY_TARGET: production
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to \${{ env.DEPLOY_TARGET }}
        run: echo deploying
`);
    const steps = await parseWorkflowSteps(filePath, "deploy");
    expect((steps[0] as any).Name).toBe("Deploy to production");
    expect((steps[0] as any).DisplayName).toBe("Deploy to production");
  });
});

// ─── parseWorkflowSteps with local composite actions ──────────────────────────

describe("parseWorkflowSteps with local actions", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflowTree(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-steps-local-"));
    const workflowDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    const filePath = path.join(workflowDir, "test.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("sets RepositoryType to 'self' for local actions", async () => {
    const filePath = writeWorkflowTree(`
name: Local Action Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/foo
`);
    const steps = await parseWorkflowSteps(filePath, "test");
    const ref = (steps[0] as any).Reference;

    expect(ref.RepositoryType).toBe("self");
    expect(ref.Path).toBe("./.github/actions/foo");
    expect(ref.Name).toBe("");
    expect(ref.Ref).toBe("");
  });

  it("keeps RepositoryType 'GitHub' for remote actions (regression)", async () => {
    const filePath = writeWorkflowTree(`
name: Remote Action Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`);
    const steps = await parseWorkflowSteps(filePath, "test");
    const ref = (steps[0] as any).Reference;

    expect(ref.RepositoryType).toBe("GitHub");
    expect(ref.Name).toBe("actions/checkout");
    expect(ref.Ref).toBe("v4");
    expect(ref.Path).toBe("");
  });

  it("splits deep remote action sub-paths into repository name and path", async () => {
    const filePath = writeWorkflowTree(`
name: Deep Remote Action Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: shunkakinoki/actions/.github/actions/setup-bun@3397de0ac01b638fa41d3b2fb18ece4ee71c08d8
`);
    const steps = await parseWorkflowSteps(filePath, "test");
    const ref = (steps[0] as any).Reference;

    expect(ref.RepositoryType).toBe("GitHub");
    expect(ref.Name).toBe("shunkakinoki/actions");
    expect(ref.Ref).toBe("3397de0ac01b638fa41d3b2fb18ece4ee71c08d8");
    expect(ref.Path).toBe(".github/actions/setup-bun");
  });

  it("passes through with: inputs for local actions", async () => {
    const filePath = writeWorkflowTree(`
name: Local Action Inputs Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/shared-node-cache
        with:
          node-version: "18"
          cache-key: my-cache
`);
    const steps = await parseWorkflowSteps(filePath, "test");
    const inputs = (steps[0] as any).Inputs;

    expect(inputs["node-version"]).toBe("18");
    expect(inputs["cache-key"]).toBe("my-cache");
  });
});

// ─── extractVarRefs & validateVars ────────────────────────────────────────────

import { extractVarRefs, validateVars } from "./workflow-parser.ts";

describe("extractVarRefs", () => {
  // SPEC-V-011: workflow with no var refs returns empty array
  // SPEC-V-014: duplicate refs deduplicate
  // SPEC-V-015: job scoping

  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-var-refs-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  // SPEC-V-011: workflow with no var references → empty array (not an error)
  it("returns empty array when workflow has no vars references", () => {
    const filePath = writeWorkflow(`
name: No Vars
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`);
    expect(extractVarRefs(filePath)).toEqual([]);
  });

  // SPEC-V-014 + basic extraction: extracts unique sorted var names from whole file
  it("extracts unique sorted var names from the whole file", () => {
    const filePath = writeWorkflow(`
name: Vars Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      ENV: \${{ vars.APP_ENV }}
      REGION: \${{ vars.DEPLOY_REGION }}
      DUP: \${{ vars.APP_ENV }}
    steps:
      - run: echo ok
`);
    expect(extractVarRefs(filePath)).toEqual(["APP_ENV", "DEPLOY_REGION"]);
  });

  // SPEC-V-015: job scoping — only extracts refs for the named job
  it("scopes to the specified job when taskName is provided", () => {
    const filePath = writeWorkflow(`
name: Multi Job
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      ENV: \${{ vars.BUILD_ENV }}
    steps:
      - run: echo build
  test:
    runs-on: ubuntu-latest
    env:
      ENV: \${{ vars.TEST_ENV }}
    steps:
      - run: echo test
`);
    expect(extractVarRefs(filePath, "test")).toEqual(["TEST_ENV"]);
    expect(extractVarRefs(filePath, "build")).toEqual(["BUILD_ENV"]);
  });

  // SPEC-V-008: vars refs are not confused with secrets refs
  it("does not return secrets refs as var refs", () => {
    const filePath = writeWorkflow(`
name: Mixed
on: [push]
jobs:
  run:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.API_KEY }}
      ENV: \${{ vars.APP_ENV }}
    steps:
      - run: echo ok
`);
    expect(extractVarRefs(filePath)).toEqual(["APP_ENV"]);
  });
});

describe("validateVars", () => {
  // SPEC-V-002: missing var → error naming the var
  // SPEC-V-011: no var refs → not an error
  // SPEC-V-012: error message names missing vars and tells user how to pass them
  // SPEC-V-013: only missing vars appear in error

  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-validate-vars-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  // SPEC-V-001: all vars present → no error
  it("does not throw when all required vars are present", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  run:
    runs-on: ubuntu-latest
    env:
      ENV: \${{ vars.APP_ENV }}
    steps:
      - run: echo ok
`);
    expect(() => validateVars(filePath, "run", { APP_ENV: "production" })).not.toThrow();
  });

  // SPEC-V-011: workflow with no var refs → not an error even with empty vars map
  it("does not throw when workflow has no vars references", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    expect(() => validateVars(filePath, "run", {})).not.toThrow();
  });

  // SPEC-V-002 + SPEC-V-012: error names missing vars and instructs to pass --var flags
  it("throws listing missing vars and the --var flag syntax", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      HOST: \${{ vars.DB_HOST }}
      PORT: \${{ vars.DB_PORT }}
    steps:
      - run: echo deploy
`);
    expect(() => validateVars(filePath, "deploy", {})).toThrow(/DB_HOST/);
    expect(() => validateVars(filePath, "deploy", {})).toThrow(/DB_PORT/);
    expect(() => validateVars(filePath, "deploy", {})).toThrow(/--var/);
  });

  // SPEC-V-013: only missing vars appear in error — supplied vars are not mentioned
  it("only fails for missing vars, not for ones that are present", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  run:
    runs-on: ubuntu-latest
    env:
      A: \${{ vars.PRESENT_VAR }}
      B: \${{ vars.MISSING_VAR }}
    steps:
      - run: echo ok
`);
    expect(() => validateVars(filePath, "run", { PRESENT_VAR: "value" })).toThrow(/MISSING_VAR/);
    expect(() => validateVars(filePath, "run", { PRESENT_VAR: "value" })).not.toThrow(
      /PRESENT_VAR/,
    );
  });
});

// ─── parseWorkflowSteps env merging (workflow → job → step) ──────────────────────
describe("parseWorkflowSteps env merging", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflowTree(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-env-merge-"));
    const workflowDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    const filePath = path.join(workflowDir, "test.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("propagates job-level env to steps", async () => {
    const filePath = writeWorkflowTree(`
name: Job Env
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      FROM_JOB: job-value
    steps:
      - run: echo hi
`);
    const steps = await parseWorkflowSteps(filePath, "test");
    expect((steps[0] as any).Env).toEqual({ FROM_JOB: "job-value" });
  });

  it("propagates workflow-level env to steps", async () => {
    const filePath = writeWorkflowTree(`
name: Workflow Env
on: [push]
env:
  FROM_WORKFLOW: workflow-value
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    const steps = await parseWorkflowSteps(filePath, "test");
    expect((steps[0] as any).Env).toEqual({ FROM_WORKFLOW: "workflow-value" });
  });

  it("merges workflow + job + step env with step-overrides-job-overrides-workflow precedence", async () => {
    const filePath = writeWorkflowTree(`
name: Precedence
on: [push]
env:
  LEVEL: workflow
  WF_ONLY: workflow
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      LEVEL: job
      JOB_ONLY: job
    steps:
      - env:
          LEVEL: step
          STEP_ONLY: step
        run: echo hi
`);
    const steps = await parseWorkflowSteps(filePath, "test");
    expect((steps[0] as any).Env).toEqual({
      LEVEL: "step",
      WF_ONLY: "workflow",
      JOB_ONLY: "job",
      STEP_ONLY: "step",
    });
  });

  it("expands \\${{ vars.X }} in job-level env", async () => {
    const filePath = writeWorkflowTree(`
name: Vars In Job Env
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      API_URL: \${{ vars.API_URL }}
    steps:
      - run: echo hi
`);
    const vars = { API_URL: "https://api.example.com" };
    const steps = await parseWorkflowSteps(
      filePath,
      "test",
      undefined,
      undefined,
      undefined,
      undefined,
      vars,
    );
    expect((steps[0] as any).Env).toEqual({ API_URL: "https://api.example.com" });
  });

  it("returns undefined Env when no env declared at any level", async () => {
    const filePath = writeWorkflowTree(`
name: No Env
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    const steps = await parseWorkflowSteps(filePath, "test");
    expect((steps[0] as any).Env).toBeUndefined();
  });
});

// ─── parseWorkflowSteps runner context from runs-on (issue #279) ──────────────
describe("parseWorkflowSteps derives runner context from runs-on", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflowTree(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-runner-ctx-"));
    const workflowDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    const filePath = path.join(workflowDir, "test.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("expands runner.os to macOS and runner.arch to ARM64 for macos-14 runs-on", async () => {
    const filePath = writeWorkflowTree(`
name: macOS Build
on: [push]
jobs:
  build:
    runs-on: macos-14
    steps:
      - run: echo "os=\${{ runner.os }} arch=\${{ runner.arch }}"
`);
    const steps = await parseWorkflowSteps(filePath, "build");
    expect((steps[0] as any).Inputs.script).toBe('echo "os=macOS arch=ARM64"');
  });

  it("expands runner.os to Windows for windows-latest runs-on", async () => {
    const filePath = writeWorkflowTree(`
name: Windows Build
on: [push]
jobs:
  build:
    runs-on: windows-latest
    steps:
      - run: echo "\${{ runner.os }}"
`);
    const steps = await parseWorkflowSteps(filePath, "build");
    expect((steps[0] as any).Inputs.script).toBe('echo "Windows"');
  });

  it("defaults to Linux/X64 for ubuntu runs-on (backward compat)", async () => {
    const filePath = writeWorkflowTree(`
name: Linux Build
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "os=\${{ runner.os }} arch=\${{ runner.arch }}"
`);
    const steps = await parseWorkflowSteps(filePath, "build");
    expect((steps[0] as any).Inputs.script).toBe('echo "os=Linux arch=X64"');
  });

  it("expands runner.os in step env for macos-14 runs-on", async () => {
    const filePath = writeWorkflowTree(`
name: macOS Env
on: [push]
jobs:
  build:
    runs-on: macos-14
    steps:
      - env:
          TARGET_OS: \${{ runner.os }}
        run: echo ok
`);
    const steps = await parseWorkflowSteps(filePath, "build");
    expect((steps[0] as any).Env).toEqual({ TARGET_OS: "macOS" });
  });

  it("expands runner.os in step name for self-hosted macos labels", async () => {
    const filePath = writeWorkflowTree(`
name: Self-hosted macOS
on: [push]
jobs:
  build:
    runs-on: [self-hosted, macos, arm64]
    steps:
      - name: On \${{ runner.os }}
        run: echo hi
`);
    const steps = await parseWorkflowSteps(filePath, "build");
    expect((steps[0] as any).Name).toBe("On macOS");
  });
});

import { runnerContextFromRunsOn } from "./workflow-parser.ts";

describe("runnerContextFromRunsOn", () => {
  it("classifies macos-14 to macOS/ARM64", () => {
    expect(runnerContextFromRunsOn(["macos-14"])).toEqual({ os: "macOS", arch: "ARM64" });
  });

  it("classifies macos-latest to macOS/ARM64", () => {
    expect(runnerContextFromRunsOn(["macos-latest"])).toEqual({ os: "macOS", arch: "ARM64" });
  });

  it("classifies windows-latest to Windows/X64", () => {
    expect(runnerContextFromRunsOn(["windows-latest"])).toEqual({ os: "Windows", arch: "X64" });
  });

  it("classifies ubuntu-latest to Linux/X64", () => {
    expect(runnerContextFromRunsOn(["ubuntu-latest"])).toEqual({ os: "Linux", arch: "X64" });
  });

  it("classifies empty labels to Linux/X64 (safe default)", () => {
    expect(runnerContextFromRunsOn([])).toEqual({ os: "Linux", arch: "X64" });
  });

  it("classifies self-hosted+macos+arm64 to macOS/ARM64", () => {
    expect(runnerContextFromRunsOn(["self-hosted", "macos", "arm64"])).toEqual({
      os: "macOS",
      arch: "ARM64",
    });
  });
});

import { parseJobRunsOn } from "./workflow-parser.ts";

describe("parseJobRunsOn", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-runson-test-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("returns a single-element array for a string runs-on", () => {
    const filePath = writeWorkflow(`
name: X
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    expect(parseJobRunsOn(filePath, "build")).toEqual(["ubuntu-latest"]);
  });

  it("returns all labels for an array runs-on", () => {
    const filePath = writeWorkflow(`
name: X
on: [push]
jobs:
  build:
    runs-on: [self-hosted, macos, arm64]
    steps:
      - run: echo ok
`);
    expect(parseJobRunsOn(filePath, "build")).toEqual(["self-hosted", "macos", "arm64"]);
  });

  it("returns labels from the object form (group + labels)", () => {
    const filePath = writeWorkflow(`
name: X
on: [push]
jobs:
  build:
    runs-on:
      group: my-group
      labels: [macos-14, arm64]
    steps:
      - run: echo ok
`);
    expect(parseJobRunsOn(filePath, "build")).toEqual(["macos-14", "arm64"]);
  });

  it("returns an empty array when runs-on is missing", () => {
    const filePath = writeWorkflow(`
name: X
on: [push]
jobs:
  build:
    steps:
      - run: echo ok
`);
    expect(parseJobRunsOn(filePath, "build")).toEqual([]);
  });

  it("returns an empty array when the job does not exist", () => {
    const filePath = writeWorkflow(`
name: X
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    expect(parseJobRunsOn(filePath, "other")).toEqual([]);
  });
});
