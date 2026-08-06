import path from "path";
import type { JobResult } from "../output/reporter.ts";

export interface JobError {
  taskName: string;
  message: string;
  originalError: unknown;
}

export function isJobError(error: unknown): error is JobError {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const err = error as Record<string, unknown>;
  return typeof err.taskName === "string";
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

export function createFailedJobResult(
  taskName: string,
  workflowPath: string,
  error: unknown,
): JobResult {
  const errorMessage = isJobError(error) ? error.message : getErrorMessage(error);
  return {
    name: `local-ci-error-${taskName}`,
    workflow: path.basename(workflowPath),
    taskId: taskName,
    succeeded: false,
    durationMs: 0,
    debugLogPath: "",
    failedStep: "[Job startup failed]",
    lastOutputLines: [errorMessage],
  };
}

export function wrapJobError(taskName: string, error: unknown): JobError {
  return {
    taskName,
    message: getErrorMessage(error),
    originalError: error,
  };
}
