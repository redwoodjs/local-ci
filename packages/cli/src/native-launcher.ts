#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export interface NativeResolutionOptions {
  platform?: NodeJS.Platform | string;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  resolvePackageJson?: (specifier: string) => string;
  existsSync?: (candidate: string) => boolean;
  launcherDir?: string;
}

export function nativePackageSuffix(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "linux" && (arch === "x64" || arch === "amd64")) {
    return "linux-x64";
  }
  if (platform === "linux" && (arch === "arm64" || arch === "aarch64")) {
    return "linux-arm64";
  }
  if (platform === "darwin" && (arch === "x64" || arch === "amd64")) {
    return "darwin-x64";
  }
  if (platform === "darwin" && (arch === "arm64" || arch === "aarch64")) {
    return "darwin-arm64";
  }
  return null;
}

export function nativePackageName(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const suffix = nativePackageSuffix(platform, arch);
  return suffix ? `@redwoodjs/local-ci-${suffix}` : null;
}

export function isTypeScriptForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.LOCAL_CI_FORCE_TYPESCRIPT === "1" ||
    env.LOCAL_CI_FORCE_TS === "1" ||
    env.AGENT_CI_FORCE_TYPESCRIPT === "1" ||
    env.AGENT_CI_FORCE_TS === "1"
  );
}

export function isRustForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOCAL_CI_FORCE_RUST === "1" || env.AGENT_CI_FORCE_RUST === "1";
}

export function forcedRustMissingBinaryMessage(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const packageName = nativePackageName(platform, arch);
  const packageHint = packageName ? ` Install ${packageName} or build the Rust binary first.` : "";
  return `LOCAL_CI_FORCE_RUST=1 was set, but no native local-ci binary is available for ${platform}/${arch}.${packageHint} Unset LOCAL_CI_FORCE_RUST to use the TypeScript fallback.`;
}

export function resolveNativeBinary(opts: NativeResolutionOptions = {}): string | null {
  const env = opts.env ?? process.env;
  if (isTypeScriptForced(env) || !isRustForced(env)) {
    return null;
  }

  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const suffix = nativePackageSuffix(platform, arch);
  const packageName = suffix ? `@redwoodjs/local-ci-${suffix}` : null;
  const existsSync = opts.existsSync ?? fs.existsSync;
  const resolvePackageJson = opts.resolvePackageJson ?? ((specifier) => require.resolve(specifier));

  if (packageName) {
    try {
      const packageJson = resolvePackageJson(`${packageName}/package.json`);
      const candidate = path.join(path.dirname(packageJson), "bin", "local-ci");
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Optional native package is not installed for this platform. Fall back to TS.
    }
  }

  if (suffix) {
    const launcherDir = opts.launcherDir ?? path.dirname(fileURLToPath(import.meta.url));
    const bundledCandidate = path.resolve(launcherDir, "..", "native", suffix, "local-ci");
    if (existsSync(bundledCandidate)) {
      return bundledCandidate;
    }
  }

  return null;
}

export async function runNativeOrTypeScript(args = process.argv.slice(2)): Promise<void> {
  const nativeBinary = resolveNativeBinary();
  if (!nativeBinary) {
    if (isRustForced() && !isTypeScriptForced()) {
      console.error(forcedRustMissingBinaryMessage());
      process.exitCode = 1;
      return;
    }
    await import("./cli.js");
    return;
  }

  await new Promise<void>((resolve) => {
    const child = spawn(nativeBinary, args, { stdio: "inherit", env: process.env });
    child.on("error", (err) => {
      console.error(`Failed to launch native local-ci binary at ${nativeBinary}: ${err.message}`);
      process.exitCode = 1;
      resolve();
    });
    child.on("close", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  const scriptPath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(scriptPath);
  } catch {
    return path.resolve(argv1) === scriptPath;
  }
}

if (isEntrypoint()) {
  await runNativeOrTypeScript();
}
