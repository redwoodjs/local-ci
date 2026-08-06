/**
 * Reproduction for https://github.com/redwoodjs/local-ci/issues/329
 *
 * On cold boot, `tart ip <name>` hangs until the VM grabs a DHCP lease.
 * runCommand's 5s timeout fires, kills the child, and *rejects* — so getIp's
 * caller (waitForIp) saw a thrown error on the very first iteration and
 * killed the macOS VM job before the 90s budget had a chance to elapse.
 *
 * Fix: getIp swallows the runCommand rejection and returns null so waitForIp
 * keeps polling. This test mocks spawn to emit 'error' (the same code path
 * runCommand takes when the SIGKILL backstop fires) and asserts getIp
 * resolves to null instead of throwing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function makeFakeChild(): EventEmitter & {
  stdout: EventEmitter & { setEncoding: (e: string) => void };
  stderr: EventEmitter & { setEncoding: (e: string) => void };
  stdin: { write: (s: string) => void; end: () => void };
  kill: (signal: string) => void;
} {
  const child = new EventEmitter() as ReturnType<typeof makeFakeChild>;
  const stdout = new EventEmitter() as typeof child.stdout;
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as typeof child.stderr;
  stderr.setEncoding = () => {};
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { write: () => {}, end: () => {} };
  child.kill = () => {};
  return child;
}

describe("issue-329 reproduction: getIp swallows runCommand rejection", () => {
  it("returns null when the underlying spawn errors (cold-boot timeout path)", async () => {
    const child = makeFakeChild();
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);

    const { getIp } = await import("./tart.ts");
    const promise = getIp("local-ci-macos-cold-boot");

    // Same code path runCommand hits when its timer fires and the SIGKILL
    // backstop blows the child away: 'error' propagates as a Promise rejection.
    queueMicrotask(() => child.emit("error", new Error("simulated tart ip timeout")));

    await expect(promise).resolves.toBeNull();
  });

  it("returns null when the underlying spawn exits non-zero", async () => {
    const child = makeFakeChild();
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);

    const { getIp } = await import("./tart.ts");
    const promise = getIp("vm-not-yet-leased");

    queueMicrotask(() => child.emit("close", 1));

    await expect(promise).resolves.toBeNull();
  });

  it("returns the IP on the success path", async () => {
    const child = makeFakeChild();
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);

    const { getIp } = await import("./tart.ts");
    const promise = getIp("vm-ready");

    queueMicrotask(() => {
      child.stdout.emit("data", "192.168.64.42\n");
      child.emit("close", 0);
    });

    await expect(promise).resolves.toBe("192.168.64.42");
  });
});
