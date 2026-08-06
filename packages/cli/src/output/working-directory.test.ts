import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.XDG_CACHE_HOME;
});

// Fresh import each test so module-level DEFAULT_WORKING_DIR is recomputed
async function importFresh() {
  vi.resetModules();
  return import("./working-directory.ts");
}

describe("DEFAULT_WORKING_DIR", () => {
  it("uses /tmp on macOS (not inside Docker)", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(fs, "existsSync").mockReturnValue(false); // not inside Docker, no DD socket

    const { DEFAULT_WORKING_DIR } = await importFresh();

    expect(DEFAULT_WORKING_DIR).toMatch(/^\/.*\/local-ci\//);
    expect(DEFAULT_WORKING_DIR).not.toContain(".cache");
  });

  it("uses /tmp on Linux without Docker Desktop", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "existsSync").mockReturnValue(false); // no /.dockerenv, no DD socket

    const { DEFAULT_WORKING_DIR } = await importFresh();

    expect(DEFAULT_WORKING_DIR).toMatch(/^\/.*\/local-ci\//);
    expect(DEFAULT_WORKING_DIR).not.toContain(".cache");
  });

  it("uses XDG cache on Linux + Docker Desktop (#215)", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const home = os.homedir();
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      // Not inside Docker, but DD socket exists
      return String(p) === path.join(home, ".docker", "desktop", "docker.sock");
    });

    const { DEFAULT_WORKING_DIR } = await importFresh();

    expect(DEFAULT_WORKING_DIR).toContain(path.join(".cache", "local-ci"));
  });

  it("respects XDG_CACHE_HOME on Linux + Docker Desktop", async () => {
    process.env.XDG_CACHE_HOME = "/custom/cache";
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const home = os.homedir();
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p) === path.join(home, ".docker", "desktop", "docker.sock");
    });

    const { DEFAULT_WORKING_DIR } = await importFresh();

    expect(DEFAULT_WORKING_DIR).toMatch(/^\/custom\/cache\/local-ci\//);
  });

  it("uses project-relative dir inside Docker container", async () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p) === "/.dockerenv";
    });

    const { DEFAULT_WORKING_DIR } = await importFresh();

    expect(DEFAULT_WORKING_DIR).toContain(".local-ci");
  });

  it("Docker-inside-Docker takes priority over Linux + Docker Desktop", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const home = os.homedir();
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const s = String(p);
      // Both /.dockerenv AND DD socket exist
      return s === "/.dockerenv" || s === path.join(home, ".docker", "desktop", "docker.sock");
    });

    const { DEFAULT_WORKING_DIR } = await importFresh();

    // Inside Docker wins — uses project-relative .local-ci, not XDG cache
    expect(DEFAULT_WORKING_DIR).toContain(".local-ci");
    expect(DEFAULT_WORKING_DIR).not.toContain(".cache");
  });

  it("does not use XDG cache on macOS even if DD socket exists", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const home = os.homedir();
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      // DD socket exists but we're on macOS — /tmp is shared there
      return String(p) === path.join(home, ".docker", "desktop", "docker.sock");
    });

    const { DEFAULT_WORKING_DIR } = await importFresh();

    expect(DEFAULT_WORKING_DIR).not.toContain(".cache");
  });
});
