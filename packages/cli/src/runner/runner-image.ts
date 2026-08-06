import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type Docker from "dockerode";
import { ensureImagePulled } from "../docker/image-pull.ts";
import { debugRunner } from "../output/debug.ts";

export const UPSTREAM_RUNNER_IMAGE = "ghcr.io/actions/actions-runner:latest";

export type RunnerImageSource = "env" | "dockerfile-dir" | "dockerfile-file" | "default";

export interface ResolvedRunnerImage {
  image: string;
  source: RunnerImageSource;
  sourceLabel: string;
  needsBuild: boolean;
  dockerfilePath?: string;
  contextDir?: string;
}

/**
 * Discover which runner image to use for a repo.
 *
 * Resolution order (highest wins):
 *   1. LOCAL_CI_RUNNER_IMAGE env var
 *   2. <repoRoot>/.github/local-ci/Dockerfile — directory form (supports COPY)
 *   3. <repoRoot>/.github/local-ci.Dockerfile — simple form (empty context)
 *   4. Fallback: ghcr.io/actions/actions-runner:latest
 */
export function discoverRunnerImage(repoRoot: string): ResolvedRunnerImage {
  const envImage = process.env.LOCAL_CI_RUNNER_IMAGE?.trim();
  if (envImage) {
    return {
      image: envImage,
      source: "env",
      sourceLabel: "LOCAL_CI_RUNNER_IMAGE",
      needsBuild: false,
    };
  }

  const dirDockerfile = path.join(repoRoot, ".github", "local-ci", "Dockerfile");
  if (fs.existsSync(dirDockerfile)) {
    const contextDir = path.dirname(dirDockerfile);
    const hash = hashDockerfileAndContext(dirDockerfile, contextDir);
    return {
      image: `local-ci-runner:${hash}`,
      source: "dockerfile-dir",
      sourceLabel: path.relative(repoRoot, dirDockerfile),
      needsBuild: true,
      dockerfilePath: dirDockerfile,
      contextDir,
    };
  }

  const simpleDockerfile = path.join(repoRoot, ".github", "local-ci.Dockerfile");
  if (fs.existsSync(simpleDockerfile)) {
    const hash = hashFile(simpleDockerfile);
    return {
      image: `local-ci-runner:${hash}`,
      source: "dockerfile-file",
      sourceLabel: path.relative(repoRoot, simpleDockerfile),
      needsBuild: true,
      dockerfilePath: simpleDockerfile,
    };
  }

  const legacyDirDockerfile = path.join(repoRoot, ".github", "agent-ci", "Dockerfile");
  if (fs.existsSync(legacyDirDockerfile)) {
    const contextDir = path.dirname(legacyDirDockerfile);
    const hash = hashDockerfileAndContext(legacyDirDockerfile, contextDir);
    return {
      image: `local-ci-runner:${hash}`,
      source: "dockerfile-dir",
      sourceLabel: path.relative(repoRoot, legacyDirDockerfile),
      needsBuild: true,
      dockerfilePath: legacyDirDockerfile,
      contextDir,
    };
  }

  const legacySimpleDockerfile = path.join(repoRoot, ".github", "agent-ci.Dockerfile");
  if (fs.existsSync(legacySimpleDockerfile)) {
    const hash = hashFile(legacySimpleDockerfile);
    return {
      image: `local-ci-runner:${hash}`,
      source: "dockerfile-file",
      sourceLabel: path.relative(repoRoot, legacySimpleDockerfile),
      needsBuild: true,
      dockerfilePath: legacySimpleDockerfile,
    };
  }

  return {
    image: UPSTREAM_RUNNER_IMAGE,
    source: "default",
    sourceLabel: "built-in default",
    needsBuild: false,
  };
}

function hashFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
}

function hashDockerfileAndContext(dockerfilePath: string, contextDir: string): string {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(dockerfilePath));
  const entries: string[] = [];
  walk(contextDir, contextDir, entries);
  entries.sort();
  for (const rel of entries) {
    h.update("\0");
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(contextDir, rel)));
  }
  return h.digest("hex").slice(0, 12);
}

function walk(base: string, dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(base, full, out);
    } else if (e.isFile()) {
      out.push(path.relative(base, full));
    }
  }
}

// Serialize concurrent builds of the same tag so parallel jobs don't race.
const buildPromises = new Map<string, Promise<string>>();

/**
 * Ensure the runner image is ready to use. For `needsBuild: false` images,
 * this pulls if absent. For Dockerfile-based images, this checks the local
 * hash tag and runs `docker build` if missing. Returns the image tag to use
 * for `createContainer`.
 */
export async function ensureRunnerImage(
  docker: Docker,
  resolved: ResolvedRunnerImage,
): Promise<string> {
  if (!resolved.needsBuild) {
    await ensureImagePulled(docker, resolved.image);
    return resolved.image;
  }

  const cached = buildPromises.get(resolved.image);
  if (cached) {
    return cached;
  }

  const promise = buildIfMissing(docker, resolved);
  buildPromises.set(resolved.image, promise);
  try {
    return await promise;
  } catch (err) {
    buildPromises.delete(resolved.image);
    throw err;
  }
}

async function buildIfMissing(docker: Docker, resolved: ResolvedRunnerImage): Promise<string> {
  try {
    await docker.getImage(resolved.image).inspect();
    debugRunner(`Runner image ${resolved.image} is cached`);
    return resolved.image;
  } catch {
    // Not built yet — fall through
  }

  // The user's Dockerfile likely inherits FROM the upstream runner. Pull it
  // first so `docker build` doesn't need to resolve it on its own (faster
  // when it's already cached, identical otherwise).
  await ensureImagePulled(docker, UPSTREAM_RUNNER_IMAGE);

  // Announce the build to stderr so users know why the first run is slow.
  // Written to stderr (not the log-update buffer on stdout) so the spinner
  // can't clobber it, and it stays in the scrollback after the build ends.
  process.stderr.write(
    `\nBuilding runner image from ${resolved.sourceLabel}...\n` +
      `  Tag: ${resolved.image}\n` +
      `  First run is slow (~60s) while the image cache is built.\n` +
      `  Subsequent runs reuse the cached image and take ~0s.\n\n`,
  );
  debugRunner(`Building runner image ${resolved.image} from ${resolved.sourceLabel}...`);

  const { execSync } = await import("node:child_process");
  try {
    if (resolved.contextDir) {
      execSync(
        `docker build -t ${shellQuote(resolved.image)} -f ${shellQuote(resolved.dockerfilePath!)} ${shellQuote(resolved.contextDir)}`,
        { stdio: "pipe" },
      );
    } else {
      execSync(`docker build -t ${shellQuote(resolved.image)} -`, {
        input: fs.readFileSync(resolved.dockerfilePath!),
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const stderr = e.stderr?.toString() ?? "";
    const stdout = e.stdout?.toString() ?? "";
    throw new Error(
      `Failed to build runner image from ${resolved.sourceLabel}:\n\n${stdout}${stderr}${e.message ?? ""}`,
    );
  }

  return resolved.image;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─── Error-hint heuristic ────────────────────────────────────────────────────

/** Generic "command not found" — captures the tool name. */
const COMMAND_NOT_FOUND_RE =
  /\b([\w.+-]+):\s*(?:command )?not found|linker [`'"]?([\w.+-]+)[`'"]? not found|you do not have '([\w.+-]+)' installed/i;

/**
 * Scan failure output for "command not found" patterns and return a hint the
 * reporter can print. Returns null if nothing matches OR if the user is already
 * on a custom runner image (in which case we'd just be nagging).
 */
export function detectMissingToolHint(
  errorContent: string,
  resolved: ResolvedRunnerImage,
): string | null {
  if (resolved.source !== "default") {
    return null;
  }
  const m = COMMAND_NOT_FOUND_RE.exec(errorContent);
  if (!m) {
    return null;
  }
  const tool = m[1] ?? m[2] ?? m[3];
  return formatHint(tool);
}

function formatHint(tool: string): string {
  return [
    `Hint: \`${tool}\` is not in local-ci's default runner image.`,
    ``,
    `The default image (ghcr.io/actions/actions-runner:latest) is a minimal`,
    `container and does not ship system build tools — unlike GitHub's hosted`,
    `ubuntu-latest, which is a full VM image that is not published as a`,
    `container and cannot be pulled.`,
    ``,
    `To fix this, create a .github/local-ci.Dockerfile in your repo that`,
    `installs the missing tool. See the runner image docs for recipes:`,
    `https://github.com/redwoodjs/local-ci/blob/main/packages/cli/runner-image.md`,
  ].join("\n");
}

// ─── Toolcache permission-denied hint ─────────────────────────────────────────

// tar prints lines like `tar: bin/npm: Cannot open: Permission denied` when it
// cannot overwrite a file left behind by an earlier run. Our hostedtoolcache
// bind mount persists across runs, and if a previous run wrote files as a
// different uid the current one can't replace them. See issue #171.
const TAR_PERMISSION_DENIED_RE = /tar: .+: Cannot open: Permission denied/;

/**
 * Detect tar-extraction permission failures under `/opt/hostedtoolcache` and
 * return a hint pointing the user at the host-side toolcache directory to
 * remove. Returns null if the failure doesn't match.
 */
export function detectToolcacheHint(
  errorContent: string,
  toolCacheDir: string | undefined,
): string | null {
  if (!toolCacheDir) {
    return null;
  }
  if (!TAR_PERMISSION_DENIED_RE.test(errorContent)) {
    return null;
  }
  return [
    `Hint: extraction under /opt/hostedtoolcache failed because files from a`,
    `previous run are owned by a user this run can't overwrite. Delete the`,
    `host-side toolcache and re-run:`,
    ``,
    `    sudo rm -rf ${shellQuote(toolCacheDir)}`,
  ].join("\n");
}

// Test-only: reset the build-promise cache between tests
export function __test_resetBuildCache(): void {
  buildPromises.clear();
}
