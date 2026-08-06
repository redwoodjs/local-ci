import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./output/working-directory.ts";

const execFileP = promisify(execFile);

/**
 * Get the URL of the first git remote, preferring 'origin'.
 * Uses `git remote get-url` which is scoped to the repo (unlike `git config`
 * which can leak values from global/system config on CI runners).
 */
export async function getFirstRemoteUrl(cwd: string): Promise<string | null> {
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileP("git", args, { cwd, encoding: "utf-8" });
    return stdout.trim();
  };
  try {
    return (await git("remote", "get-url", "origin")) || null;
  } catch {
    // origin doesn't exist — fall back to the first listed remote
    try {
      const firstName = (await git("remote")).split("\n")[0];
      if (firstName) {
        return (await git("remote", "get-url", firstName)) || null;
      }
    } catch {}
  }
  return null;
}

/**
 * Extract `owner/repo` from a git remote URL.
 * Handles HTTPS, SSH (git@), and ssh:// URLs, with or without `.git` suffix.
 */
export function parseRepoSlug(remoteUrl: string): string | null {
  const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}

/**
 * Detect `owner/repo` from the git remote in the given directory.
 * Throws if detection fails and no fallback is provided.
 */
export async function resolveRepoSlug(cwd: string, fallback?: string): Promise<string> {
  const remoteUrl = await getFirstRemoteUrl(cwd);
  if (remoteUrl) {
    const slug = parseRepoSlug(remoteUrl);
    if (slug) {
      return slug;
    }
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(
    `Could not detect GitHub repository from git remotes in ${cwd}. ` +
      `Set the GITHUB_REPO environment variable (e.g. GITHUB_REPO=owner/repo).`,
  );
}

export const config: {
  GITHUB_REPO: string | undefined;
  GITHUB_API_URL: string;
} = {
  GITHUB_REPO: process.env.GITHUB_REPO,
  GITHUB_API_URL: process.env.GITHUB_API_URL || "http://localhost:8910",
};

function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) {
    return result;
  }
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  for (const line of lines) {
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
      result[key] = value;
    }
  }
  return result;
}

export const LOCAL_ENV_FILENAME = ".env.local-ci";
export const LEGACY_ENV_FILENAME = ".env.agent-ci";
const LOCAL_ENV_PREFIX = "LOCAL_CI_";
const LEGACY_ENV_PREFIX = "AGENT_CI_";

/** Prefer the Local CI config file, falling back to Agent CI for compatibility. */
export function resolveMachineEnvPath(baseDir?: string): string {
  const root = baseDir ?? PROJECT_ROOT;
  const localPath = path.join(root, LOCAL_ENV_FILENAME);
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  return path.join(root, LEGACY_ENV_FILENAME);
}

function canonicalEnvKey(key: string): string | null {
  if (key.startsWith(LOCAL_ENV_PREFIX)) {
    return key;
  }
  if (key.startsWith(LEGACY_ENV_PREFIX)) {
    return `${LOCAL_ENV_PREFIX}${key.slice(LEGACY_ENV_PREFIX.length)}`;
  }
  return null;
}

/**
 * Load machine-local secrets from `.env.local-ci`, or legacy `.env.agent-ci`.
 * Shell environment variables act as fallbacks for workflow secret values.
 */
export function loadMachineSecrets(
  baseDir?: string,
  envFallbackKeys?: string[],
): Record<string, string> {
  const secrets = parseEnvFile(resolveMachineEnvPath(baseDir));
  if (envFallbackKeys) {
    for (const key of envFallbackKeys) {
      if (!secrets[key] && process.env[key]) {
        secrets[key] = process.env[key]!;
      }
    }
  }
  return secrets;
}

/**
 * Apply Local CI configuration to `process.env` before command modules load.
 * New `LOCAL_CI_*` names win; legacy `AGENT_CI_*` names remain aliases.
 * Shell values win over either config file.
 */
export function applyLocalCiEnv(baseDir?: string): void {
  for (const [key, value] of Object.entries(process.env)) {
    const canonical = canonicalEnvKey(key);
    if (
      canonical &&
      canonical !== key &&
      process.env[canonical] === undefined &&
      value !== undefined
    ) {
      process.env[canonical] = value;
    }
  }

  const parsed = parseEnvFile(resolveMachineEnvPath(baseDir));
  // Apply canonical file keys before legacy aliases so file order cannot make
  // AGENT_CI_* override its LOCAL_CI_* replacement.
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith(LOCAL_ENV_PREFIX) && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(parsed)) {
    const canonical = canonicalEnvKey(key);
    if (!canonical || process.env[canonical] !== undefined) {
      continue;
    }
    process.env[canonical] = value;
  }
}
