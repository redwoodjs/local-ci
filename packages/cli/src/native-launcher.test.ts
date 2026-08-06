import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  forcedRustMissingBinaryMessage,
  nativePackageName,
  nativePackageSuffix,
  resolveNativeBinary,
} from "./native-launcher.ts";

describe("native launcher", () => {
  it("maps Node platform/arch pairs to optional native packages", () => {
    expect(nativePackageSuffix("linux", "x64")).toBe("linux-x64");
    expect(nativePackageSuffix("linux", "arm64")).toBe("linux-arm64");
    expect(nativePackageSuffix("darwin", "x64")).toBe("darwin-x64");
    expect(nativePackageSuffix("darwin", "arm64")).toBe("darwin-arm64");
    expect(nativePackageSuffix("win32", "x64")).toBeNull();
    expect(nativePackageName("darwin", "arm64")).toBe("@redwoodjs/local-ci-darwin-arm64");
  });

  it("resolves the binary from the optional platform package", () => {
    const packageJson = path.join("/repo/node_modules/@redwoodjs/local-ci-linux-x64/package.json");

    const resolved = resolveNativeBinary({
      platform: "linux",
      arch: "x64",
      env: { LOCAL_CI_FORCE_RUST: "1" },
      resolvePackageJson: () => packageJson,
      existsSync: (candidate) => candidate.endsWith("/bin/local-ci"),
    });

    expect(resolved).toBe(path.join(path.dirname(packageJson), "bin", "local-ci"));
  });

  it("falls back to a bundled binary path when optional package is absent", () => {
    const resolved = resolveNativeBinary({
      platform: "darwin",
      arch: "arm64",
      env: { LOCAL_CI_FORCE_RUST: "1" },
      launcherDir: "/repo/packages/cli/dist",
      resolvePackageJson: () => {
        throw new Error("missing optional dependency");
      },
      existsSync: (candidate) => candidate === "/repo/packages/cli/native/darwin-arm64/local-ci",
    });

    expect(resolved).toBe("/repo/packages/cli/native/darwin-arm64/local-ci");
  });

  it("defaults to TypeScript while Rust execution parity is incomplete", () => {
    expect(
      resolveNativeBinary({
        platform: "linux",
        arch: "x64",
        resolvePackageJson: () => "/repo/node_modules/@redwoodjs/local-ci-linux-x64/package.json",
        existsSync: () => true,
      }),
    ).toBeNull();
  });

  it("falls back to TypeScript when native execution is disabled or unsupported", () => {
    expect(
      resolveNativeBinary({
        platform: "linux",
        arch: "x64",
        env: { LOCAL_CI_FORCE_TYPESCRIPT: "1", LOCAL_CI_FORCE_RUST: "1" },
        resolvePackageJson: () => "/unused/package.json",
        existsSync: () => true,
      }),
    ).toBeNull();
    expect(
      resolveNativeBinary({
        platform: "win32",
        arch: "x64",
        env: { LOCAL_CI_FORCE_RUST: "1" },
        existsSync: () => true,
      }),
    ).toBeNull();
  });

  it("explains how to recover when forced Rust has no binary", () => {
    expect(forcedRustMissingBinaryMessage("linux", "x64")).toContain(
      "Unset LOCAL_CI_FORCE_RUST to use the TypeScript fallback",
    );
    expect(forcedRustMissingBinaryMessage("linux", "x64")).toContain(
      "@redwoodjs/local-ci-linux-x64",
    );
  });
});
