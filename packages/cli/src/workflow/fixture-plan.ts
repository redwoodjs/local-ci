import fs from "node:fs";
import { parse as parseYaml } from "yaml";

import {
  collapseMatrixToSingle,
  expandMatrixCombinations,
  parseJobOutputDefs,
  parseJobRunsOn,
  parseMatrixDef,
  parseWorkflowContainer,
  parseWorkflowServices,
} from "./workflow-parser.ts";

type FixturePlanJob = {
  id: string;
  runnerName: string;
  target: string;
  needs: string[];
  if: string | null;
  matrix: Record<string, string> | null;
  outputs: string[];
  services: string[];
  container: string | null;
};

export type FixturePlan = {
  jobs: FixturePlanJob[];
  schedule: string[][];
};

export async function planFixtureWorkflow(
  workflowPath: string,
  args: { noMatrix?: boolean } = {},
): Promise<FixturePlan> {
  const yaml = parseYaml(fs.readFileSync(workflowPath, "utf8"));
  const jobIds = Object.keys(yaml?.jobs ?? {}).sort();
  const jobs: FixturePlanJob[] = [];
  let jobNumber = 0;

  for (const jobId of jobIds) {
    const target = targetForJob(workflowPath, jobId, yaml?.jobs?.[jobId]);
    if (target === "unknown") {
      continue;
    }
    jobNumber += 1;
    const matrixDef = await parseMatrixDef(workflowPath, jobId);
    const combos = matrixDef
      ? (args.noMatrix
          ? collapseMatrixToSingle(matrixDef)
          : addMatrixMetadata(expandMatrixCombinations(matrixDef))
        ).map(orderMatrixContext)
      : [null];
    const services = (await parseWorkflowServices(workflowPath, jobId))
      .map((service) => service.name)
      .sort();
    const container = await parseWorkflowContainer(workflowPath, jobId);
    const outputs = Object.keys(parseJobOutputDefs(workflowPath, jobId)).sort();

    combos.forEach((matrix, matrixIndex) => {
      jobs.push({
        id: jobId,
        runnerName: matrix
          ? `local-ci-1-j${jobNumber}-m${matrixIndex + 1}`
          : `local-ci-1-j${jobNumber}`,
        target,
        needs: parseNeeds(yaml?.jobs?.[jobId]?.needs),
        if: rawJobIf(workflowPath, jobId),
        matrix,
        outputs,
        services,
        container: container?.image ?? null,
      });
    });
  }

  return { jobs, schedule: scheduleJobWaves(jobs) };
}

function orderMatrixContext(context: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(context).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function addMatrixMetadata(combos: Record<string, string>[]): Record<string, string>[] {
  const total = String(combos.length);
  return combos.map((combo, index) => ({
    __job_total: total,
    __job_index: String(index),
    ...combo,
  }));
}

function rawJobIf(workflowPath: string, jobId: string): string | null {
  const yaml = parseYaml(fs.readFileSync(workflowPath, "utf8"));
  const raw = yaml?.jobs?.[jobId]?.if;
  if (raw == null) {
    return null;
  }
  return String(raw);
}

function targetForJob(workflowPath: string, jobId: string, job: any): string {
  if (job?.uses) {
    return `reusable:${job.uses}`;
  }
  const runsOn = parseJobRunsOn(workflowPath, jobId).join(", ");
  if (!runsOn) {
    return "unknown";
  }
  return runsOn.toLowerCase().includes("macos") ? `macos:${runsOn}` : `linux:${runsOn}`;
}

function parseNeeds(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return [String(value)];
}

function scheduleKey(job: FixturePlanJob): string {
  return job.matrix ? job.runnerName : job.id;
}

function scheduleJobWaves(jobs: FixturePlanJob[]): string[][] {
  const expandedById = new Map<string, string[]>();
  for (const job of jobs) {
    if (!expandedById.has(job.id)) {
      expandedById.set(job.id, []);
    }
    expandedById.get(job.id)?.push(scheduleKey(job));
  }

  const remaining = new Map(
    jobs.map((job) => [
      scheduleKey(job),
      job.needs.flatMap((need) => expandedById.get(need) ?? [need]),
    ]),
  );
  const completed = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining.entries()]
      .filter(([, needs]) => needs.every((need) => completed.has(need)))
      .map(([key]) => key);
    if (wave.length === 0) {
      waves.push([...remaining.keys()]);
      break;
    }
    for (const key of wave) {
      remaining.delete(key);
      completed.add(key);
    }
    waves.push(wave);
  }
  return waves;
}
