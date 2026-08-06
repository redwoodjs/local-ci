import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Pinned to the cli package root
export const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

// When running inside a container with Docker-outside-of-Docker (shared socket),
// /tmp is NOT visible to the Docker host. Use a project-relative directory
// so bind mounts resolve correctly on the host.
const isInsideDocker = fs.existsSync("/.dockerenv");

/**
 * Linux + Docker Desktop: `/tmp` is not in Docker Desktop's default shared-folder
 * list (only `$HOME` is shared). Detect this cell and use XDG cache instead.
 * See https://github.com/redwoodjs/local-ci/issues/215
 */
function isLinuxDockerDesktop(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  return fs.existsSync(path.join(os.homedir(), ".docker", "desktop", "docker.sock"));
}

function resolveDefaultWorkingDir(namespace: "local-ci" | "agent-ci"): string {
  const projectSlug = path.basename(PROJECT_ROOT);
  if (isInsideDocker) {
    return path.join(PROJECT_ROOT, `.${namespace}`);
  }
  if (isLinuxDockerDesktop()) {
    const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
    return path.join(xdgCache, namespace, projectSlug);
  }
  return path.join(os.tmpdir(), namespace, projectSlug);
}

export const DEFAULT_WORKING_DIR = resolveDefaultWorkingDir("local-ci");
export const LEGACY_WORKING_DIR = resolveDefaultWorkingDir("agent-ci");

let workingDirectory = DEFAULT_WORKING_DIR;

export function setWorkingDirectory(dir: string): void {
  workingDirectory = dir;
}

export function getWorkingDirectory(): string {
  return workingDirectory;
}
