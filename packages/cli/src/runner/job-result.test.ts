import { describe, it, expect } from "vitest";
import {
  createFailedJobResult,
  wrapJobError,
  isJobError,
  getErrorMessage,
  type JobError,
} from "./job-result.ts";

describe("getErrorMessage", () => {
  it("extracts message from Error object", () => {
    const result = getErrorMessage(new Error("test message"));
    expect(result).toBe("test message");
  });

  it("returns string as-is", () => {
    const result = getErrorMessage("string error");
    expect(result).toBe("string error");
  });

  it("converts other types to string", () => {
    expect(getErrorMessage(123)).toBe("123");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
    expect(getErrorMessage({ code: "ENOENT" })).toBe("[object Object]");
  });
});

describe("isJobError", () => {
  it("returns true for valid JobError", () => {
    const error: JobError = {
      taskName: "test-job",
      message: "something failed",
      originalError: new Error("original"),
    };
    expect(isJobError(error)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isJobError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isJobError(undefined)).toBe(false);
  });

  it("returns false for plain Error", () => {
    expect(isJobError(new Error("test"))).toBe(false);
  });

  it("returns false for object without taskName", () => {
    expect(isJobError({ message: "test" })).toBe(false);
  });
});

describe("wrapJobError", () => {
  it("wraps Error with taskName", () => {
    const original = new Error("original error");
    const wrapped = wrapJobError("my-job", original);

    expect(wrapped.taskName).toBe("my-job");
    expect(wrapped.message).toBe("original error");
    expect(wrapped.originalError).toBe(original);
  });

  it("wraps string error with taskName", () => {
    const wrapped = wrapJobError("my-job", "string error");

    expect(wrapped.taskName).toBe("my-job");
    expect(wrapped.message).toBe("string error");
  });
});

describe("createFailedJobResult", () => {
  it("creates a failed result with error message from Error object", () => {
    const result = createFailedJobResult(
      "setup_job",
      "/path/to/workflow.yml",
      new Error("Missing required secret: API_KEY"),
    );

    expect(result.succeeded).toBe(false);
    expect(result.taskId).toBe("setup_job");
    expect(result.workflow).toBe("workflow.yml");
    expect(result.name).toBe("local-ci-error-setup_job");
    expect(result.failedStep).toBe("[Job startup failed]");
    expect(result.durationMs).toBe(0);
    expect(result.debugLogPath).toBe("");
    expect(result.lastOutputLines).toEqual(["Missing required secret: API_KEY"]);
  });

  it("extracts message from JobError", () => {
    const jobError: JobError = {
      taskName: "wrapped-job",
      message: "wrapped message",
      originalError: new Error("original"),
    };
    const result = createFailedJobResult("test", "workflow.yml", jobError);

    expect(result.lastOutputLines).toEqual(["wrapped message"]);
  });

  it("handles string errors", () => {
    const result = createFailedJobResult(
      "build_job",
      "/home/user/project/.github/workflows/ci.yaml",
      "Container failed to start",
    );

    expect(result.succeeded).toBe(false);
    expect(result.taskId).toBe("build_job");
    expect(result.workflow).toBe("ci.yaml");
    expect(result.lastOutputLines).toEqual(["Container failed to start"]);
  });

  it("handles errors without message property", () => {
    const result = createFailedJobResult("test_job", "workflow.yml", {
      code: "ENOENT",
      path: "/missing/file",
    });

    expect(result.succeeded).toBe(false);
    expect(result.lastOutputLines).toEqual(["[object Object]"]);
  });

  it("handles null/undefined errors", () => {
    const result = createFailedJobResult("job1", "workflow.yml", null);

    expect(result.succeeded).toBe(false);
    expect(result.lastOutputLines).toEqual(["null"]);
  });

  it("extracts basename from full workflow path", () => {
    const result = createFailedJobResult(
      "deploy",
      "/very/long/path/to/.github/workflows/production.yml",
      new Error("Deploy failed"),
    );

    expect(result.workflow).toBe("production.yml");
  });
});
