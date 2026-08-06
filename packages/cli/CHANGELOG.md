# Local CI

## 0.18.0

### Minor Changes

- 417bd26: Rename Agent CI to Local CI. The canonical package is now `run-local-ci` and the canonical executable is `local-ci`. The old `@redwoodjs/agent-ci` package forwards to Local CI, while `AGENT_CI_*`, `.env.agent-ci`, and `.github/agent-ci*` remain supported compatibility aliases throughout the `0.x` release line.
- 417bd26: Support private job and service container images with workflow registry credentials, and reuse images that are already cached locally. Refs #384.

### Patch Changes

- Updated dependencies [417bd26]
- Updated dependencies [417bd26]
  - dtu-github-actions@0.18.0

## 0.17.1

### Patch Changes

- 9ec9d45: Refs #378. Give every job private writable `node_modules`, keep npm installs private while sharing npm's download cache, and atomically publish completed pnpm, Yarn, and Bun dependency trees as lockfile-keyed snapshots that are copied into each job with copy-on-write when available.
- Updated dependencies [9ec9d45]
  - dtu-github-actions@0.17.1

## 0.17.0

### Minor Changes

- 7a349fd: Add the Rust Agent CI runner implementation for source-checkout parity testing while keeping the published npm package on the TypeScript runner path. From a repository checkout, `AGENT_CI_FORCE_RUST=1 pnpm agent-ci-dev ...` builds and runs the Rust binary; published npm installs do not include a native runner yet. The Rust runner now honors `--jobs` for concurrent dependency-wave execution, macOS VM execution honors `AGENT_CI_MACOS_VM_CONCURRENCY`, nested local runs avoid container-name collisions, smoke benchmarks compare TypeScript and Rust orchestration overhead, shared TypeScript/Rust fixture contracts cover scheduler, event, run-result, Docker socket, and default job-limit parity, pure workflow planning plus reusable workflow expansion and event/result contracts now live in `agent-ci-core`, the generic job-wave pool and execution-plan adapters live in `agent-ci-runtime`, `--all` has Rust smoke coverage and workflow fan-out, and the Rust implementation is split into core and runtime crates with focused run, DTU, expression, Docker, runner, and macOS VM modules.

  Native npm platform-package publishing and npm-launcher native opt-in are intentionally deferred until the release workflow builds, stages, and verifies real target binaries in the same artifact-staging style used by `redwoodjs/machinen`.

### Patch Changes

- 928fb44: Refs #370. Add `agent-ci run --prewarm-through <workflow:job:step-id>` and `AGENT_CI_PREWARM_THROUGH` so a disposable job can warm shared `node_modules` through an explicit workflow step before parallel jobs begin. Agent CI now warns with an actionable prewarm command when cold parallel install jobs look likely, including a structured `diagnostic` event in `--json` mode.
- 06fa6e6: Harden the ephemeral DTU control plane: require a cryptographically secure, in-process control token for seed/start-runner/dump endpoints (including trailing-slash routes), fail closed when secure randomness is unavailable, and reject runner log paths that escape the run log root through symlinks. Also remove shell execution from compare handling and update vulnerable dependencies, including the unpatched `decompress` transitive dependency.
- c331673: Harden the opt-in Rust runner orchestration for matrix needs, reusable workflow expansion and outputs, partial wave failures, cyclic dependency planning errors, pull request branch filters, detached pause handling, nested ephemeral DTU host/network resolution, cleanup of nested containers attached to Rust job networks, and the expanded Rust smoke parity gate with per-workflow diagnostics, heartbeats, status ledgers, and timeout cleanup.

  Refs #367.

- Updated dependencies [37a094e]
- Updated dependencies [06fa6e6]
  - dtu-github-actions@0.17.0

## 0.16.2

### Patch Changes

- b619fc7: Avoid reusing runner numbers while stable log directories still exist, and clear stale per-run timeline/log artifacts when a runner name is reused, so old `timeline.json` records cannot be merged into a fresh run and reported as a false failure.

  Refs #341.

- Updated dependencies [b619fc7]
  - dtu-github-actions@0.16.2

## 0.16.1

### Patch Changes

- 412d672: Fix remote actions referenced through deep sub-paths (for example `owner/repo/.github/actions/name@ref`) by passing the parent repository and action path separately to the runner.

  Refs #362.

- Updated dependencies [412d672]
  - dtu-github-actions@0.16.1

## 0.16.0

### Minor Changes

- c8da13a: Add `agent-ci run --var-file <path|->` for loading workflow variables from JSON files or GitHub CLI `gh variable list --json name,value` output piped on stdin. Explicit `--var KEY=VALUE` flags override file-provided values.

  Refs #358.

- ab075d9: chore: require Node 24 and drop `tsx`

  Node 24 ships native TypeScript stripping as a stable feature, so we no
  longer need the `tsx` runtime to execute `.ts` files. Every `tsx foo.ts`
  invocation in package scripts becomes `node foo.ts`. `tsx` is removed
  from `devDependencies` in every workspace.

  To make this work with the codebase's existing import convention,
  TypeScript is configured to emit `.js` paths in built output while
  allowing source files to use real `.ts` extensions:
  - `allowImportingTsExtensions: true`
  - `rewriteRelativeImportExtensions: true`

  All 72 source files have been mechanically updated: every relative
  import that previously said `from "./foo.js"` now says
  `from "./foo.ts"`. The compiled `dist/` output still emits the `.js`
  extension, so consumers see no change.

  Breaking change: the published packages now declare
  `engines.node: ">=24"`. Node 22 is no longer supported.

  CI: the `tests.yml` workflow bumps from Node 22 to Node 24. Smoke
  workflows that set `node-version: 22` are left alone — they are
  fixtures exercising specific Node versions via `actions/setup-node`,
  not our project's runtime.

### Patch Changes

- c20a05b: perf(cli): parallelize the startup git calls

  The first thing `agent-ci run` does is ask git for several pieces of
  information: the current branch, the head commit SHA, the changed
  files, the remote slug, and (when the tree is dirty) an ephemeral
  commit that captures the working-tree state. Each call shelled out to
  `execSync`, blocking the event loop for ~50–200 ms.

  This change converts each of those helpers to use `execFile` via
  `promisify`, so they return promises. `handleWorkflow` then runs them
  concurrently with `Promise.all` instead of one at a time.

  Functions converted:
  - `getFirstRemoteUrl` and `resolveRepoSlug` in `config.ts`
  - `computeDirtySha` in `runner/dirty-sha.ts`
  - `getChangedFiles` in `workflow/workflow-parser.ts`
  - `resolveHeadSha`, `resolveBaseSha`, and `persistRunResult` in
    `commands/run.ts`

  Switching from `execSync(command-string)` to `execFile("git", [args])`
  also removes a shell escaping step on every call — args are passed as
  an array, not a single string.

  Refs #334.

- 50933a6: chore: remove unused runtime dependencies

  Three runtime dependencies were declared in `package.json` files but
  never imported by any source file in the package:
  - `log-update` from `@redwoodjs/agent-ci` (the diff-renderer module
    replaced it long ago; only stale code comments remain).
  - `jsonc-parser` from `dtu-github-actions`.
  - `yaml` from `@redwoodjs/ts-runner` (the `cli` package still depends
    on `yaml`; this only drops the unused declaration in `ts-runner`).

  Smaller `node_modules`, smaller published packages, and one fewer
  thing to keep up to date when the upstream releases a new version.
  No runtime behaviour change.

- 4b07e75: refactor(workflow-parser): split the GitHub Actions expression evaluator

  Collapses the eight-parameter context that `resolveExprAtom` /
  `evaluateExprValue` were threading through every recursive call into a single
  `ExprContext` object, extracts each built-in function (`hashFiles`, `fromJSON`,
  `toJSON`, `format`, `contains`, `startsWith`, `endsWith`, `join`) into its own
  handler, and moves context-variable lookups (`runner.*`, `github.*`, `matrix.*`,
  `secrets.*`, `vars.*`, `inputs.*`, `steps.*`, `needs.*`, `env.*`) into
  `resolveContextRef`. `expandExpressions`'s public positional signature is
  unchanged.

  No behavioral changes.

- 24387c7: perf(cli): lazy-load command modules so light commands skip the heavy dependency graph

  Extracts the `run`, `retry`/`abort`, and `clean` commands into separate modules
  loaded via dynamic `import()` from `cli.ts`. The dispatcher now only loads what
  the invoked command actually needs.

  Measured impact on `agent-ci --help`:
  - Cold start: 240 ms → 20 ms
  - Peak RSS: 88 MB → 42 MB

  `--help` and unknown commands no longer load dockerode, @grpc/grpc-js,
  protobufjs, ssh2, the runner graph, or the workflow parser. Behavior of every
  command is unchanged; `--help`/`-h` now exits 0 (previously 1, which was a
  quirk of falling through the dispatch chain).

  Refs #334.

- d0a8495: refactor(local-job): extract three helpers out of `executeLocalJob`

  `executeLocalJob` had grown to ~860 lines and scored 73 on the
  cognitive-complexity metric — the highest in the `cli` package after
  the previous round of refactors. Three self-contained blocks of code
  inside it have been moved into module-scope helpers:
  - `pullContainerImageWithProgress(docker, image, store, containerName)`
    — the ~100-line Docker pull with per-layer download / extract
    progress reporting (direct-container mode).
  - `seedRunnerBinaryToHost(docker, hostRunnerSeedDir)` — the one-time
    extraction of the actions-runner binary from the seed image
    (direct-container mode).
  - `waitForContainerExit(container, waitPromise, timeoutMs)` — the
    promise-race that force-stops the container if the runner does not
    exit within the timeout.

  `executeLocalJob` is now ~715 lines, cognitive 56. No behaviour
  change; the full local smoke suite passes.

- 2f2af0d: refactor(local-job): lift the timeline-sync closure to module scope

  `executeLocalJob` had a ~190-line `updateStoreFromTimeline` closure
  that read `timeline.json` plus the paused-signal file every 100ms and
  updated the RunStateStore. The closure captured six mutable `let`
  variables defined just above it; fallow's previous report flagged it
  as the biggest remaining complexity hotspot (cognitive 70).

  This change pulls the closure to module scope as two helpers:
  - `syncTimelineToStore(state, ctx)` — drives one poll tick. Cognitive
    score 22.
  - `buildStepsFromTimeline(steps, state)` — folds the raw timeline
    records into the `StepState[]` shape the renderer expects. Cognitive
    score 45.

  Both take an explicit `TimelineSyncState` object that the polling loop
  mutates between ticks, plus a read-only `TimelineSyncContext` with the
  paths, store reference, and `onNewPause` callback.

  Also drops `padW` / `totalSteps` from the old closure — they were
  computed but never used (legacy padding logic).

  No behaviour change; the full local smoke suite passes 45/45.

- 6b7802b: chore: relax published `engines.node` back to `>=22`

  #351 bumped the published packages' `engines.node` to `>=24` along
  with the development-side switch to Node's native TypeScript support.
  End users never run our source files, only the compiled
  `dist/cli.js`. That compiled output targets ES2020 and only uses APIs
  available on Node 22 (the long-term support release), so the
  published requirement was stricter than it needed to be.

  This change:
  - Sets `engines.node` to `>=22` in `@redwoodjs/agent-ci` and
    `dtu-github-actions`. End users on Node 22 stop seeing the
    "unsupported engine" warning.
  - Adds `engines.node: ">=24"` to the repo-root `package.json` so
    contributors keep getting an explicit signal that the development
    scripts (which run `.ts` files directly through Node's native
    type-stripping) need Node 24.

  No code change.

- 8d92c73: refactor(cli/run): split `runCmd` and `handleWorkflow` into focused helpers

  `packages/cli/src/commands/run.ts` housed two very long orchestrator
  functions. Static analysis (fallow health) scored them as the two
  highest-complexity functions in the cli package:
  - `runCmd` — cognitive 91, ~228 lines
  - `handleWorkflow` — cognitive 136, ~717 lines

  They mixed argument parsing, workflow discovery, matrix expansion,
  resource classification, scheduling, wave execution, and final reporting
  in a single body, which made each one hard to follow and hard to change.

  This change pulls clearly bounded steps out into top-level helpers
  without changing any observable behaviour:
  - `parseRunArgs`, `parseJobsFlag`, `parseVarFlag`, `resolveGithubTokenFlag`,
    `discoverRelevantWorkflows`, `resolveWorkflowArgPath`, `finalizeRun` —
    carved out of `runCmd`.
  - `expandJobs`, `classifyJobsResources`, `runWaveJobs` — carved out of
    `handleWorkflow`. The `ExpandedJob` type is lifted to module scope so
    the new helpers can take it.

  New scores (fallow health):
  - `runCmd`: cognitive 9 (was 91)
  - `handleWorkflow`: cognitive 61 (was 136)
  - `parseRunArgs`: cognitive 26 (new, replaces the inline arg loop)

  No runtime behaviour change; full smoke suite passes.

- a0d3bb0: chore: unexport helpers that were never imported externally

  `log-prune.ts` and `generators.ts` had six identifiers marked `export`
  that no other file actually imported:
  - `DEFAULT_RETAIN_DAYS`, `DEFAULT_RETAIN_RUNS`, `DEFAULT_THROTTLE_MS`
    (used only inside `log-prune.ts`)
  - `toContextData`, `toTemplateTokenMapping`
    (used only inside `generators.ts`)
  - `toContainerTemplateToken`
    (not used anywhere — wholly dead, removed)

  Tightens the public surface so callers can't accidentally rely on
  internal helpers, and gets a step closer to a clean dead-code report.
  No runtime behaviour change.

- Updated dependencies [c20a05b]
- Updated dependencies [50933a6]
- Updated dependencies [4b07e75]
- Updated dependencies [c8da13a]
- Updated dependencies [24387c7]
- Updated dependencies [d0a8495]
- Updated dependencies [2f2af0d]
- Updated dependencies [ab075d9]
- Updated dependencies [6b7802b]
- Updated dependencies [8d92c73]
- Updated dependencies [a0d3bb0]
  - dtu-github-actions@0.16.0

## 0.15.1

### Patch Changes

- 63204ec: fix(macos-vm): let `waitForIp` retry on cold-boot `tart ip` timeouts

  `getIp` swallows the `runCommand` rejection that fires when `tart ip` hangs past 5s waiting for a DHCP lease, so `waitForIp` can keep polling for the full 90s budget instead of dying on the first iteration.

  Refs #329.

- Updated dependencies [63204ec]
  - dtu-github-actions@0.15.1

## 0.15.0

### Minor Changes

- daa536c: Colocate per-run log artifacts with the checks JSON under `<stateDir>/logs/` (override via `AGENT_CI_LOG_DIR`) so log paths recorded in the run-result JSON survive OS-level pruning of `os.tmpdir()`. Add an opportunistic, throttled cleanup that runs at the start of `agent-ci run` plus an explicit `agent-ci clean` command. Knobs: `AGENT_CI_LOG_RETAIN_DAYS` (default 7), `AGENT_CI_LOG_RETAIN_RUNS` (default 20), `AGENT_CI_LOG_PRUNE=0` to disable. Refs #312.

  Also fix `buildStepEnv` to thread an `envContext` through `expandExpressions`, completing the env.\* expansion fix from #320 — `${{ env.JOB_KEY }}` inside another step's `env:` value now resolves to the workflow- or job-level value instead of an empty string.

- edce84b: Stop `--pause-on-failure` from blocking forever when stdout is piped or
  redirected, and emit a structured NDJSON event stream in agent-output mode.

  **Pause-on-failure unblock (#315).** When the CLI detects a non-TTY invocation
  with `--pause-on-failure` (and we're not under an LLM harness with `-q`), it
  now spawns the actual run as a detached worker and exits with code 77 the
  moment the worker emits a `run.paused` NDJSON event on stdout. The worker
  keeps running with the container + DTU + signals dir alive, so a sibling
  `agent-ci retry --name X` resumes it as before.

  `agent-ci retry` reuses the same tail mechanism: after writing the retry
  signal it tails the worker's log starting at the current end-of-file, so a
  re-failure surfaces as another exit-77 in the retrying shell, a successful
  completion exits 0, and a failed completion exits 1 — driven by a final
  `run.finish` event the worker emits at the end of the run.

  **Structured event stream (#289).** New `--json` flag (and `AGENT_CI_JSON=1`
  env var) makes the CLI emit NDJSON lifecycle events on stdout — one JSON
  object per line, each with an `event` discriminator field:
  - `run.start` — `{ts, schemaVersion: 1, runId}`
  - `job.start` / `job.finish` — `{ts, job, runner, workflow, status?, durationMs?}`
  - `step.start` / `step.finish` — `{ts, job, runner, step, index, status?, durationMs?}`
  - `run.paused` — `{ts, runner, step?, attempt?, workflow?, retry_cmd}`
  - `run.finish` — `{ts, status: "passed"|"failed", durationMs?}`
  - `diagnostic` — `{ts, level, message}`

  `--json` is decoupled from `--quiet` so existing `-q` callers keep their
  silent stdout. The animated renderer is auto-suppressed under `--json` so
  ANSI sequences don't collide with the JSON stream. Existing human-readable
  lines on stderr are unchanged. Non-JSON log lines pass through unchanged.
  Per-line `step.log` streaming is deferred to a follow-up.

  TTY behavior is unchanged. Refs #315 and #289.

### Patch Changes

- edce84b: Stop the resource-mismatch smoke from queueing a phantom GitHub Actions job. The fixture in `.github/workflows/smoke-resource-mismatch.yml` declares `runs-on: ubuntu-latest-999-cores` to deterministically trigger the local resource-fidelity classifier, but its `pull_request_target` trigger meant GitHub also queued the job on every PR and waited indefinitely for a runner that does not exist. The trigger is now `workflow_dispatch:` only, and `agent-ci run --all` now treats `workflow_dispatch:`-only workflows as relevant so the smoke is still exercised by local CI.
- 23fca33: Update agent-facing skill docs (`packages/cli/SKILL.md`, top-level `skills/agent-ci/SKILL.md`) to cover the `--json` NDJSON event stream and the exit-77 pause contract added in #315 / #289. Internal `agent-ci-dev` command + pi skill switch from plaintext "Step failed" grep to NDJSON event matching for more robust pause/finish detection. Stale "no pipes / no redirects" warnings in the experimental skill-eval variants are corrected — pipes and redirects are safe with `--pause-on-failure` now that the launcher detaches automatically.

  Refs #289, #315.

- be87b94: Fix `AGENT_CI_DOCKER_HOST=ssh://...` failing with `getaddrinfo ENOTFOUND`. The runner now parses the SSH URI and passes `host`, `username`, and `port` to dockerode separately instead of handing the raw URI string through as a hostname. Refs #322.
- Updated dependencies [daa536c]
- Updated dependencies [edce84b]
- Updated dependencies [23fca33]
- Updated dependencies [be87b94]
- Updated dependencies [edce84b]
  - dtu-github-actions@0.15.0

## 0.14.0

### Minor Changes

- 44595b1: Surface degraded local runs when the host machine is smaller than the runner spec declared by `runs-on:` (e.g. `ubuntu-latest-8-cores`). The job is tagged `degraded`, a warning is printed before execution, and `[degraded]` appears in CLI output. Execution is never blocked — slow runs and OOMs now have a visible cause instead of being a mystery.

  Refs #229.

- 76b46f9: Revert the opt-in smolvm backend (#287). The implementation proved too rough
  to keep in-tree while iterating — it will return once the boot path is
  reliable on the current smolvm release. `AGENT_CI_BACKEND=smolvm` is no
  longer recognized; Linux jobs always run through Docker.

### Patch Changes

- 6a26cae: Add support for expansion of variables in the `env` context in expressions.

  `env` context variables deriving from the merged step environment (workflow-level + job-level + step-level `env:`) are now expanded in expressions, matching GitHub Actions behavior. Previously these references resolved to empty strings.

- Updated dependencies [44595b1]
- Updated dependencies [76b46f9]
- Updated dependencies [6a26cae]
  - dtu-github-actions@0.14.0

## 0.13.0

### Minor Changes

- 77ea148: Rename `DOCKER_HOST` to `AGENT_CI_DOCKER_HOST` and load `AGENT_CI_*` vars from `.env.agent-ci`.

  **Breaking:** agent-ci no longer honours the standard `DOCKER_HOST` env var. If it is set in the shell, agent-ci exits immediately with an error asking you to rename it. Rename it in your shell (or move it to `.env.agent-ci`) as `AGENT_CI_DOCKER_HOST`. This avoids the long-standing collision where users wanted agent-ci to target one daemon (e.g. a Lima/OrbStack VM) while their shell's `docker` CLI targeted another.

  **New:** `AGENT_CI_*`-prefixed keys in `.env.agent-ci` are now loaded into the CLI process environment at startup, so Docker/network configuration (e.g. `AGENT_CI_DOCKER_HOST`, `AGENT_CI_DTU_HOST`, `AGENT_CI_DOCKER_EXTRA_HOSTS`) no longer has to be exported in the shell. Shell env vars still take precedence over `.env.agent-ci`. Non-prefixed keys in the file remain workflow secrets (`${{ secrets.FOO }}`) as before.

  Refs #308.

- 3212927: Persist the latest run result per worktree to `$AGENT_CI_STATE_DIR` (or OS-default state dir) as JSON, so external consumers (tmux panes, status bars, editor integrations) can read the current branch's CI status without re-running the tool or scraping human output.

  The file is written atomically after every `agent-ci run` / `agent-ci run --all` and keyed by `<branch>.<worktree-hash>.json` under `<org>/<repo>/`, so two worktrees on the same branch don't stomp each other. Each job entry carries the full step list with per-step `logPath`, plus `debugLogPath` for the whole job. Paths are only included when the file still exists at write time. Includes `headSha` so consumers can detect stale results themselves.

  Refs #288

### Patch Changes

- f5f7dbd: Fix: honor step-level `if:` conditions. Previously every step ran regardless of its `if:` clause, because `parseWorkflowSteps` never extracted `step.if` from the workflow, and the server fell back to `condition: "success()"` for every step. Now the condition is forwarded to the runner's EvaluateStepIf, so gates like `if: contains(runner.name, 'blacksmith')`, `if: always()`, and `if: ${{ false }}` behave as they do on real GitHub Actions.
- Updated dependencies [77ea148]
- Updated dependencies [f5f7dbd]
- Updated dependencies [3212927]
  - dtu-github-actions@0.13.0

## 0.12.4

### Patch Changes

- e2fe576: Make `packages/cli/compatibility.json` the single source of truth for the YAML compatibility matrix. The `compatibility.md` document and the website's compatibility table are both derived from it — run `pnpm compat:gen` after editing the JSON. `pnpm check` fails if the `.md` drifts out of sync.
- e2fe576: Add a `proof` field to `compatibility.json` rows pointing at the workflow files that exercise each feature end-to-end. Internal field — not rendered in the markdown table or on the website. The `compat:gen` script fails if any listed proof path does not resolve on disk, so a file rename can't silently break a compatibility claim.

  Refs #292.

- 044de23: Forward `jobs.<id>.container.options` through to the runner container. Previously the options string was parsed but never handed to `docker.createContainer`, so `options: --env FOO=bar` silently produced a container without `FOO`. Now `--env`/`-e` and `--label`/`-l` flags inside `options:` are extracted and merged into the container's `Env` and `Labels`. Other Docker flags in `options:` (`--privileged`, `--user`, `--network`, `--cap-add`, `--workdir`, …) remain intentionally ignored — they clash with agent-ci's own container orchestration and can break the runner's invariants.

  `actions/cache` and `GITHUB_TOKEN` compatibility notes updated to document existing limitations (no ref-based cache scoping; no OIDC id-token issuance) so the behaviour matches the documentation.

  Refs #296.

- e2fe576: Propagate `defaults.run.working-directory` to steps. Workflow-level and job-level `defaults.run.working-directory` were parsed but never applied — every step ran at the workspace root regardless of the declared default. Now merged with standard GitHub Actions precedence: step override beats job default beats workflow default.

  Refs #290.

- f44620b: Let `hashFiles()` descend into dotted directories. The recursive walker was skipping any directory whose name starts with `.`, which meant patterns like `hashFiles('.github/workflows/*.yml')` never matched a file and returned the zero-placeholder (`"000…"`, 40 chars). Now only `node_modules` is skipped; dotted directories are walked when a pattern asks for them. The resulting digest is real SHA-256 (64 chars), matching GitHub Actions.

  Refs #294.

- 5a23a5a: Flesh out `compatibility.json` with 15 rows that were absent before — features real GitHub Actions documents but our table said nothing about. Status is chosen per code inspection, so each row reflects current behaviour rather than aspirational coverage:
  - **Workflow triggers**: sub-event filters `branches`/`branches-ignore` (supported), `paths`/`paths-ignore` (supported), `tags`/`tags-ignore` (unsupported), `types` (ignored), `workflow_dispatch.inputs` (ignored — dispatch itself isn't simulated), `workflow_call.inputs.*` (supported), `workflow_call.outputs.*.value` (supported).
  - **Job-level**: `jobs.<id>.permissions` (ignored), `jobs.<id>.container.credentials` (unsupported), `jobs.<id>.services.*.credentials` (unsupported).
  - **Step-level**: `steps[*].uses: docker://…` (unsupported — Docker-image action refs are not resolved).
  - **Expressions**: `vars.*` (supported), `inputs.*` (supported), `steps.*.conclusion` / `steps.*.outcome` (unsupported), `job.*` runtime context (unsupported), `*` object-filter operator (unsupported).

  No behaviour changes — just honest documentation. Closes the "missing rows" bucket on #296.

- fdec27e: Split the remaining overloaded rows in `compatibility.json` so each documented feature has a row that reflects its real status. Pure documentation — no behaviour changes.
  - **`github.*`** — split into three rows: `github.sha` (real from git), `github.repository` / `github.repository_owner` (derived from the remote), and a catch-all row documenting that everything else resolves to a static default or an empty string. The catch-all enumerates the rest of the context so a reader can tell `workflow_sha`, `triggering_actor`, etc. are not populated.
  - **`runner.*`** — added a row for the unsupported siblings (`runner.name`, `runner.temp`, `runner.tool_cache`, `runner.debug`, `runner.environment`) so it's visible that only `runner.os` / `runner.arch` resolve.
  - **`contains` / `startsWith` / `endsWith`** — three separate rows with per-function notes.
  - **`success()` / `failure()` / `always()` / `cancelled()`** — downgraded to `partial` with a note clarifying that `cancelled()` always returns `false` locally (no cancellation signal).
  - **`on` (other events)** — kept as one row but the note now enumerates the ~20 event names it covers so users can see exactly which triggers are no-ops.

  Closes the "overloaded row" bucket on #296.

- 78e3e01: Honor `defaults.run.shell` and step-level `shell:` for non-bash shells. The runner executes every `run:` step with bash regardless of `inputs.shell`, so the parser now wraps scripts that request `sh`, `python`, or `pwsh` with an explicit invocation of the requested interpreter (`sh -e <<'EOF' … EOF`). Workflow, job, and step scopes all use standard step-wins-over-job-wins-over-workflow precedence.

  Refs #293.

- e2fe576: Stop step-level `env:` from leaking into sibling steps. Each step's env now attaches as its own `environment` on the mapped step rather than being merged into the job-wide `EnvironmentVariables` map, where a later step's values could override an earlier step's reads of the same key.
- f44620b: Stop leaking literal `${{ steps.<id>.outputs.<name> }}` text into `run:` scripts. The parser used to leave these expressions untouched on the premise that the runner would evaluate them at runtime, but the runner does not re-evaluate expressions inside run-script bodies — the literal `${{ }}` reached bash and produced "bad substitution" errors. The expression now resolves to an empty string at parse time, matching the long-standing documented behavior.

  Use `needs.*.outputs.*` for cross-job values — those are resolved against real job outputs.

  Refs #295.

- ab410c7: Two small expression-engine fixes surfaced while running through #296's "questionable claim" rows:
  1. **`toJSON` now pretty-prints with 2-space indent** to match GitHub Actions. Previously emitted compact JSON, which meant that any `hashFiles` key that consumed `toJSON(x)` would hash to a different digest locally vs. on GitHub. Parses `rawValue` before re-serialising so `toJSON(fromJSON(x))` round-trips.
  2. **`''`, `null`, and numeric strings now coerce in comparisons** per the spec: `'' == 0`, `null == 0`, `'0' == 0` are all `true`; `'x' == 0` stays `false` because non-numeric strings become `NaN`. Previously, empty/null on either side fell out of the numeric path and was string-compared, so `'' == 0` resolved to `false`.

  Refs #296.

- Updated dependencies [e2fe576]
- Updated dependencies [e2fe576]
- Updated dependencies [044de23]
- Updated dependencies [e2fe576]
- Updated dependencies [f44620b]
- Updated dependencies [5a23a5a]
- Updated dependencies [fdec27e]
- Updated dependencies [78e3e01]
- Updated dependencies [e2fe576]
- Updated dependencies [f44620b]
- Updated dependencies [ab410c7]
  - dtu-github-actions@0.12.4

## 0.12.3

### Patch Changes

- 2e7c844: Document and surface Docker Desktop's default-socket toggle. Docker Desktop 4.x ships with `/var/run/docker.sock` disabled, so a fresh install will hit `agent-ci couldn't use a Docker socket at /var/run/docker.sock` even when Docker Desktop is running. The `docker-socket.md` recipe now walks through the Settings → Advanced toggle, and the resolver error appends a one-shot hint pointing at it whenever it detects Docker Desktop's user-side socket (`~/.docker/run/docker.sock`).

  Refs #253.

- Updated dependencies [2e7c844]
  - dtu-github-actions@0.12.3

## 0.12.2

### Patch Changes

- e320288: fix(runner): nested agent-ci sibling containers collide on `agent-ci-1` when multiple outer runs execute in parallel. Each nested run has its own filesystem so it always allocated `agent-ci-1`, and the pre-spawn `docker rm -f` then killed a sibling belonging to a concurrent nested run. Include the outer container's hostname in the prefix when `/.dockerenv` is present so sibling names stay unique across nested runs. Fixes `smoke-bun-setup.yml` + `smoke-docker-buildx.yml` failing when run together via `agent-ci-dev run --all`.
- 3f1c836: fix(workflow): expand `${{ runner.os }}` / `${{ runner.arch }}` from the job's `runs-on:` label instead of hardcoding Linux/X64. macOS jobs (e.g. `runs-on: macos-14`) now expand to `macOS`/`ARM64`, matching GitHub-hosted runner behavior and making conditionals like `if: runner.os == 'macOS'` work under tart-backed VM execution (#279).
- Updated dependencies [e320288]
- Updated dependencies [3f1c836]
  - dtu-github-actions@0.12.2

## 0.12.1

### Patch Changes

- 59d6c40: Fix `UnauthorizedAccessException` on `/home/runner/_diag` and workspace write failures when running on macOS with Colima or Docker Desktop (#263).

  On those Docker backends the bind-mounted `_diag` and `_work` directories surface as `root:root 0755` inside the container because host permissions don't translate through the VM mount layer. The runner user (uid 1001) then can't write its diag logs or scratch files and the job crashes on startup. We now `MAYBE_SUDO chmod 1777` both mount points during container boot, mirroring the existing fix for `/home/runner/.cache` (#234). OrbStack and native Linux Docker are unaffected — the chmod is a no-op there.

  Also hardens Docker socket detection: agent-ci now requires a working socket at `/var/run/docker.sock` (unless `DOCKER_HOST` is set explicitly) and fails fast with a link to a new per-provider setup guide (`packages/cli/docs/docker-socket.md`) instead of silently picking a provider-specific path that the mount layer later rejects. This eliminates a class of confusing "operation not supported" errors when switching Docker backends (e.g. leftover OrbStack symlinks on a Colima host).

- cbf0c44: Release workflow now closes referenced issues on publish instead of on version-PR merge.

  `pnpm run version` captures `Closes|Fixes|Resolves #N` references from pending changesets into `.release-closes.json`, pairs each with the PR that introduced the changeset, and rewrites the keywords to `Refs #N` in the changeset bodies so the "chore: version packages" PR does not close them on merge. After `changesets/action` publishes, a new step reads `.release-closes.json` and closes each issue with a `Closes Issue #N via PR #M.` comment.

- Updated dependencies [59d6c40]
- Updated dependencies [cbf0c44]
  - dtu-github-actions@0.12.1

## 0.12.0

### Minor Changes

- 12220be: Run `runs-on: macos-*` jobs in a real macOS VM via [tart](https://github.com/cirruslabs/tart) on Apple Silicon hosts.

  When the host is `darwin`/`arm64` with `tart` and `sshpass` installed, jobs whose `runs-on:` targets macOS launch a cirruslabs macOS VM, rsync in the macOS `actions-runner` binary, and connect the runner to the ephemeral DTU via the host bridge. Concurrency is capped at 2 VMs by default (override with `AGENT_CI_MACOS_VM_CONCURRENCY`).

  Hosts that don't support this (Linux, Intel macOS, missing tart/sshpass) continue to skip macOS jobs with the same warning introduced in #273. Windows jobs are still skipped on all hosts.

  Image mapping:
  - `macos-13` → `macos-ventura-xcode:latest`
  - `macos-14` → `macos-sonoma-xcode:latest`
  - `macos-15` → `macos-sequoia-xcode:latest`
  - `macos-26` → `macos-tahoe-xcode:latest`
  - `macos` / `macos-latest` → `macos-sonoma-xcode:latest`
  - Override with `AGENT_CI_MACOS_VM_IMAGE`.

### Patch Changes

- Updated dependencies [12220be]
  - dtu-github-actions@0.12.0

## 0.11.0

### Minor Changes

- 372a47b: Support `env:` at workflow and job level (not just step level).

  Previously the workflow parser only read `env:` declared directly on a step. Workflow-level and job-level `env:` blocks were silently ignored, so any workflow that relied on them — including workflows that referenced `${{ vars.X }}` in a job-level env — saw empty values at runtime.

  The parser now merges `env:` from all three levels per the GitHub Actions spec: workflow → job → step, step-most-specific wins. Expressions (including `${{ vars.X }}`, `${{ secrets.X }}`, etc.) are expanded per-level.

  This also makes the `smoke-vars-preflight.yml` Case 3 assertion actually verify the feature it documents — previously the assertion depended on env leaking in from the outer runner process.

- 9474fb5: Skip jobs with `runs-on: macos-*` or `windows-*` instead of silently running them in a Linux container

  Previously, jobs targeting macOS or Windows runners were silently routed to the Linux runner container and failed at the first OS-specific step (e.g. `Setup Xcode`), producing a confusing error. They now skip with a visible `[Agent CI]` warning that points at the tracking issues for real support. Linux and `self-hosted`-without-OS-hint jobs are unaffected.

  Tracking:
  - https://github.com/redwoodjs/agent-ci/issues/254 (this guardrail)
  - https://github.com/redwoodjs/agent-ci/issues/258 (real macOS runner support)

- 2bb4e57: Add support for `${{ vars.FOO }}` expressions in local workflow runs. Supply vars via the `--var KEY=VALUE` CLI flag (repeat for multiple). Runs fail with a clear error listing the missing vars if any required var is not provided.

### Patch Changes

- b6b9310: fix: docker/setup-buildx-action and other Docker socket users fail with "permission denied" on native Linux Docker (#257)

  The runner container's entrypoint chmods the bind-mounted `/var/run/docker.sock` to `0666` so the `runner` user can talk to the Docker daemon. On native Linux Docker the socket is owned `root:docker`, so the chmod needs `sudo` — but it was using plain `chmod` and silently failing. Steps like `docker/setup-buildx-action@v4`, `docker login`, and `docker compose` then failed with `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`. Now escalated via `MAYBE_SUDO`, matching the other privileged entrypoint operations.

- 3b16523: Improve error hints when fetching remote reusable workflows from private repositories. GitHub returns HTTP 404 (not 401/403) when authentication is missing or insufficient for a private repo — to avoid leaking repo existence — so the 404 path now emits the same auth guidance as the 401/403 path, including instructions to run `gh auth login` and use `--github-token`. The hint also distinguishes between the no-token case (how to provide one) and the token-provided case (scope / fine-grained permission / SSO authorization may be missing).
- Updated dependencies [b6b9310]
- Updated dependencies [372a47b]
- Updated dependencies [3b16523]
- Updated dependencies [9474fb5]
- Updated dependencies [2bb4e57]
  - dtu-github-actions@0.11.0

## 0.10.7

### Patch Changes

- e482875: Fix `actions/setup-node` emitting "Bad credentials" and falling back to a slow nodejs.org download. The bundled `@actions/tool-cache` hardcodes `api.github.com` for its versions-manifest fetch; the DTU now rewrites the URL in setup-node's tarball at cache time and mocks the `/repos/:owner/:repo/git/trees|blobs` endpoints so the manifest call routes through the DTU (fixes #249).

  Also: when a step fails with `tar: ...: Cannot open: Permission denied` (typically from a stale `/opt/hostedtoolcache` bind mount left by a previous run), surface an actionable hint showing the host-side toolcache path and an `rm -rf` command to clear it (fixes #171).

- 2114d67: fix: permission errors in direct-container mode on Arch Linux
- Updated dependencies [e482875]
  - dtu-github-actions@0.10.7

## 0.10.6

### Patch Changes

- 64d654d: Auto-pull runner image on first run with visible progress output. Previously, first-time users saw a frozen spinner or a confusing "No such image" error because the pull happened silently and failures were only debug-logged.
- Updated dependencies [64d654d]
  - dtu-github-actions@0.10.6

## 0.10.5

### Patch Changes

- 2e2bd5e: fix: always show workflows and jobs in --all mode, fix duplicate matrix jobs
- Updated dependencies [2e2bd5e]
  - dtu-github-actions@0.10.5

## 0.10.4

### Patch Changes

- 25c1c5d: Fix Cypress install failing with EACCES on `/home/runner/.cache/Cypress`.
- Updated dependencies [25c1c5d]
  - dtu-github-actions@0.10.4

## 0.10.4

### Patch Changes

- Fix Cypress install failing with EACCES on `/home/runner/.cache/Cypress` (#234).

## 0.10.3

### Patch Changes

- ca4610f: Fix expression evaluation in workflow parser to support boolean operators (`&&`, `||`, `!`), `format()`, and `toJSON()`.
- Updated dependencies [ca4610f]
  - dtu-github-actions@0.10.3

## 0.10.2

### Patch Changes

- 37d6125: Fix nested agent-ci crashes and add global concurrency limiter.
  - Skip orphan cleanup when running inside a container (`.dockerenv` detection) to prevent nested agent-ci from killing its own parent container.
  - Resolve DTU host from the container's own IP when nested, instead of inheriting the unreachable `AGENT_CI_DTU_HOST`.
  - Add a shared concurrency limiter across all workflows in `--all` mode, auto-detected from Docker VM memory (`floor(availableMemory / 4GB)`), to prevent OOM kills (exit 137).

- Updated dependencies [37d6125]
  - dtu-github-actions@0.10.2

## 0.10.1

### Patch Changes

- 71a3ebb: Exclude test files from published dist by adding tsconfig exclude for `*.test.ts`.
- Updated dependencies [71a3ebb]
  - dtu-github-actions@0.10.1

## 0.10.0

### Minor Changes

- 66ac2a4: Add pluggable runner image via `.github/agent-ci.Dockerfile` convention (#208).

  agent-ci now discovers a user-provided Dockerfile at `.github/agent-ci.Dockerfile` (or `.github/agent-ci/Dockerfile` for builds with a COPY context), hashes its contents, builds it locally via `docker build`, and uses the resulting `agent-ci-runner:<hash>` tag as the default runner image. Edits to the Dockerfile produce a new hash and trigger an automatic rebuild; identical contents reuse the cached image.

  This closes the long-standing gap where the minimal `ghcr.io/actions/actions-runner:latest` image lacks `build-essential`, `python3`, and other toolchains that GitHub's hosted `ubuntu-latest` VM ships preinstalled. Workflows that run green on GitHub but fail locally with `linker 'cc' not found` or similar can now opt into a richer image by dropping a 5-line Dockerfile into `.github/`.

  Resolution order (highest wins):
  1. Per-job `container:` directive (unchanged)
  2. `AGENT_CI_RUNNER_IMAGE` environment variable
  3. `.github/agent-ci/Dockerfile` (directory form, supports COPY)
  4. `.github/agent-ci.Dockerfile` (simple form, empty context)
  5. `ghcr.io/actions/actions-runner:latest` (unchanged default)

  Also adds an error-hint heuristic: when a step fails with a "command not found" pattern for common tools (`cc`, `gcc`, `make`, `python3`, `pkg-config`) and the user is still on the default image, the failure summary includes a ready-to-paste Dockerfile snippet pointing at the fix. See `packages/cli/runner-image.md` for full documentation.

### Patch Changes

- 1c7e663: Fix Docker socket bind mount on Linux + Docker Desktop when user is not in the docker group (#209). `resolveDockerSocket()` now treats `socketPath` (API client) and `bindMountPath` (container mount source) as independent decisions: whenever `/var/run/docker.sock` exists on the host, it is used as the bind-mount source regardless of our process's R/W access. This collapses the macOS Docker Desktop symlink case (#197) and the Linux Docker Desktop non-docker-group case (#209) into one rule.
- 38994c8: Fix service container and runner leak on unclean shutdown.
- 1a92bbd: Fix Docker socket bind-mount failure on macOS Docker Desktop (#197).

  When `/var/run/docker.sock` is a symlink (common with Docker Desktop), the resolved real path was being used as the container bind-mount source. Docker's VM cannot access that host path, causing "error while creating mount source path". Now `resolveDockerSocket()` returns a separate `bindMountPath` (the pre-symlink path, e.g. `/var/run/docker.sock`) for use in bind mounts, while `socketPath` (the resolved path) continues to be used for the Docker API client connection.

- cf18585: perf: hoist docker cleanup and image prefetch to session bootstrap

  `agent-ci run --all` now runs global Docker cleanup (prune orphans, kill
  stale containers, prune stale workspaces) and runner image prefetch exactly
  once per session instead of once per workflow. Also dedupes concurrent
  `ensureImagePulled` calls so parallel workflows share a single in-flight
  `docker pull`. Eliminates cold-start thundering herd and the N× `docker
volume prune` storm that was serializing multi-workflow runs. See #211.

- 38994c8: fix: use XDG cache dir on Linux + Docker Desktop instead of /tmp (#215)
- Updated dependencies [1c7e663]
- Updated dependencies [38994c8]
- Updated dependencies [1a92bbd]
- Updated dependencies [cf18585]
- Updated dependencies [66ac2a4]
- Updated dependencies [38994c8]
  - dtu-github-actions@0.10.0

## 0.9.0

### Minor Changes

- b93ecdf: Compute dirty SHA for uncommitted worktrees so `github.sha` reflects the code actually being executed.
- 2cf4034: Resolve workflow secrets from shell environment variables (fallback to .env.agent-ci file). Also auto-populate `secrets.GITHUB_TOKEN` from `--github-token`.

### Patch Changes

- 1e2714b: Fix "No such image" error on first run for users without a local Docker image cache.
- 9ff0710: Deduplicate identical failure errors in output summary and streaming messages.
- 68b1d14: Show failure output and retry/abort hints for paused jobs in multi-job workflows.
- Updated dependencies [b93ecdf]
- Updated dependencies [2cf4034]
- Updated dependencies [1e2714b]
- Updated dependencies [9ff0710]
- Updated dependencies [68b1d14]
  - dtu-github-actions@0.9.0

## 0.8.2

### Patch Changes

- f7e42f0: Fix signal handler to clean up runner directory on Ctrl+C. Add parent-PID liveness tracking to detect and kill orphaned Docker containers on startup. Wire up pruneStaleWorkspaces to clean up old run directories.
- cd24a04: Fix actions/checkout@v6 compatibility by using the real HEAD SHA instead of a fake placeholder.
- e42f4a9: Fix Docker socket detection on Linux when /var/run/docker.sock exists but is not accessible (EACCES).
- 02741dc: Mount warm node_modules directly at workspace path instead of symlinking via /tmp
- Updated dependencies [f7e42f0]
- Updated dependencies [cd24a04]
- Updated dependencies [e42f4a9]
- Updated dependencies [02741dc]
  - dtu-github-actions@0.8.2

## 0.8.1

### Patch Changes

- 1f24fec: Make GitHub authentication opt-in for remote reusable workflow fetching. Add --github-token CLI flag and AGENT_CI_GITHUB_TOKEN env var.
- Updated dependencies [1f24fec]
  - dtu-github-actions@0.8.1

## 0.8.0

### Minor Changes

- f660c11: Support composite action step outputs and push event context for changed-files actions
- ba84b69: Add ts-runner: a TypeScript replacement for the GitHub Actions runner that executes workflow `run:` steps natively without Docker.
- 6b7a95b: Support local composite actions (`uses: ./.github/actions/...`) by setting `RepositoryType: "self"` so the runner resolves them from the workspace.
- cf31ce1: Support nested reusable workflows up to 4 levels deep, matching GitHub Actions' limit.
- e9c5df5: Support local reusable workflows (`uses: ./.github/workflows/...`) by inlining called jobs into the caller's dependency graph.
- 789e403: Support passing inputs and outputs through reusable workflows. Caller `with:` values are now resolved and available as `inputs.*` in called workflows, input defaults from `on.workflow_call.inputs` are respected, and `on.workflow_call.outputs` are wired back so downstream jobs can consume `needs.<callerJobId>.outputs.*`.

### Patch Changes

- c7d45a2: Use resolved DOCKER_HOST socket path for container bind mount instead of hardcoding /var/run/docker.sock.
- 7a612b0: Fix duplicate error messages on workflow failure by removing the intermediate console.error in handleWorkflow's catch block.
- fbd8dea: Fix horizontal scrolling on code blocks in mobile in-app browsers (e.g. Twitter/X).
- 8fbe36d: Fix TypeScript @types resolution for pnpm projects using warm-modules cache.
- 81aedf3: Fix stderr leak from git commands and support non-origin remote names.
- 912ed83: Preserve git-tracked symlinks in workspace snapshot copies.
- 2820b5a: Remove test script from ts-runner package to unblock release workflow.
- 1b1c664: Guard against undefined template.jobs from workflow parser to prevent TypeError crash.
- ed4e86c: Fix parseWorkflowSteps crash when template.jobs is undefined.
- Updated dependencies [f660c11]
- Updated dependencies [ba84b69]
- Updated dependencies [c7d45a2]
- Updated dependencies [7a612b0]
- Updated dependencies [fbd8dea]
- Updated dependencies [8fbe36d]
- Updated dependencies [81aedf3]
- Updated dependencies [912ed83]
- Updated dependencies [2820b5a]
- Updated dependencies [1b1c664]
- Updated dependencies [6b7a95b]
- Updated dependencies [cf31ce1]
- Updated dependencies [ed4e86c]
- Updated dependencies [e9c5df5]
- Updated dependencies [789e403]
  - dtu-github-actions@0.8.0

## 0.7.1

### Patch Changes

- 17ef340: Fix --all hanging on single-job workflows due to cross-workflow job stealing.

  Pin `job.runnerName = containerName` before the DTU seed call so every job goes to the runner-specific pool. Move container and ephemeral DTU cleanup into a `finally` block to ensure cleanup even on mid-run errors. Set `process.setMaxListeners(0)` to suppress EventEmitter warnings when running many parallel jobs.

- 336fb98: Fix: treat runner that never contacted DTU as a failure instead of success. When `isBooting` is still true after the container exits (meaning no timeline entries were received), the job is now correctly reported as failed regardless of exit code.
- cc73a1f: Fix race condition in concurrent log directory allocation by using atomic mkdirSync.
- be5cacd: Fix handleWorkflow catch block swallowing errors by re-throwing instead of returning empty array
- 5fadfee: Remove stopped agent-ci containers before pruning networks to prevent address pool exhaustion.
- 1e9d7ca: Support `pull_request_target` in workflow relevance check, applying the same branch and paths filter logic as `pull_request`. Fix Docker container name collisions when running multiple workflows concurrently via `--all` by pre-allocating unique run numbers per workflow.
- 73f6bf0: Propagate job-level env into DTU Variables store and add AGENT_CI_LOCAL to Docker container env.
- Updated dependencies [17ef340]
- Updated dependencies [336fb98]
- Updated dependencies [cc73a1f]
- Updated dependencies [be5cacd]
- Updated dependencies [5fadfee]
- Updated dependencies [1e9d7ca]
- Updated dependencies [73f6bf0]
  - dtu-github-actions@0.7.1

## 0.7.0

### Minor Changes

- c2fe31b: Cache action tarballs on first download and serve from disk on subsequent runs, eliminating ~30s GitHub CDN delays. Capture step output via tee to signals dir for reliable pause-on-failure tail display. Fix CLI to treat empty results as failure.
- acb750f: Show Docker image pull progress (bytes downloaded / total) as a sub-step under "Starting runner" during boot.

### Patch Changes

- f9f17fd: Detect project package manager and only mount relevant PM cache directories into the container. Projects using npm, yarn, or bun no longer get unnecessary pnpm store bind mounts (and vice versa). Falls back to mounting all PM caches when no lockfile is detected.
- Updated dependencies [f9f17fd]
- Updated dependencies [c2fe31b]
- Updated dependencies [acb750f]
  - dtu-github-actions@0.7.0

## 0.6.0

### Minor Changes

- 6e53753: Post GitHub commit status via gh CLI after agent-ci run completes

### Patch Changes

- d273b76: Show full per-step log content in failure summary instead of a truncated 20-line tail.
- a987818: Simplify Docker host resolution to be OS-agnostic by default, with explicit environment-variable overrides for custom networking setups.
- Updated dependencies [6e53753]
- Updated dependencies [d273b76]
- Updated dependencies [a987818]
  - dtu-github-actions@0.6.0

## 0.5.0

### Minor Changes

- 179405b: Add package metadata, SKILL.md, and AI agent discoverability section to README

### Patch Changes

- Updated dependencies [179405b]
  - dtu-github-actions@0.5.0

## 0.4.0

### Minor Changes

- 61d3e25: Add --no-matrix flag to collapse matrix workflows into a single job.

### Patch Changes

- Updated dependencies [61d3e25]
  - dtu-github-actions@0.4.0

## 0.3.4

### Patch Changes

- 6ada721: Fix Node 22 crash caused by `@actions/workflow-parser` importing JSON without the required `type: "json"` import attribute. A custom ESM loader hook now transparently adds the missing attribute at runtime. Fixes #67.
  - dtu-github-actions@0.3.4

## 0.3.3

### Patch Changes

- fix(dtu): replace execa with node:child_process to fix production runtime error
- Updated dependencies
  - dtu-github-actions@0.3.3

## 0.3.2

### Patch Changes

- 0d5a027: Fix rejected promise handling in job execution and refactor error handling to use type guards with `taskName` attached to errors.
- Fix `npx @redwoodjs/agent-ci` failing with "import: command not found" by adding the missing `#!/usr/bin/env node` shebang to the CLI entry point.
  - dtu-github-actions@0.3.2

## 0.3.1

### Patch Changes

- 6e0ace7: Fix rejected promise handling in job execution and refactor error handling to use type guards with `taskName` attached to errors.
  - dtu-github-actions@0.3.1

## 0.3.0

### Minor Changes

- 8510ce1: Add workflow compatibility features: cross-job outputs, job-level `if` conditions, `fromJSON()`/`toJSON()`, and `strategy.fail-fast` support.

### Patch Changes

- Updated dependencies [9b34858]
  - dtu-github-actions@0.3.0

## 0.2.0

### Minor Changes

- 7bce818: Initial release.

### Patch Changes

- e074b4c: Updated documentation.
- Updated dependencies [7bce818]
  - dtu-github-actions@0.2.0
