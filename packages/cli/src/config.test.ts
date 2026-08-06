import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyLocalCiEnv,
  config,
  getFirstRemoteUrl,
  loadMachineSecrets,
  parseRepoSlug,
  resolveRepoSlug,
} from "./config.ts";

describe("parseRepoSlug", () => {
  it.each([
    ["https://github.com/redwoodjs/local-ci.git", "redwoodjs/local-ci"],
    ["https://github.com/redwoodjs/local-ci", "redwoodjs/local-ci"],
    ["https://github.com/redwoodjs/local-ci/", "redwoodjs/local-ci"],
    ["git@github.com:redwoodjs/local-ci.git", "redwoodjs/local-ci"],
    ["git@github.com:redwoodjs/local-ci", "redwoodjs/local-ci"],
    ["ssh://git@github.com/redwoodjs/local-ci.git", "redwoodjs/local-ci"],
    ["ssh://git@github.com/redwoodjs/local-ci", "redwoodjs/local-ci"],
    ["ssh://git@github.com:22/redwoodjs/local-ci.git", "redwoodjs/local-ci"],
    ["https://github.example.com/redwoodjs/local-ci.git", "redwoodjs/local-ci"],
    ["git@github.example.com:redwoodjs/local-ci.git", "redwoodjs/local-ci"],
  ])("parses %s → %s", (url, expected) => {
    expect(parseRepoSlug(url)).toBe(expected);
  });

  it("returns null for unparseable URLs", () => {
    expect(parseRepoSlug("not-a-url")).toBeNull();
    expect(parseRepoSlug("")).toBeNull();
  });
});

describe("getFirstRemoteUrl", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns origin URL when origin exists", async () => {
    execSync("git remote add origin https://github.com/test/repo.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    expect(await getFirstRemoteUrl(tmpDir)).toBe("https://github.com/test/repo.git");
  });

  it("falls back to first remote when origin does not exist", async () => {
    execSync("git remote add upstream https://github.com/test/upstream.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    expect(await getFirstRemoteUrl(tmpDir)).toBe("https://github.com/test/upstream.git");
  });

  it("prefers origin over other remotes", async () => {
    execSync("git remote add upstream https://github.com/test/upstream.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    execSync("git remote add origin https://github.com/test/origin.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    expect(await getFirstRemoteUrl(tmpDir)).toBe("https://github.com/test/origin.git");
  });

  it("returns null when no remotes exist", async () => {
    expect(await getFirstRemoteUrl(tmpDir)).toBeNull();
  });

  it("returns null for non-git directory", async () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
    try {
      expect(await getFirstRemoteUrl(nonGitDir)).toBeNull();
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});

describe("resolveRepoSlug", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects owner/repo from remote URL", async () => {
    execSync("git remote add origin https://github.com/acme/widgets.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    expect(await resolveRepoSlug(tmpDir)).toBe("acme/widgets");
  });

  it("detects owner/repo from SSH remote", async () => {
    execSync("git remote add origin git@github.com:acme/widgets.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    expect(await resolveRepoSlug(tmpDir)).toBe("acme/widgets");
  });

  it("throws when no remotes exist and no fallback given", async () => {
    await expect(resolveRepoSlug(tmpDir)).rejects.toThrow(/Could not detect GitHub repository/);
  });

  it("returns fallback when no remotes exist", async () => {
    expect(await resolveRepoSlug(tmpDir, "org/fallback")).toBe("org/fallback");
  });

  it("throws for non-git directory without fallback", async () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
    try {
      await expect(resolveRepoSlug(nonGitDir)).rejects.toThrow(
        /Could not detect GitHub repository/,
      );
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("uses non-origin remote when origin is absent", async () => {
    execSync("git remote add upstream https://github.com/acme/upstream.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    expect(await resolveRepoSlug(tmpDir)).toBe("acme/upstream");
  });
});

describe("GITHUB_REPO env var override priority", () => {
  let tmpDir: string;
  let savedRepo: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    savedRepo = config.GITHUB_REPO;
  });

  afterEach(() => {
    config.GITHUB_REPO = savedRepo;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("env var overrides auto-detection", () => {
    execSync("git remote add origin https://github.com/detected/repo.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    config.GITHUB_REPO = "override/from-env";

    // Replicate cli.ts priority: env var ?? auto-detect
    const result = config.GITHUB_REPO ?? resolveRepoSlug(tmpDir);
    expect(result).toBe("override/from-env");
  });

  it("auto-detects when env var is not set", async () => {
    execSync("git remote add origin https://github.com/detected/repo.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    config.GITHUB_REPO = undefined;

    const result = config.GITHUB_REPO ?? (await resolveRepoSlug(tmpDir));
    expect(result).toBe("detected/repo");
  });

  it("throws when neither env var nor remote is available", async () => {
    config.GITHUB_REPO = undefined;

    await expect(
      (async () => config.GITHUB_REPO ?? (await resolveRepoSlug(tmpDir)))(),
    ).rejects.toThrow(/Could not detect GitHub repository/);
  });
});

// ─── loadMachineSecrets ──────────────────────────────────────────────────────

describe("loadMachineSecrets", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function saveEnv(...keys: string[]) {
    for (const k of keys) {
      savedEnv[k] = process.env[k];
    }
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  function writeEnvFile(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-test-"));
    fs.writeFileSync(path.join(tmpDir, ".env.local-ci"), content);
    return tmpDir;
  }

  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-test-"));
    return tmpDir;
  }

  it("returns empty object when .env.local-ci does not exist", () => {
    const dir = makeTmpDir();
    expect(loadMachineSecrets(dir)).toEqual({});
  });

  it("parses KEY=VALUE pairs from file", () => {
    const dir = writeEnvFile("FOO=bar\nBAZ=qux\n");
    expect(loadMachineSecrets(dir)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("falls back to the legacy .env.agent-ci file", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, ".env.agent-ci"), "LEGACY_TOKEN=legacy\n");

    expect(loadMachineSecrets(dir)).toEqual({ LEGACY_TOKEN: "legacy" });
  });

  it("prefers .env.local-ci when both environment files exist", () => {
    const dir = writeEnvFile("SOURCE=local\n");
    fs.writeFileSync(path.join(dir, ".env.agent-ci"), "SOURCE=legacy\n");

    expect(loadMachineSecrets(dir)).toEqual({ SOURCE: "local" });
  });

  it("fills missing secrets from process.env when envFallbackKeys provided", () => {
    const dir = makeTmpDir();
    saveEnv("TEST_SECRET_ABC");
    process.env.TEST_SECRET_ABC = "from-env";

    const secrets = loadMachineSecrets(dir, ["TEST_SECRET_ABC"]);
    expect(secrets.TEST_SECRET_ABC).toBe("from-env");
  });

  it("file values take precedence over process.env", () => {
    const dir = writeEnvFile("MY_TOKEN=from-file\n");
    saveEnv("MY_TOKEN");
    process.env.MY_TOKEN = "from-env";

    const secrets = loadMachineSecrets(dir, ["MY_TOKEN"]);
    expect(secrets.MY_TOKEN).toBe("from-file");
  });

  it("does not pull from process.env for keys not in envFallbackKeys", () => {
    const dir = makeTmpDir();
    saveEnv("UNRELATED_VAR");
    process.env.UNRELATED_VAR = "should-not-appear";

    const secrets = loadMachineSecrets(dir, ["OTHER_KEY"]);
    expect(secrets.UNRELATED_VAR).toBeUndefined();
    expect(secrets.OTHER_KEY).toBeUndefined();
  });

  it("does not pull from process.env when envFallbackKeys is omitted", () => {
    const dir = makeTmpDir();
    saveEnv("SOME_SECRET");
    process.env.SOME_SECRET = "env-value";

    const secrets = loadMachineSecrets(dir);
    expect(secrets.SOME_SECRET).toBeUndefined();
  });

  it("merges file secrets and env fallbacks", () => {
    const dir = writeEnvFile("FROM_FILE=file-val\n");
    saveEnv("FROM_ENV");
    process.env.FROM_ENV = "env-val";

    const secrets = loadMachineSecrets(dir, ["FROM_FILE", "FROM_ENV"]);
    expect(secrets).toEqual({ FROM_FILE: "file-val", FROM_ENV: "env-val" });
  });
});

// ─── applyLocalCiEnv ─────────────────────────────────────────────────────────

describe("applyLocalCiEnv", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function saveEnv(...keys: string[]) {
    for (const k of keys) {
      savedEnv[k] = process.env[k];
      if (k.startsWith("LOCAL_CI_")) {
        const legacyKey = `AGENT_CI_${k.slice("LOCAL_CI_".length)}`;
        if (!(legacyKey in savedEnv)) {
          savedEnv[legacyKey] = process.env[legacyKey];
        }
        delete process.env[legacyKey];
      }
    }
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    for (const k of Object.keys(savedEnv)) {
      delete savedEnv[k];
    }
  });

  function writeEnvFile(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-env-"));
    fs.writeFileSync(path.join(tmpDir, ".env.local-ci"), content);
    return tmpDir;
  }

  it("does nothing when .env.local-ci is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-env-"));
    tmpDir = dir;
    saveEnv("LOCAL_CI_DOCKER_HOST");
    delete process.env.LOCAL_CI_DOCKER_HOST;

    applyLocalCiEnv(dir);

    expect(process.env.LOCAL_CI_DOCKER_HOST).toBeUndefined();
  });

  it("copies LOCAL_CI_* keys from file into process.env", () => {
    const dir = writeEnvFile(
      "LOCAL_CI_DOCKER_HOST=unix:///tmp/foo.sock\nLOCAL_CI_DTU_HOST=10.0.0.1\n",
    );
    saveEnv("LOCAL_CI_DOCKER_HOST", "LOCAL_CI_DTU_HOST");
    delete process.env.LOCAL_CI_DOCKER_HOST;
    delete process.env.LOCAL_CI_DTU_HOST;

    applyLocalCiEnv(dir);

    expect(process.env.LOCAL_CI_DOCKER_HOST).toBe("unix:///tmp/foo.sock");
    expect(process.env.LOCAL_CI_DTU_HOST).toBe("10.0.0.1");
  });

  it("does not overwrite values already set in process.env", () => {
    const dir = writeEnvFile("LOCAL_CI_DOCKER_HOST=from-file\n");
    saveEnv("LOCAL_CI_DOCKER_HOST");
    process.env.LOCAL_CI_DOCKER_HOST = "from-shell";

    applyLocalCiEnv(dir);

    expect(process.env.LOCAL_CI_DOCKER_HOST).toBe("from-shell");
  });

  it("maps legacy AGENT_CI_* values to LOCAL_CI_*", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-env-"));
    fs.writeFileSync(
      path.join(tmpDir, ".env.agent-ci"),
      "AGENT_CI_DOCKER_HOST=unix:///tmp/legacy.sock\n",
    );
    saveEnv("LOCAL_CI_DOCKER_HOST", "AGENT_CI_DOCKER_HOST");
    delete process.env.LOCAL_CI_DOCKER_HOST;
    delete process.env.AGENT_CI_DOCKER_HOST;

    applyLocalCiEnv(tmpDir);

    expect(process.env.LOCAL_CI_DOCKER_HOST).toBe("unix:///tmp/legacy.sock");
    expect(process.env.AGENT_CI_DOCKER_HOST).toBeUndefined();
  });

  it("prefers a LOCAL_CI_* value over its AGENT_CI_* alias", () => {
    const dir = writeEnvFile("AGENT_CI_DOCKER_HOST=legacy\nLOCAL_CI_DOCKER_HOST=canonical\n");
    saveEnv("LOCAL_CI_DOCKER_HOST", "AGENT_CI_DOCKER_HOST");
    delete process.env.LOCAL_CI_DOCKER_HOST;
    delete process.env.AGENT_CI_DOCKER_HOST;

    applyLocalCiEnv(dir);

    expect(process.env.LOCAL_CI_DOCKER_HOST).toBe("canonical");
  });

  it("ignores keys that do not start with LOCAL_CI_", () => {
    const dir = writeEnvFile("MY_TOKEN=secret\nFOO=bar\nLOCAL_CI_X=y\n");
    saveEnv("MY_TOKEN", "FOO", "LOCAL_CI_X");
    delete process.env.MY_TOKEN;
    delete process.env.FOO;
    delete process.env.LOCAL_CI_X;

    applyLocalCiEnv(dir);

    expect(process.env.MY_TOKEN).toBeUndefined();
    expect(process.env.FOO).toBeUndefined();
    expect(process.env.LOCAL_CI_X).toBe("y");
  });
});
