import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findPrewarmInstallCandidates,
  formatPrewarmWarning,
  parsePrewarmThroughSpec,
  prewarmDiagnosticEvent,
  prewarmSelectorForCandidates,
  truncateStepsThroughId,
} from "./run.ts";

describe("parsePrewarmThroughSpec", () => {
  it("parses workflow path, job id, and step id", () => {
    expect(parsePrewarmThroughSpec(".github/workflows/ci.yml:test:install")).toEqual({
      workflowPath: ".github/workflows/ci.yml",
      jobId: "test",
      stepId: "install",
    });
  });

  it("allows colons in the workflow portion by splitting from the right", () => {
    expect(parsePrewarmThroughSpec("third-party:workflows/ci.yml:test:install")).toEqual({
      workflowPath: "third-party:workflows/ci.yml",
      jobId: "test",
      stepId: "install",
    });
  });
});

describe("truncateStepsThroughId", () => {
  it("keeps steps through the selected step id", () => {
    const steps = [
      { ContextName: "checkout", Name: "Checkout" },
      { ContextName: "install", Name: "Install" },
      { ContextName: "test", Name: "Test" },
    ];

    expect(truncateStepsThroughId(steps, "install")).toEqual(steps.slice(0, 2));
  });

  it("throws when the selected step id is missing", () => {
    expect(() => truncateStepsThroughId([{ ContextName: "checkout" }], "install")).toThrow(
      "Prewarm step 'install' not found",
    );
  });
});

describe("findPrewarmInstallCandidates", () => {
  function writeWorkflow(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-prewarm-test-"));
    const file = path.join(dir, "ci.yml");
    fs.writeFileSync(file, content);
    return file;
  }

  it("finds first-wave jobs with likely install commands", () => {
    const workflowPath = writeWorkflow(`
name: CI
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: install
        run: pnpm install --frozen-lockfile
  b:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
  later:
    needs: a
    runs-on: ubuntu-latest
    steps:
      - id: install
        run: yarn install
`);

    expect(findPrewarmInstallCandidates(workflowPath)).toEqual([
      {
        workflowPath,
        jobId: "a",
        stepId: "install",
        command: "pnpm install --frozen-lockfile",
      },
      { workflowPath, jobId: "b", stepId: undefined, command: "npm ci" },
    ]);
  });
});

const warningCandidates = [
  {
    workflowPath: ".github/workflows/ci.yml",
    jobId: "test",
    stepId: "install",
    command: "pnpm install",
  },
  {
    workflowPath: ".github/workflows/ci.yml",
    jobId: "lint",
    command: "pnpm install",
  },
];

describe("formatPrewarmWarning", () => {
  it("gives an actionable prewarm command and env setting", () => {
    const warning = formatPrewarmWarning(warningCandidates);

    expect(warning).toContain("2 parallel jobs will start with a cold dependency cache");
    expect(warning).toContain("Each job has private node_modules");
    expect(warning).toContain(
      "local-ci run --all --prewarm-through .github/workflows/ci.yml:test:install",
    );
    expect(warning).toContain("LOCAL_CI_PREWARM_THROUGH=.github/workflows/ci.yml:test:install");
  });
});

describe("prewarmSelectorForCandidates", () => {
  it("prefers a candidate with a real step id", () => {
    expect(prewarmSelectorForCandidates(warningCandidates)).toBe(
      ".github/workflows/ci.yml:test:install",
    );
  });
});

describe("prewarmDiagnosticEvent", () => {
  it("builds a structured agent warning", () => {
    const event = prewarmDiagnosticEvent(warningCandidates);

    expect(event.event).toBe("diagnostic");
    expect(event.level).toBe("warning");
    expect(event.code).toBe("prewarm_recommended");
    expect(event.message).toContain("--prewarm-through .github/workflows/ci.yml:test:install");
    expect(event.details).toMatchObject({
      selector: ".github/workflows/ci.yml:test:install",
      candidateCount: 2,
    });
  });
});
