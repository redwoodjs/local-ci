import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderRunState } from "./state-renderer.ts";
import type { RunState } from "./run-state.ts";

// Freeze time so spinner frames and elapsed times are deterministic.
// Date.now() → 0 → Math.floor(0/80) % 10 → frame index 0 → "⠋"
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "test-run",
    status: "running",
    startedAt: "1970-01-01T00:00:00.000Z",
    workflows: [],
    ...overrides,
  };
}

describe("renderRunState", () => {
  describe("single workflow, single job", () => {
    it("renders boot spinner before timeline appears", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5",
                status: "booting",
                startedAt: "1970-01-01T00:00:00.000Z",
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("ci.yml");
      expect(output).toContain("⠋");
      expect(output).toContain("Starting runner local-ci-5 (0s)");
    });

    it("renders starting-runner node alongside steps once running", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5",
                status: "running",
                startedAt: "1970-01-01T00:00:00.000Z",
                bootDurationMs: 2300,
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 1000 },
                  {
                    name: "Run pnpm check",
                    index: 2,
                    status: "running",
                    startedAt: "1970-01-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("ci.yml");
      expect(output).toContain("Starting runner local-ci-5 (2.3s)");
      expect(output).toContain("test");
      expect(output).toContain("✓ 1. Set up job (1s)");
      expect(output).toContain("⠋ 2. Run pnpm check (0s...)");
    });

    it("renders degraded job state with tag and summary child line", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5",
                status: "running",
                bootDurationMs: 2300,
                classification: "degraded",
                classificationSummary:
                  "job resource hints exceed the available host capacity. Use a larger host or adjust the workflow resource hints to fit the available machine.",
                classificationReasons: ["requestedCpuCount (8) exceeds host cpuCount (4)"],
                steps: [{ name: "Run pnpm check", index: 1, status: "pending" }],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("test [degraded]");
      expect(output).toContain(
        "job resource hints exceed the available host capacity. Use a larger host or adjust the workflow resource hints to fit the available machine.",
      );
      expect(output).toContain("○ 1. Run pnpm check");
    });

    it("renders faithful job state unchanged when classification is absent", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5",
                status: "running",
                startedAt: "1970-01-01T00:00:00.000Z",
                bootDurationMs: 2300,
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 1000 },
                  {
                    name: "Run pnpm check",
                    index: 2,
                    status: "running",
                    startedAt: "1970-01-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      expect(renderRunState(state)).toMatchInlineSnapshot(`
        " ci.yml
         ├── Starting runner local-ci-5 (2.3s)
         └── test
             ├── ✓ 1. Set up job (1s)
             └── ⠋ 2. Run pnpm check (0s...)"
      `);
    });

    it("renders completed steps with tick icons", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "completed",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5",
                status: "completed",
                bootDurationMs: 2000,
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 1000 },
                  { name: "Run tests", index: 2, status: "completed", durationMs: 10000 },
                  { name: "Complete job", index: 3, status: "completed", durationMs: 200 },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("✓ 1. Set up job (1s)");
      expect(output).toContain("✓ 2. Run tests (10s)");
      expect(output).toContain("✓ 3. Complete job (0s)");
    });

    it("renders a failed step with ✗ icon", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "failed",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5",
                status: "failed",
                failedStep: "Run tests",
                bootDurationMs: 1000,
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 500 },
                  { name: "Run tests", index: 2, status: "failed", durationMs: 5000 },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("✓ 1. Set up job (1s)");
      expect(output).toContain("✗ 2. Run tests (5s)");
    });

    it("renders a skipped step with ⊘ icon", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "completed",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5",
                status: "completed",
                bootDurationMs: 1000,
                steps: [
                  { name: "Run tests", index: 1, status: "skipped" },
                  { name: "Complete job", index: 2, status: "completed", durationMs: 100 },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("⊘ 1. Run tests");
    });

    it("renders a pending step with ○ icon", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5",
                status: "running",
                bootDurationMs: 1000,
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 500 },
                  { name: "Run tests", index: 2, status: "pending" },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("○ 2. Run tests");
    });

    it("renders paused step with frozen timer and retry hints", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5",
                status: "paused",
                bootDurationMs: 1000,
                pausedAtStep: "Run tests",
                pausedAtMs: "1970-01-01T00:00:05.000Z", // 5s after epoch
                attempt: 1,
                lastOutputLines: ["Error: assertion failed"],
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 500 },
                  {
                    name: "Run tests",
                    index: 2,
                    status: "paused",
                    startedAt: "1970-01-01T00:00:03.000Z", // 3s after epoch
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // Paused step icon
      expect(output).toContain("⏸ 2. Run tests (2s)"); // 5s - 3s = 2s frozen
      // Retry attempt indicator
      expect(output).toContain("Step failed attempt #1");
      // Trailing retry/abort hints (single-job mode)
      expect(output).toContain("↻ To retry:");
      expect(output).toContain("local-ci retry --runner local-ci-5");
      expect(output).toContain("■ To abort:");
      expect(output).toContain("local-ci abort --runner local-ci-5");
      // Last output lines
      expect(output).toContain("Last output:");
      expect(output).toContain("Error: assertion failed");
    });

    it("renders retrying step with 'retrying' label", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5",
                status: "running",
                bootDurationMs: 1000,
                pausedAtStep: "Run tests", // was paused on this step
                attempt: 1, // has been retried
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 500 },
                  {
                    name: "Run tests",
                    index: 2,
                    status: "running",
                    startedAt: "1970-01-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("retrying");
      expect(output).toContain("Run tests");
    });
  });

  describe("multi-workflow mode", () => {
    it("renders degraded tag in compact job nodes", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "lint",
                runnerId: "local-ci-1-j1",
                status: "running",
                classification: "degraded",
                steps: [],
              },
              {
                id: "test",
                runnerId: "local-ci-1-j2",
                status: "queued",
                steps: [],
              },
            ],
          },
          {
            id: "deploy.yml",
            path: "/repo/.github/workflows/deploy.yml",
            status: "queued",
            jobs: [],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("lint [degraded]");
    });
  });

  describe("multi-job workflow", () => {
    it("collapses completed jobs to a single summary line", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "lint",
                runnerId: "local-ci-5-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
              {
                id: "test",
                runnerId: "local-ci-5-j2",
                status: "running",
                bootDurationMs: 1000,
                steps: [
                  {
                    name: "Run tests",
                    index: 1,
                    status: "running",
                    startedAt: "1970-01-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // Completed job collapsed (includes runner name)
      expect(output).toContain("✓ lint");
      expect(output).toContain("local-ci-5-j1");
      // Running job shows steps
      expect(output).toContain("test");
      expect(output).toContain("local-ci-5-j2");
      expect(output).toContain("⠋ 1. Run tests (0s...)");
      // Does NOT show "Starting runner" for the running job in multi-job mode
      expect(output).not.toContain("Starting runner local-ci-5-j2 (");
    });

    it("shows ✗ icon for failed completed job", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "failed",
            jobs: [
              {
                id: "lint",
                runnerId: "local-ci-5-j1",
                status: "failed",
                failedStep: "Run lint",
                durationMs: 3000,
                steps: [],
              },
              {
                id: "test",
                runnerId: "local-ci-5-j2",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("✗ lint");
      expect(output).toContain("local-ci-5-j1");
    });

    it("shows retry hint as child node in multi-job paused mode", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "lint",
                runnerId: "local-ci-5-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
              {
                id: "test",
                runnerId: "local-ci-5-j2",
                status: "paused",
                pausedAtStep: "Run tests",
                pausedAtMs: "1970-01-01T00:00:05.000Z",
                attempt: 1,
                bootDurationMs: 1000,
                steps: [
                  {
                    name: "Run tests",
                    index: 1,
                    status: "paused",
                    startedAt: "1970-01-01T00:00:03.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // Retry hint is a child node in the tree
      expect(output).toContain("↻ retry: local-ci retry --runner local-ci-5-j2");
      // Trailing "To retry:" / "To abort:" lines also shown in multi-job mode
      expect(output).toContain("↻ To retry:");
      expect(output).toContain("■ To abort:");
    });

    it("shows last output lines for paused job in multi-job mode", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "build",
                runnerId: "local-ci-5-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
              {
                id: "test",
                runnerId: "local-ci-5-j2",
                status: "paused",
                pausedAtStep: "Run tests",
                pausedAtMs: "1970-01-01T00:00:05.000Z",
                attempt: 1,
                lastOutputLines: ["FAIL src/app.test.ts", "  Expected: true", "  Received: false"],
                bootDurationMs: 1000,
                steps: [
                  {
                    name: "Run tests",
                    index: 1,
                    status: "paused",
                    startedAt: "1970-01-01T00:00:03.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("Last output:");
      expect(output).toContain("FAIL src/app.test.ts");
      expect(output).toContain("Expected: true");
      expect(output).toContain("Received: false");
    });
  });

  describe("multi-workflow (--all mode)", () => {
    it("collapses completed workflow to a single line with ✓ and duration", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "completed",
            startedAt: "1970-01-01T00:00:00.000Z",
            completedAt: "1970-01-01T00:00:15.000Z",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5-j1",
                status: "completed",
                durationMs: 15000,
                steps: [],
              },
            ],
          },
          {
            id: "deploy.yml",
            path: "/repo/.github/workflows/deploy.yml",
            status: "running",
            startedAt: "1970-01-01T00:00:00.000Z",
            jobs: [
              {
                id: "deploy",
                runnerId: "local-ci-5-j2",
                status: "booting",
                startedAt: "1970-01-01T00:00:00.000Z",
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // Completed workflow collapsed to one line
      expect(output).toContain("✓ ci.yml (15s)");
      // No individual job details for either workflow
      expect(output).not.toContain("local-ci-5-j1");
      expect(output).not.toContain("local-ci-5-j2");
      // Running workflow is a single line with spinner and booting hint
      expect(output).toContain("⠋ deploy.yml");
      expect(output).toContain("booting");
    });

    it("collapses failed workflow to a single red line with ✗", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "failed",
            startedAt: "1970-01-01T00:00:00.000Z",
            completedAt: "1970-01-01T00:00:10.000Z",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5-j1",
                status: "failed",
                failedStep: "Run tests",
                durationMs: 10000,
                steps: [],
              },
            ],
          },
          {
            id: "lint.yml",
            path: "/repo/.github/workflows/lint.yml",
            status: "completed",
            startedAt: "1970-01-01T00:00:00.000Z",
            completedAt: "1970-01-01T00:00:05.000Z",
            jobs: [
              {
                id: "lint",
                runnerId: "local-ci-6-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // Single-job workflows collapse to one line (no job children)
      expect(output).toContain("✗ ci.yml");
      expect(output).toContain("(10s)");
      expect(output).toContain("✓ lint.yml (5s)");
      expect(output).not.toContain("local-ci-5-j1");
      expect(output).not.toContain("local-ci-6-j1");
    });

    it("keeps completed multi-job workflow expanded to show jobs", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "completed",
            startedAt: "1970-01-01T00:00:00.000Z",
            completedAt: "1970-01-01T00:00:20.000Z",
            jobs: [
              {
                id: "lint",
                runnerId: "local-ci-5-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
              {
                id: "test",
                runnerId: "local-ci-5-j2",
                status: "completed",
                durationMs: 15000,
                steps: [],
              },
            ],
          },
          {
            id: "lint.yml",
            path: "/repo/.github/workflows/lint.yml",
            status: "completed",
            startedAt: "1970-01-01T00:00:00.000Z",
            completedAt: "1970-01-01T00:00:05.000Z",
            jobs: [
              {
                id: "lint",
                runnerId: "local-ci-6-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // Multi-job workflow shows jobs even when completed
      expect(output).toContain("✓ ci.yml (20s)");
      expect(output).toContain("✓ lint.yml (5s)");
      // Individual job names are visible
      expect(output).toContain("✓ lint (5s)");
      expect(output).toContain("✓ test (15s)");
    });

    it("shows queued jobs before workflow has started", () => {
      const state = makeState({
        workflows: [
          {
            id: "cache.yml",
            path: "/repo/.github/workflows/cache.yml",
            status: "queued",
            jobs: [
              {
                id: "install-a",
                runnerId: "local-ci-5-j1",
                status: "queued",
                steps: [],
              },
              {
                id: "install-b",
                runnerId: "local-ci-5-j2",
                status: "queued",
                steps: [],
              },
              {
                id: "install-c",
                runnerId: "local-ci-5-j3",
                status: "queued",
                steps: [],
              },
            ],
          },
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-6-j1",
                status: "running",
                steps: [
                  {
                    name: "Run tests",
                    index: 1,
                    status: "running",
                    startedAt: "1970-01-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // All three queued jobs visible under the queued workflow
      expect(output).toContain("○ cache.yml");
      expect(output).toContain("○ install-a");
      expect(output).toContain("○ install-b");
      expect(output).toContain("○ install-c");
    });

    it("shows queued workflow with ○ icon", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            startedAt: "1970-01-01T00:00:00.000Z",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5-j1",
                status: "running",
                steps: [
                  {
                    name: "Run tests",
                    index: 1,
                    status: "running",
                    startedAt: "1970-01-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          },
          {
            id: "deploy.yml",
            path: "/repo/.github/workflows/deploy.yml",
            status: "queued",
            jobs: [],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("○ deploy.yml");
      // Running workflow shows current step hint inline
      expect(output).toContain("⠋ ci.yml");
      expect(output).toContain('step 1/1 "Run tests" (0s...)');
    });

    it("keeps workflow with paused job expanded (not collapsed)", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5-j1",
                status: "paused",
                pausedAtStep: "Run tests",
                pausedAtMs: "1970-01-01T00:00:05.000Z",
                attempt: 1,
                lastOutputLines: ["Error: test failed"],
                steps: [
                  {
                    name: "Run tests",
                    index: 1,
                    status: "paused",
                    startedAt: "1970-01-01T00:00:03.000Z",
                  },
                ],
              },
            ],
          },
          {
            id: "lint.yml",
            path: "/repo/.github/workflows/lint.yml",
            status: "completed",
            startedAt: "1970-01-01T00:00:00.000Z",
            completedAt: "1970-01-01T00:00:05.000Z",
            jobs: [
              {
                id: "lint",
                runnerId: "local-ci-6-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // Paused workflow stays expanded with spinner
      expect(output).toContain("⠋ ci.yml");
      expect(output).toContain("⏸ 1. Run tests (2s)");
      expect(output).toContain("↻ To retry:");
      // Completed workflow still collapsed
      expect(output).toContain("✓ lint.yml (5s)");
    });

    it("formats workflow duration with minutes for long runs", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "completed",
            startedAt: "1970-01-01T00:00:00.000Z",
            completedAt: "1970-01-01T00:01:25.000Z", // 85 seconds
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5-j1",
                status: "completed",
                durationMs: 85000,
                steps: [],
              },
            ],
          },
          {
            id: "lint.yml",
            path: "/repo/.github/workflows/lint.yml",
            status: "running",
            jobs: [
              {
                id: "lint",
                runnerId: "local-ci-6-j1",
                status: "running",
                steps: [
                  {
                    name: "Lint",
                    index: 1,
                    status: "running",
                    startedAt: "1970-01-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("✓ ci.yml (1m 25s)");
    });

    it("sorts workflows alphabetically", () => {
      const state = makeState({
        workflows: [
          {
            id: "tests.yml",
            path: "/repo/.github/workflows/tests.yml",
            status: "completed",
            startedAt: "1970-01-01T00:00:00.000Z",
            completedAt: "1970-01-01T00:00:10.000Z",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5-j1",
                status: "completed",
                durationMs: 10000,
                steps: [],
              },
            ],
          },
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "completed",
            startedAt: "1970-01-01T00:00:00.000Z",
            completedAt: "1970-01-01T00:00:05.000Z",
            jobs: [
              {
                id: "lint",
                runnerId: "local-ci-6-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      const ciPos = output.indexOf("ci.yml");
      const testsPos = output.indexOf("tests.yml");
      expect(ciPos).toBeLessThan(testsPos);
    });

    it("expands running multi-job workflow to show each job", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            startedAt: "1970-01-01T00:00:00.000Z",
            jobs: [
              {
                id: "lint",
                runnerId: "local-ci-5-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
              {
                id: "test",
                runnerId: "local-ci-5-j2",
                status: "running",
                steps: [
                  { name: "Checkout", index: 1, status: "completed", durationMs: 500 },
                  {
                    name: "Run tests",
                    index: 2,
                    status: "running",
                    startedAt: "1970-01-01T00:00:00.000Z",
                  },
                  { name: "Upload results", index: 3, status: "pending" },
                ],
              },
              {
                id: "build",
                runnerId: "local-ci-5-j3",
                status: "queued",
                steps: [],
              },
            ],
          },
          {
            id: "lint.yml",
            path: "/repo/.github/workflows/lint.yml",
            status: "queued",
            jobs: [],
          },
        ],
      });

      const output = renderRunState(state);
      // Workflow expands with spinner
      expect(output).toContain("⠋ ci.yml");
      // Each job shown as a compact child
      expect(output).toContain("✓ lint (5s)");
      expect(output).toContain('step 2/3 "Run tests" (0s...)');
      expect(output).toContain("○ build");
      // No full step detail (step nodes like "1. Checkout" should not appear)
      expect(output).not.toContain("Checkout");
    });

    it("groups multiple jobs under their respective workflow (single-workflow)", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "completed",
            jobs: [
              {
                id: "lint",
                runnerId: "local-ci-5-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
              {
                id: "test",
                runnerId: "local-ci-5-j2",
                status: "completed",
                durationMs: 10000,
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // Single workflow — no collapsing, no status icon prefix
      expect(output.split("ci.yml").length).toBe(2); // 1 occurrence → 2 parts
      expect(output).toContain("✓ lint");
      expect(output).toContain("local-ci-5-j1");
      expect(output).toContain("✓ test");
      expect(output).toContain("local-ci-5-j2");
    });
  });

  describe("boot spinner in booting phase", () => {
    it("shows elapsed boot time in seconds", () => {
      // Boot started 7 seconds ago in wall clock time
      vi.setSystemTime(7000);
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "local-ci-5",
                status: "booting",
                startedAt: "1970-01-01T00:00:00.000Z", // epoch
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("Starting runner local-ci-5 (7s)");
    });
  });
});
