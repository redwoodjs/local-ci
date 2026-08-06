#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDefaultMaxConcurrentJobsFromInputs } from "../packages/cli/src/output/concurrency.ts";
import { planFixtureWorkflow } from "../packages/cli/src/workflow/fixture-plan.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = path.join(root, "crates/local-ci/fixtures");
const plansDir = path.join(fixturesRoot, "plans");
const workflowsDir = path.join(fixturesRoot, "workflows");
const eventsDir = path.join(fixturesRoot, "events");
const runResultsDir = path.join(fixturesRoot, "run-results");
const dockerSocketDir = path.join(fixturesRoot, "docker-socket");
const jobLimitsDir = path.join(fixturesRoot, "job-limits");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const planFiles = fixtureFiles(plansDir);

if (planFiles.length < 10) {
  throw new Error(`Expected at least 10 plan fixtures, found ${planFiles.length}`);
}

for (const planFile of planFiles) {
  const expected = readJson(path.join(plansDir, planFile));
  const workflowPath = path.join(workflowsDir, expected.workflow);
  const actual = await planFixtureWorkflow(workflowPath, expected.args ?? {});
  assertJsonEqual(actual, expected.plan, `plan fixture ${planFile}`);
}

const eventFiles = checkEventFixtures();
const runResultFiles = checkRunResultFixtures();
const dockerSocketFiles = checkDockerSocketFixtures();
const jobLimitVectors = checkJobLimitFixtures();

console.log(`✓ ${planFiles.length} TypeScript fixture plan contracts passed`);
console.log(`✓ ${eventFiles} TypeScript fixture event contracts passed`);
console.log(`✓ ${runResultFiles} TypeScript fixture run-result contracts passed`);
console.log(`✓ ${dockerSocketFiles} TypeScript fixture docker-socket contracts passed`);
console.log(`✓ ${jobLimitVectors} TypeScript fixture job-limit contracts passed`);

function fixtureFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();
}

function normalizeEvent(event) {
  const clone = { ...event };
  delete clone.ts;
  delete clone.runId;
  delete clone.durationMs;
  delete clone.logPath;
  delete clone.debugLogPath;
  return clone;
}

function checkEventFixtures() {
  const files = fixtureFiles(eventsDir);
  if (files.length === 0) {
    throw new Error("Expected at least one event fixture");
  }
  for (const file of files) {
    const fixture = readJson(path.join(eventsDir, file));
    const actual = fixture.input.map(normalizeEvent);
    assertJsonEqual(actual, fixture.normalized, `event fixture ${file}`);
  }
  return files.length;
}

function normalizeRunResult(result) {
  const clone = JSON.parse(JSON.stringify(result));
  delete clone.worktreePath;
  delete clone.startedAt;
  delete clone.finishedAt;
  delete clone.headSha;
  for (const job of clone.jobs ?? []) {
    delete job.durationMs;
    delete job.debugLogPath;
    for (const step of job.steps ?? []) {
      delete step.logPath;
    }
  }
  return clone;
}

function checkRunResultFixtures() {
  const files = fixtureFiles(runResultsDir);
  if (files.length === 0) {
    throw new Error("Expected at least one run-result fixture");
  }
  for (const file of files) {
    const fixture = readJson(path.join(runResultsDir, file));
    assertJsonEqual(
      normalizeRunResult(fixture.input),
      fixture.normalized,
      `run-result fixture ${file}`,
    );
  }
  return files.length;
}

function resolveDockerSocket(probe) {
  const envHost = probe.env?.LOCAL_CI_DOCKER_HOST?.trim();
  if (envHost) {
    if (!envHost.startsWith("unix://")) {
      return { socketPath: "", uri: envHost, bindMountPath: "" };
    }
    const socketPath = envHost.slice("unix://".length);
    const resolved = resolveSocketPath(probe, socketPath);
    if (resolved) {
      return { socketPath: resolved, uri: `unix://${resolved}`, bindMountPath: socketPath };
    }
    throw new Error(`LOCAL_CI_DOCKER_HOST=${envHost} does not resolve to a working socket.`);
  }

  if (!pathExists(probe, "/var/run/docker.sock")) {
    throw new Error(
      [
        "/var/run/docker.sock is missing or a dangling symlink",
        dockerDesktopHint(probe),
        "docs/docker-socket.md",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const defaultResolved = resolveSocketPath(probe, "/var/run/docker.sock");
  if (defaultResolved) {
    return {
      socketPath: defaultResolved,
      uri: `unix://${defaultResolved}`,
      bindMountPath: "/var/run/docker.sock",
    };
  }

  const contextHost = probe.dockerContextHost;
  if (contextHost?.startsWith("unix://")) {
    const socketPath = contextHost.slice("unix://".length);
    if (pathExists(probe, socketPath)) {
      return {
        socketPath,
        uri: `unix://${socketPath}`,
        bindMountPath: "/var/run/docker.sock",
      };
    }
  }
  throw new Error("/var/run/docker.sock exists but is not readable\ndocs/docker-socket.md");
}

function pathExists(probe, socketPath) {
  return (probe.existingPaths ?? []).includes(socketPath);
}

function resolveSocketPath(probe, socketPath) {
  const resolved = probe.realpaths?.[socketPath] ?? socketPath;
  return pathExists(probe, socketPath) && (probe.accessiblePaths ?? []).includes(resolved)
    ? resolved
    : undefined;
}

function dockerDesktopHint(probe) {
  const home = probe.home;
  if (home && pathExists(probe, path.join(home, ".docker/run/docker.sock"))) {
    return "Docker Desktop is running but the default socket is disabled";
  }
  return "";
}

function checkDockerSocketFixtures() {
  const files = fixtureFiles(dockerSocketDir);
  if (files.length === 0) {
    throw new Error("Expected at least one docker-socket fixture");
  }
  for (const file of files) {
    const fixture = readJson(path.join(dockerSocketDir, file));
    try {
      const actual = resolveDockerSocket(fixture.probe);
      if (!fixture.expected) {
        throw new Error(`Expected fixture to fail, got ${JSON.stringify(actual)}`);
      }
      assertJsonEqual(actual, fixture.expected, `docker-socket fixture ${file}`);
    } catch (error) {
      if (fixture.expected) {
        throw error;
      }
      for (const expected of fixture.expectedErrorContains ?? []) {
        if (!String(error.message).includes(expected)) {
          throw new Error(
            `docker-socket fixture ${file} error did not contain ${expected}: ${error.message}`,
          );
        }
      }
    }
  }
  return files.length;
}

function checkJobLimitFixtures() {
  const vectors = readJson(path.join(jobLimitsDir, "default-max-concurrent-jobs.json"));
  for (const vector of vectors) {
    const actual = getDefaultMaxConcurrentJobsFromInputs(
      vector.cpuCount,
      vector.dockerAvailableMemoryBytes ?? undefined,
    );
    if (actual !== vector.expected) {
      throw new Error(`job limit fixture mismatch: expected ${vector.expected}, got ${actual}`);
    }
  }
  return vectors.length;
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`Fixture mismatch: ${label}`);
    console.error("Expected:", JSON.stringify(expected, null, 2));
    console.error("Actual:", JSON.stringify(actual, null, 2));
    process.exit(1);
  }
}
