import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveMacosVmImage, DEFAULT_MACOS_IMAGE } from "./image-mapping.ts";

const ORIG = process.env.LOCAL_CI_MACOS_VM_IMAGE;

beforeEach(() => {
  delete process.env.LOCAL_CI_MACOS_VM_IMAGE;
});
afterEach(() => {
  if (ORIG === undefined) {
    delete process.env.LOCAL_CI_MACOS_VM_IMAGE;
  } else {
    process.env.LOCAL_CI_MACOS_VM_IMAGE = ORIG;
  }
});

describe("resolveMacosVmImage", () => {
  it("maps macos-14 → sonoma", () => {
    const r = resolveMacosVmImage(["macos-14"]);
    expect(r.exact).toBe(true);
    expect(r.image).toBe("ghcr.io/cirruslabs/macos-sonoma-xcode:latest");
  });

  it("maps macos-13 → ventura, macos-15 → sequoia, macos-26 → tahoe", () => {
    expect(resolveMacosVmImage(["macos-13"]).image).toContain("ventura");
    expect(resolveMacosVmImage(["macos-15"]).image).toContain("sequoia");
    expect(resolveMacosVmImage(["macos-26"]).image).toContain("tahoe");
  });

  it("maps macos-latest and macos aliases", () => {
    expect(resolveMacosVmImage(["macos-latest"]).exact).toBe(true);
    expect(resolveMacosVmImage(["macos"]).exact).toBe(true);
  });

  it("falls back to the default for unknown labels", () => {
    const r = resolveMacosVmImage(["self-hosted", "macos", "arm64", "custom"]);
    // "macos" is a known alias so it still hits exact=true
    expect(r.exact).toBe(true);
  });

  it("returns a non-exact fallback when nothing matches", () => {
    const r = resolveMacosVmImage(["self-hosted", "custom"]);
    expect(r.exact).toBe(false);
    expect(r.image).toBe(DEFAULT_MACOS_IMAGE);
  });

  it("honors LOCAL_CI_MACOS_VM_IMAGE override", () => {
    process.env.LOCAL_CI_MACOS_VM_IMAGE = "ghcr.io/example/custom:1.2.3";
    const r = resolveMacosVmImage(["macos-14"]);
    expect(r.image).toBe("ghcr.io/example/custom:1.2.3");
    expect(r.exact).toBe(true);
    expect(r.matchedLabel).toBeNull();
  });
});
