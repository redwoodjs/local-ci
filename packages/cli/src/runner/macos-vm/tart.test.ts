import { describe, it, expect } from "vitest";
import {
  tartPullArgs,
  tartCloneArgs,
  tartRunArgs,
  tartIpArgs,
  tartStopArgs,
  tartDeleteArgs,
  tartListArgs,
  sshArgs,
  rsyncArgs,
} from "./tart.ts";

describe("tart argv builders", () => {
  it("tartPullArgs", () => {
    expect(tartPullArgs("ghcr.io/cirruslabs/macos-sequoia-xcode:latest")).toEqual([
      "tart",
      ["pull", "ghcr.io/cirruslabs/macos-sequoia-xcode:latest"],
    ]);
  });

  it("tartCloneArgs", () => {
    expect(tartCloneArgs("base", "local-ci-xyz")).toEqual([
      "tart",
      ["clone", "base", "local-ci-xyz"],
    ]);
  });

  it("tartRunArgs defaults to --no-graphics", () => {
    expect(tartRunArgs("vm1")).toEqual(["tart", ["run", "--no-graphics", "vm1"]]);
  });

  it("tartRunArgs can enable graphics", () => {
    expect(tartRunArgs("vm1", { graphics: true })).toEqual(["tart", ["run", "vm1"]]);
  });

  it("tartIpArgs / tartStopArgs / tartDeleteArgs / tartListArgs", () => {
    expect(tartIpArgs("vm1")).toEqual(["tart", ["ip", "vm1"]]);
    expect(tartStopArgs("vm1")).toEqual(["tart", ["stop", "vm1"]]);
    expect(tartDeleteArgs("vm1")).toEqual(["tart", ["delete", "vm1"]]);
    expect(tartListArgs()).toEqual(["tart", ["list", "--format", "json"]]);
  });
});

describe("sshArgs", () => {
  const creds = { user: "admin", password: "admin" };

  it("builds sshpass+ssh argv without a remote command", () => {
    const [cmd, args] = sshArgs("192.168.64.2", creds);
    expect(cmd).toBe("sshpass");
    expect(args).toContain("-p");
    expect(args).toContain("admin");
    expect(args).toContain("ssh");
    expect(args).toContain("admin@192.168.64.2");
    expect(args).toContain("StrictHostKeyChecking=no");
    expect(args).toContain("UserKnownHostsFile=/dev/null");
  });

  it("appends the remote command after host", () => {
    const [, args] = sshArgs("10.0.0.1", creds, ["bash", "-s"]);
    const hostIdx = args.indexOf("admin@10.0.0.1");
    expect(hostIdx).toBeGreaterThan(-1);
    expect(args[hostIdx + 1]).toBe("bash");
    expect(args[hostIdx + 2]).toBe("-s");
  });

  it("sets a short connect timeout so waitForSsh doesn't hang", () => {
    const [, args] = sshArgs("10.0.0.1", creds);
    const idx = args.indexOf("ConnectTimeout=5");
    expect(idx).toBeGreaterThan(-1);
  });
});

describe("rsyncArgs", () => {
  const creds = { user: "admin", password: "secret" };

  it("wires sshpass+ssh into rsync -e", () => {
    const [cmd, args] = rsyncArgs("/src/", "admin@host:/dst/", creds);
    expect(cmd).toBe("rsync");
    expect(args[0]).toBe("-az");
    expect(args[1]).toBe("-e");
    expect(args[2]).toContain("sshpass -p secret ssh");
    expect(args[2]).toContain("StrictHostKeyChecking=no");
    expect(args.at(-2)).toBe("/src/");
    expect(args.at(-1)).toBe("admin@host:/dst/");
  });

  it("threads excludes through", () => {
    const [, args] = rsyncArgs("/s/", "/d/", creds, { exclude: ["node_modules", ".git"] });
    const excludeIndices = args.reduce<number[]>(
      (acc, v, i) => (v === "--exclude" ? [...acc, i] : acc),
      [],
    );
    expect(excludeIndices).toHaveLength(2);
    expect(args[excludeIndices[0] + 1]).toBe("node_modules");
    expect(args[excludeIndices[1] + 1]).toBe(".git");
  });

  it("adds --delete only when requested", () => {
    const [, withoutDel] = rsyncArgs("/s/", "/d/", creds);
    const [, withDel] = rsyncArgs("/s/", "/d/", creds, { delete: true });
    expect(withoutDel).not.toContain("--delete");
    expect(withDel).toContain("--delete");
  });
});
