# ts-runner — Implementation Plan

TypeScript replacement for the official GitHub Actions runner binary.
Eliminates Docker and the .NET runtime from local-ci's stack.

---

## Goal

Run GitHub Actions workflow `run:` steps and `uses:` actions natively in
a host process (or Agent OS VM), with no Docker containers. Produce the
same outputs, env mutations, and exit codes as the official runner.

---

## Phase 1: Script Steps (MVP) — DONE

Execute `run:` steps with full expression evaluation, env propagation,
output capture, and condition handling.

### What's built

| File                 | Purpose                                                                                                                                                                                                                                                                                                     | Status |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `expressions.ts`     | Full `${{ }}` evaluator — tokenizer, recursive descent parser, AST interpreter. All contexts (github, env, secrets, matrix, steps, needs, runner, job, inputs), all functions (success/failure/always/cancelled, contains, startsWith, endsWith, format, join, toJSON, fromJSON, hashFiles), all operators. | Done   |
| `commands.ts`        | Parses `::` workflow commands from stdout (set-output, error, warning, notice, debug, group, add-mask, stop-commands). Parses file-based commands ($GITHUB_OUTPUT, $GITHUB_ENV, $GITHUB_PATH).                                                                                                              | Done   |
| `step-executor.ts`   | Runs script steps — writes temp files, builds env, spawns shell process, captures outputs. Handles shell selection (bash, sh, pwsh, python, node, custom). Default `if:` condition is `success()`.                                                                                                          | Done   |
| `workflow-parser.ts` | Parses workflow YAML into internal model. Matrix expansion (cartesian product, include/exclude). Job dependency extraction.                                                                                                                                                                                 | Done   |
| `job-runner.ts`      | Runs steps sequentially. Propagates outputs/env/path between steps. Updates expression context after each step.                                                                                                                                                                                             | Done   |
| `runner.ts`          | Top-level orchestrator. Topological sort of jobs into dependency waves. Matrix combo expansion. Job-level `if:` evaluation. Upstream failure skipping. Event callbacks (onJobStart, onJobEnd, onStepStart, onStepEnd).                                                                                      | Done   |
| `types.ts`           | Workflow, Job, Step, StepResult, JobResult, WorkflowResult, RunContext.                                                                                                                                                                                                                                     | Done   |

### Test coverage — 57 tests passing

- Expression evaluator: literals, context access (all 9 contexts), comparisons (case-insensitive strings, numbers), logical operators (&&, ||, !, short-circuit), all functions, complex/nested expressions
- Interpolation: multi-expression strings, non-expression passthrough, unknown context fallback
- Condition evaluation: empty defaults to success(), ${{ }} stripping, failure(), always(), context comparisons
- Workflow parsing: simple workflows, job dependencies, matrix strategy, action steps, step conditions
- End-to-end: echo workflow, GITHUB_OUTPUT capture, step failure + `if: failure()` + default skip, GITHUB_ENV cross-step propagation, job dependency ordering

### What's NOT covered yet

- `uses:` action steps (detected and skipped with warning)
- `continue-on-error` at job level
- `timeout-minutes` at job level (step-level works)
- `services:` and `container:` directives
- Pre/post scripts for actions
- Concurrency limiting for parallel jobs in the same wave
- Secret masking in output (masks are captured but not applied)

---

## Phase 2: JavaScript Actions

Execute `uses:` steps that reference JavaScript actions (e.g. `actions/checkout@v4`).

### Tasks

- [ ] **Action resolver** — Given `owner/repo@ref`, download the action tarball. Two sources:
  - GitHub API (https://api.github.com/repos/{owner}/{repo}/tarball/{ref})
  - DTU cache (reuse existing tarball cache from `packages/dtu-github-actions/cache/`)
  - Cache downloaded tarballs locally to avoid re-downloading
- [ ] **action.yml parser** — Read action metadata:
  - `runs.using` — "node20", "node16", "composite", "docker"
  - `runs.main` — entry point for JS actions
  - `runs.pre` — optional pre-step script
  - `runs.post` — optional post-step script
  - `inputs` — input definitions with defaults
  - `outputs` — output definitions
- [ ] **JS action executor** — Run `node <entry-point>` with:
  - `INPUT_<NAME>` env vars for each input (uppercased)
  - `GITHUB_ACTION_PATH` pointing to extracted action dir
  - All standard `GITHUB_*` env vars
  - File-based command files ($GITHUB_OUTPUT etc.)
  - Working directory set to workspace
- [ ] **Input resolution** — For each action input:
  - Use `with:` value from workflow if provided
  - Fall back to `default:` from action.yml
  - Mark `required: true` inputs that are missing as errors
- [ ] **Pre/post scripts** — Queue `runs.pre` to run before main, `runs.post` to run after all steps (in reverse order)
- [ ] **Built-in action overrides** — Special-case high-frequency actions for local dev:
  - `actions/checkout` → skip (workspace already has the code) or `git clone` from local
  - `actions/setup-node` → check if node is already available, skip if version matches
  - `actions/cache` → no-op (persistent filesystem makes caching less relevant)

- [ ] **Service containers** — Docker-based `services:` support. Steps run on host, services run in Docker.
  - Parse `services:` from workflow YAML (already in workflow-parser.ts)
  - Create Docker containers via dockerode with port mappings published to host
  - Wait for health (HEALTHCHECK or running state, 60s timeout)
  - Inject service connection info into step env (host=localhost, ports from mapping)
  - Cleanup: force-remove containers after all steps complete (or on error)
  - Orphan cleanup: prune stale `ts-runner-svc-*` containers on startup
  - New file: `service-containers.ts`

### Test targets

- Run a workflow with `uses: actions/checkout@v4` + `run: ls` and verify the workspace is intact
- Run a workflow with a simple JS action that sets outputs
- Verify INPUT\_\* env var mapping
- Verify pre/post script execution order
- Start a Postgres service, run a step that connects to `localhost:5432`
- Verify service cleanup after job completion and after job failure

---

## Phase 3: Composite Actions

Execute `uses:` steps that reference composite actions (`runs.using: composite`).

### Tasks

- [ ] **Composite action executor** — Recursively execute steps from action.yml:
  - Parse `runs.steps` from action.yml
  - Each step can be `run:` or `uses:` (recurse)
  - Map parent inputs to child `${{ inputs.name }}` context
  - Map child step outputs to parent action outputs
- [ ] **Scoped context** — Composite actions have their own:
  - `inputs` context (from parent `with:`)
  - `steps` context (local to the composite)
  - But share `github`, `env`, `runner`, etc. with parent

### Test targets

- Composite action with `run:` steps that set outputs
- Nested composite (composite calling composite)
- Input/output mapping between parent and composite

---

## Phase 4: Integration with local-ci CLI

Wire ts-runner as an alternative backend in the existing local-ci CLI,
alongside the current Docker+official-runner path.

### Tasks

- [ ] **CLI flag** — `--runner ts` or `--no-docker` to select ts-runner
- [ ] **Adapter layer** — ts-runner's `runWorkflow()` returns `WorkflowResult`, which needs to map to local-ci's `JobResult` format for reporting
- [ ] **Run state integration** — Feed ts-runner events into `RunStateStore` so the existing TUI/reporter works
- [ ] **Pause-on-failure** — Port the pause/retry mechanism:
  - On step failure, wait for signal (file or IPC)
  - `local-ci retry` syncs workspace and writes retry signal
  - Step re-executes
- [ ] **Secrets** — Pass secrets from `.local-ci.secrets` file into expression context
- [ ] **Warm module caching** — ts-runner doesn't need Docker bind mounts, but should still benefit from npm/pnpm cache dirs
- [ ] **Multi-workflow orchestration** — `--all` flag should work with ts-runner, running relevant workflows with wave scheduling

### Test targets

- Run an existing local-ci test workflow with `--runner ts` and compare output to Docker-based run
- Pause-on-failure + retry cycle with ts-runner
- `--all` with multiple workflows, verify dependency ordering

---

## Phase 5: Agent OS Integration

Run ts-runner inside a RivetKit Agent OS actor. See `experiments/rivetkit-agent-os/README.md` for full design.

### Tasks

- [ ] **Actor definition** — Wrap ts-runner in a Rivet actor with:
  - State: run history, current status
  - Actions: `runCI(workflowPath)`, `retry(jobId)`
  - Events: broadcast step output, job completion
  - Queues: accept CI run requests
- [ ] **Process adapter** — Replace `child_process.spawn` with Agent OS `exec()`/`spawn()` for VM execution
- [ ] **Filesystem adapter** — Use Agent OS persistent filesystem (`/home/user`) instead of temp dirs
- [ ] **Permission gating** — Map local-ci's pause-on-failure to Agent OS's `permissionRequest` events
- [ ] **Durable workflows** — Each job becomes a Rivet workflow step with checkpoint/retry/rollback

### Prerequisites

- Agent OS out of preview (API stability)
- Phases 1-3 complete (ts-runner can handle real workflows)
- Decision on whether ts-runner runs in-VM or as a host tool

---

## Architecture

```
packages/ts-runner/src/
├── index.ts              # Public API exports
├── types.ts              # Workflow, Job, Step, Result types
├── expressions.ts        # ${{ }} expression evaluator (tokenizer + parser + interpreter)
├── commands.ts           # :: workflow commands + file-based commands parser
├── workflow-parser.ts    # YAML → internal model (matrix expansion, dependency extraction)
├── step-executor.ts      # Runs individual steps (script, action)
├── job-runner.ts         # Runs all steps in a job, propagates context
├── runner.ts             # Top-level orchestrator (toposort, matrix, job scheduling)
├── action-resolver.ts       # [Phase 2] Download and cache action tarballs
├── action-executor.ts       # [Phase 2] Run JS/composite actions
├── service-containers.ts    # [Phase 2] Docker service container lifecycle
├── expressions.test.ts      # 47 unit tests
└── runner.test.ts           # 10 integration tests
```

---

## Key Design Decisions

1. **Own expression evaluator, not borrowed.** The `actions/languageservices` parser is designed for IDE tooling (hover, completion), not runtime evaluation. Our evaluator is 380 lines, purpose-built, and fully tested. If edge cases emerge, we fix them directly.

2. **Docker for services only, not for steps.** Steps run on the host (or Agent OS VM). Service containers (`services:`) use Docker because databases and caches need real isolation. Step execution does not. `container:` and Docker actions remain unsupported.

3. **Compatible output format.** `StepResult` and `JobResult` produce the same outputs/env/path mutations as the official runner. A workflow that works with the official runner should produce identical results with ts-runner (for supported step types).

4. **Standalone first, Agent OS second.** ts-runner works without Agent OS. The Agent OS integration (Phase 5) is additive — it wraps ts-runner in an actor for persistence and orchestration, but the core runner doesn't depend on Rivet.

5. **Built-in action overrides for common actions.** Rather than faithfully executing `actions/checkout` (which does a full authenticated git clone), we provide local-optimized implementations that skip unnecessary work. This is a feature, not a limitation — it makes local CI faster.
