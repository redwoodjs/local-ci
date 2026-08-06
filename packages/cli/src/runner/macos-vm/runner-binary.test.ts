import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_MACOS_RUNNER_VERSION,
  macosRunnerTarballUrl,
  resolveMacosRunnerVersion,
} from "./runner-binary.ts";

describe("macosRunnerTarballUrl", () => {
  it("builds the GitHub release URL for the given version", () => {
    expect(macosRunnerTarballUrl("2.331.0")).toBe(
      "https://github.com/actions/runner/releases/download/v2.331.0/actions-runner-osx-arm64-2.331.0.tar.gz",
    );
  });

  it("handles arbitrary version strings (no validation — GitHub 404s on bad versions)", () => {
    expect(macosRunnerTarballUrl("9.9.9")).toContain("v9.9.9");
    expect(macosRunnerTarballUrl("9.9.9")).toContain("actions-runner-osx-arm64-9.9.9.tar.gz");
  });
});

describe("resolveMacosRunnerVersion", () => {
  const ORIG = process.env.LOCAL_CI_MACOS_RUNNER_VERSION;

  beforeEach(() => {
    delete process.env.LOCAL_CI_MACOS_RUNNER_VERSION;
  });
  afterEach(() => {
    if (ORIG === undefined) {
      delete process.env.LOCAL_CI_MACOS_RUNNER_VERSION;
    } else {
      process.env.LOCAL_CI_MACOS_RUNNER_VERSION = ORIG;
    }
  });

  it("falls back to the pinned default when no override is set", () => {
    expect(resolveMacosRunnerVersion()).toBe(DEFAULT_MACOS_RUNNER_VERSION);
  });

  it("honors LOCAL_CI_MACOS_RUNNER_VERSION", () => {
    process.env.LOCAL_CI_MACOS_RUNNER_VERSION = "2.400.0";
    expect(resolveMacosRunnerVersion()).toBe("2.400.0");
  });

  it("trims whitespace from the override", () => {
    process.env.LOCAL_CI_MACOS_RUNNER_VERSION = "  2.400.0  ";
    expect(resolveMacosRunnerVersion()).toBe("2.400.0");
  });
});
