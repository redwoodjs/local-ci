import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { pipeline } from "node:stream/promises";

// Pinned to match the version the DTU pretends to be (see
// packages/dtu-github-actions/src/server/routes/actions/index.ts). Override
// with LOCAL_CI_MACOS_RUNNER_VERSION if you need to test a newer release.
export const DEFAULT_MACOS_RUNNER_VERSION = "2.331.0";

export function resolveMacosRunnerVersion(): string {
  return process.env.LOCAL_CI_MACOS_RUNNER_VERSION?.trim() || DEFAULT_MACOS_RUNNER_VERSION;
}

export function macosRunnerTarballUrl(version: string): string {
  return `https://github.com/actions/runner/releases/download/v${version}/actions-runner-osx-arm64-${version}.tar.gz`;
}

export interface CachedRunner {
  version: string;
  /** Absolute path to the extracted runner directory (contains run.sh etc.). */
  dir: string;
}

// Download + extract the macOS actions-runner tarball for the given version,
// caching the result under <cacheRoot>/<version>/. Subsequent calls for the
// same version return immediately from cache.
export async function ensureMacosRunnerBinary(
  cacheRoot: string,
  version: string = resolveMacosRunnerVersion(),
): Promise<CachedRunner> {
  const dir = path.join(cacheRoot, version);
  const markerFile = path.join(dir, ".extracted");
  const runShExists = fs.existsSync(path.join(dir, "run.sh"));

  if (fs.existsSync(markerFile) && runShExists) {
    return { version, dir };
  }

  await fsp.mkdir(dir, { recursive: true });

  const tarball = path.join(dir, `actions-runner-osx-arm64-${version}.tar.gz`);
  if (!fs.existsSync(tarball)) {
    await downloadToFile(macosRunnerTarballUrl(version), tarball);
  }

  execSync(`tar -xzf ${shellQuote(tarball)} -C ${shellQuote(dir)}`, { stdio: "pipe" });

  // Tarball self-contains run.sh / config.sh / bin/ / externals/. If the shape
  // ever changes we want to notice immediately, not at SSH-exec time.
  if (!fs.existsSync(path.join(dir, "run.sh"))) {
    throw new Error(
      `Extracted runner at ${dir} does not contain run.sh — tarball structure changed?`,
    );
  }

  await fsp.writeFile(markerFile, new Date().toISOString());
  // Keep the tarball around so a corrupt extraction can be recovered without
  // re-downloading. It's ~200MB — the disk cost is negligible next to the
  // 60GB base image.
  return { version, dir };
}

async function downloadToFile(url: string, dst: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  const tmp = dst + ".partial";
  try {
    await pipeline(res.body as unknown as NodeJS.ReadableStream, fs.createWriteStream(tmp));
    await fsp.rename(tmp, dst);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
