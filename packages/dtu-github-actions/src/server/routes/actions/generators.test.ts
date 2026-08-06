import { describe, it, expect } from "vitest";
import { createJobResponse } from "./generators.ts";

describe("createJobResponse", () => {
  const basePayload = {
    id: "1",
    name: "test-job",
    githubRepo: "owner/repo",
    steps: [],
  };

  it("propagates job-level env into Variables", () => {
    const payload = {
      ...basePayload,
      env: { LOCAL_CI_LOCAL: "true", MY_VAR: "hello" },
    };

    const response = createJobResponse("1", payload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);
    const vars = body.Variables;

    expect(vars.LOCAL_CI_LOCAL).toEqual({ Value: "true", IsSecret: false });
    expect(vars.MY_VAR).toEqual({ Value: "hello", IsSecret: false });
  });

  it("propagates job-level env into ContextData.env", () => {
    const payload = {
      ...basePayload,
      env: { LOCAL_CI_LOCAL: "true" },
    };

    const response = createJobResponse("1", payload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);

    // ContextData.env should be a ContextData object with type 2 (mapping)
    expect(body.ContextData.env).toBeDefined();
    expect(body.ContextData.env.t).toBe(2);
    const entries = body.ContextData.env.d;
    const localEntry = entries.find((e: any) => e.k === "LOCAL_CI_LOCAL");
    expect(localEntry).toBeDefined();
    expect(localEntry.v).toEqual({ t: 0, s: "true" });
  });

  it("propagates job-level env into EnvironmentVariables", () => {
    const payload = {
      ...basePayload,
      env: { LOCAL_CI_LOCAL: "true" },
    };

    const response = createJobResponse("1", payload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);

    expect(body.EnvironmentVariables).toHaveLength(1);
    const mapping = body.EnvironmentVariables[0];
    expect(mapping.type).toBe(2);
    const entry = mapping.map.find((e: any) => e.Key === "LOCAL_CI_LOCAL");
    expect(entry).toBeDefined();
    expect(entry.Value).toBe("true");
  });

  it("step-level env overrides job-level env on conflict", () => {
    const payload = {
      ...basePayload,
      env: { SHARED: "from-job" },
      steps: [{ name: "step1", run: "echo hi", Env: { SHARED: "from-step" } }],
    };

    const response = createJobResponse("1", payload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);

    // Variables should have the step-level value (last-write wins)
    expect(body.Variables.SHARED).toEqual({ Value: "from-step", IsSecret: false });

    // ContextData.env should also have the step-level value
    const entries = body.ContextData.env.d;
    const entry = entries.find((e: any) => e.k === "SHARED");
    expect(entry.v).toEqual({ t: 0, s: "from-step" });
  });

  it("includes default_branch in event.repository (issue #241)", () => {
    const payload = {
      ...basePayload,
      repository: {
        full_name: "owner/repo",
        name: "repo",
        owner: { login: "owner" },
        default_branch: "develop",
      },
    };

    const response = createJobResponse("1", payload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);
    const github = body.ContextData.github;

    function findKey(node: any, key: string): any {
      if (node?.t === 2 && Array.isArray(node.d)) {
        const entry = node.d.find((e: any) => e.k === key);
        return entry?.v;
      }
      return undefined;
    }

    const event = findKey(github, "event");
    const repo = findKey(event, "repository");
    const defaultBranch = findKey(repo, "default_branch");

    expect(defaultBranch).toBeDefined();
    expect(defaultBranch).toEqual({ t: 0, s: "develop" });
  });

  it("omits env from ContextData when no env is provided", () => {
    const response = createJobResponse("1", basePayload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);

    expect(body.ContextData.env).toBeUndefined();
    expect(body.EnvironmentVariables).toEqual([]);
  });

  it("defaults to Linux runner layout when runnerOs is not set", () => {
    const response = createJobResponse("1", basePayload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);
    const vars = body.Variables;

    expect(vars.RUNNER_OS.Value).toBe("Linux");
    expect(vars.RUNNER_ARCH.Value).toBe("X64");
    expect(vars.RUNNER_TEMP.Value).toBe("/tmp/runner");
    expect(vars.RUNNER_TOOL_CACHE.Value).toBe("/opt/hostedtoolcache");
    expect(vars.GITHUB_WORKSPACE.Value).toBe("/home/runner/_work/repo/repo");
    expect(body.Workspace.Path).toBe("/home/runner/_work/repo/repo");
  });

  it("uses macOS runner layout when runnerOs is macOS", () => {
    const payload = { ...basePayload, runnerOs: "macOS" as const };
    const response = createJobResponse("1", payload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);
    const vars = body.Variables;

    expect(vars.RUNNER_OS.Value).toBe("macOS");
    expect(vars.RUNNER_ARCH.Value).toBe("ARM64");
    expect(vars.RUNNER_TEMP.Value).toBe("/Users/admin/local-ci-runner/_work/_temp");
    expect(vars.RUNNER_TOOL_CACHE.Value).toBe("/Users/admin/hostedtoolcache");
    expect(vars.GITHUB_WORKSPACE.Value).toBe("/Users/admin/local-ci-runner/_work/repo/repo");
    expect(body.Workspace.Path).toBe("/Users/admin/local-ci-runner/_work/repo/repo");
  });

  it("honors explicit runnerArch override on macOS", () => {
    const payload = { ...basePayload, runnerOs: "macOS" as const, runnerArch: "X64" as const };
    const response = createJobResponse("1", payload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);

    expect(body.Variables.RUNNER_ARCH.Value).toBe("X64");
  });

  it("honors explicit runnerWorkDir override", () => {
    const payload = {
      ...basePayload,
      runnerOs: "macOS" as const,
      runnerWorkDir: "/opt/custom/_work",
    };
    const response = createJobResponse("1", payload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);
    const vars = body.Variables;

    expect(vars.RUNNER_TEMP.Value).toBe("/opt/custom/_work/_temp");
    expect(vars.GITHUB_WORKSPACE.Value).toBe("/opt/custom/_work/repo/repo");
    expect(body.Workspace.Path).toBe("/opt/custom/_work/repo/repo");
  });
});
