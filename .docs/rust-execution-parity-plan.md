# Rust Execution Parity Plan

This plan covers the remaining work required before Local CI can remove the TypeScript CLI implementation and run entirely through the native Rust binary.

## Current status

- Rust has broad module coverage for parsing, state, DTU APIs, Docker config, runner images, macOS VM helpers, packaging, and validation scaffolding.
- Rust `local-ci run` can execute Docker-backed Linux jobs through the Rust DTU behind the opt-in Rust path.
- The TypeScript CLI remains the default execution path until the remaining parity phases pass.
- `RUST-084` is blocked until this plan is complete.

## Acceptance criteria

Rust is at full parity when all of the following are true:

- `target/debug/local-ci run --workflow <workflow>` can execute real jobs end-to-end.
- Rust can run Docker-backed Linux jobs with caches, artifacts, services, outputs, and matrix expansion.
- Rust can pause, retry, and abort failed jobs with the same behavior as TypeScript.
- Rust can execute or correctly skip/degrade macOS VM jobs with matching messages.
- `pnpm rust:smoke:parity` expects successful execution instead of the current discovery-only gap.
- `pnpm local-ci-dev run --all -q -p --json` passes with the Rust path enabled.
- The TypeScript fallback can be removed without losing any documented capability.

## Phase 0 — Guardrails

- [x] **RXP-000: Keep TypeScript fallback until parity is proven**
  - [x] Keep `LOCAL_CI_FORCE_TYPESCRIPT=1` documented.
  - [x] Keep npm launcher fallback enabled.
  - [x] Do not remove TypeScript execution code before `RXP-080` passes.
  - Test: `pnpm golden:cli`

- [x] **RXP-001: Add an explicit Rust execution feature flag**
  - [x] Add `LOCAL_CI_FORCE_RUST=1` or equivalent for local parity testing.
  - [x] Make default behavior conservative while Rust execution is incomplete.
  - [x] Ensure unsupported Rust execution falls back or fails with a clear message.
  - Test: launcher unit tests + `pnpm golden:cli`

- [x] **RXP-002: Convert current discovery-gap smoke script into a gate**
  - [x] Keep current discovery-only assertions while work is incomplete.
  - [x] Add a mode that expects real execution success.
  - [x] Document how/when to flip the default expectation.
  - Test: `pnpm rust:smoke:parity`

## Phase 1 — Rust run orchestrator

- [x] **RXP-010: Introduce Rust run orchestrator**
  - [x] Replace `run_command.rs` discovery-only flow with an orchestration layer.
  - [x] Keep discovery as a pure planning phase.
  - [x] Return typed run/job plans before execution.
  - Test: Rust unit tests for workflow-to-run-plan conversion.

- [x] **RXP-011: Job scheduler parity**
  - [x] Port job dependency ordering.
  - [x] Port `needs` result propagation.
  - [x] Port `if` evaluation for jobs.
  - [x] Preserve `always()`, `success()`, `failure()`, and skipped-job behavior.
  - Test: Rust scheduler tests mirroring TypeScript scheduler fixtures; revalidated for schedule-keyed matrix leg results, aggregate `needs.<job>.result`, and cyclic dependency errors.

- [x] **RXP-012: Matrix orchestration parity**
  - [x] Wire expanded matrix jobs into the scheduler.
  - [x] Preserve runner names and strategy metadata.
  - [x] Preserve `--no-matrix` collapse behavior.
  - Test: Rust matrix smoke plus `.github/workflows/smoke-matrix.yml`; revalidated with the shared `matrix-needs-aggregate` fixture and schedule-keyed needs propagation.

- [x] **RXP-013: NDJSON event stream parity**
  - [x] Emit `run.start`, `job.start`, `step.start`, `step.finish`, `job.finish`, `run.finish`.
  - [x] Preserve schema version and event shapes.
  - [x] Preserve quiet/agent mode behavior.
  - Test: Rust golden NDJSON tests against TypeScript output.

## Phase 2 — Real Docker runtime

- [x] **RXP-020: Add concrete Docker client implementation**
  - [x] Implement container create/start/wait/remove.
  - [x] Implement network create/remove.
  - [x] Implement log streaming.
  - [x] Reuse existing Rust Docker config builders.
  - Test: Docker integration test behind an opt-in env flag.

- [x] **RXP-021: Runner container execution**
  - [x] Start official runner containers from Rust.
  - [x] Register runner with Rust DTU.
  - [x] Seed jobs and wait for runner completion.
  - [x] Collect exit status and logs.
  - Test: Minimal one-step workflow executes through Rust.

- [x] **RXP-022: Workspace and git sync parity**
  - [x] Port working-tree snapshot behavior.
  - [x] Include uncommitted tracked and untracked changes.
  - [x] Preserve ignored-file exclusions.
  - [x] Preserve dirty SHA semantics.
  - Test: Rust dirty-worktree execution tests.

- [x] **RXP-023: Cache/toolcache mount parity**
  - [x] Mount npm/pnpm/yarn/bun caches.
  - [x] Mount Playwright and Cypress caches safely.
  - [x] Mount hosted toolcache.
  - [x] Preserve permission fixes and hints.
  - Test: cache smoke workflows through Rust.

- [x] **RXP-024: Docker socket and Docker-in-Docker parity**
  - [x] Mount Docker socket correctly.
  - [x] Preserve host gateway handling.
  - [x] Support `docker buildx` smoke workflow.
  - Test: `.github/workflows/smoke-docker-buildx.yml` through Rust.

## Phase 3 — DTU execution integration

- [x] **RXP-030: Wire Rust DTU into top-level run**
  - [x] Start DTU per run.
  - [x] Expose CLI URL and container URL.
  - [x] Seed jobs from orchestrator.
  - [x] Stop DTU after run or keep alive during pause.
  - Test: one-job Rust execution with official runner.

- [x] **RXP-031: Cache API parity under real runner**
  - [x] Validate `actions/cache` restore miss/hit/save flows.
  - [x] Preserve virtual cache pattern behavior.
  - [x] Preserve local bind-mount fast path.
  - Test: cache smoke workflows through Rust.

- [x] **RXP-032: Artifact API parity under real runner**
  - [x] Validate upload/download artifact actions.
  - [x] Preserve REST and Twirp/block-blob behavior.
  - [x] Preserve artifact paths and metadata.
  - Test: `.github/workflows/smoke-artifacts.yml` through Rust.

- [x] **RXP-033: Action download parity**
  - [x] Serve local action tarballs.
  - [x] Serve pinned remote action tarballs from cache/download path.
  - [x] Preserve private reusable workflow auth behavior.
  - Test: checkout/setup/cache/action smoke workflows through Rust.

## Phase 4 — Steps, env, outputs, and services

- [x] **RXP-040: Step env parity**
  - [x] Evaluate workflow/job/step env.
  - [x] Inject GitHub, runner, strategy, matrix, secrets, vars, and inputs contexts.
  - [x] Preserve shell env precedence.
  - Test: `.github/workflows/smoke-env-*.yml` through Rust.

- [x] **RXP-041: Step condition parity**
  - [x] Port step-level `if` behavior into Rust execution.
  - [x] Preserve skipped-step timeline status.
  - [x] Preserve `always()` handling.
  - Test: `.github/workflows/smoke-step-if.yml` through Rust.

- [x] **RXP-042: Step outputs and job outputs parity**
  - [x] Capture `$GITHUB_OUTPUT` writes.
  - [x] Resolve step outputs into job outputs.
  - [x] Propagate outputs through `needs`.
  - Test: `.github/workflows/smoke-outputs.yml` through Rust.

- [x] **RXP-043: Service container parity**
  - [x] Start services before runner job.
  - [x] Attach services to the correct network.
  - [x] Preserve health checks, ports, env, and cleanup.
  - Test: service smoke workflows through Rust.

- [x] **RXP-044: Container options parity**
  - [x] Apply workflow container options.
  - [x] Preserve env, labels, volumes, and network settings.
  - Test: `.github/workflows/smoke-container-options.yml` through Rust.

## Phase 5 — Pause, retry, abort

- [x] **RXP-050: Pause-on-failure parity**
  - [x] Keep runner container and DTU alive after a failed step.
  - [x] Write signal files compatible with current retry/abort commands.
  - [x] Emit `run.paused` and exit code `77` from launcher path.
  - Test: `.github/workflows/smoke-pause-pipe.yml` through Rust.

- [x] **RXP-051: Retry failed step parity**
  - [x] Resume paused container.
  - [x] Retry only failed step by default.
  - [x] Preserve attempts and logs.
  - Test: retry proof smoke workflow through Rust.

- [x] **RXP-052: Retry from step/from start parity**
  - [x] Implement `--from-step` rewind behavior.
  - [x] Implement `--from-start` behavior.
  - [x] Preserve skipped earlier steps.
  - Test: retry unit/integration tests through Rust.

- [x] **RXP-053: Abort parity**
  - [x] Tear down paused runner and services.
  - [x] Remove signal dirs.
  - [x] Preserve user-facing messages.
  - Test: abort integration test through Rust.

## Phase 6 — macOS VM integration

- [x] **RXP-060: Wire macOS VM jobs into scheduler**
  - [x] Route `runs-on: macos-*` jobs to Rust macOS VM execution.
  - [x] Preserve Docker/Linux scheduling for other jobs.
  - Test: macOS routing unit tests.

- [x] **RXP-061: macOS VM run parity**
  - [x] Pull/clone/start Tart VM.
  - [x] Wait for IP and SSH.
  - [x] Sync workspace and runner binary.
  - [x] Run job and sync logs back.
  - Test: opt-in macOS integration test on Apple Silicon (`target/debug/local-ci run --workflow .github/workflows/macos.yml -q --json` on Apple Silicon Tart host).

- [x] **RXP-062: macOS skip/degraded parity**
  - [x] Preserve unsupported-host skip reasons.
  - [x] Preserve install hints for Tart and sshpass.
  - [x] Preserve behavior on Linux/Intel hosts.
  - Test: host capability unit tests and smoke skip checks (`PATH=/usr/bin:/bin target/debug/local-ci run --workflow .github/workflows/macos.yml -q --json`).

## Phase 7 — Result writing and reporting

- [x] **RXP-070: Run result JSON parity**
  - [x] Match TypeScript `run-result.json` shape.
  - [x] Include debug logs, step logs, outputs, durations, and status.
  - [x] Preserve branch/repo path layout.
  - Test: state golden/unit coverage plus live Rust result smoke with step `logPath` and non-zero `durationMs`.

- [x] **RXP-071: Human reporter parity**
  - [x] Match summary/failure output.
  - [x] Preserve hints for missing tools and toolcache permissions.
  - [x] Preserve quiet and JSON modes.
  - Test: reporter unit tests plus live failing Rust workflow smoke.

- [x] **RXP-072: Cleanup parity**
  - [x] Remove containers/networks/services on success/failure.
  - [x] Preserve paused resources only when requested.
  - [x] Preserve log pruning behavior.
  - Test: Docker cleanup unit/integration checks (`failed_start_cleans_up_services_and_network`, live failure smoke, `docker ps -a` cleanup check).

## Phase 8 — Full parity validation

- [x] **RXP-080: Flip Rust smoke parity to execution success**
  - [x] Update `scripts/rust-smoke-parity.mjs` to expect exit code `0`.
  - [x] Remove the expected discovery-gap assertion.
  - [x] Keep the smoke workflow list expanding over time.
  - Test: `pnpm rust:smoke:parity`

- [x] **RXP-081: Run core smoke workflows through Rust**
  - [x] `smoke-binary.yml`
  - [x] `smoke-expressions.yml`
  - [x] `smoke-matrix.yml`
  - [x] `smoke-artifacts.yml`
  - [x] `smoke-docker-buildx.yml`
  - [x] `smoke-pause-pipe.yml`
  - Test: `pnpm rust:smoke:parity` covers artifacts, docker-buildx, and pause-pipe in CI.

- [x] **RXP-081b: Port job-wave concurrency**
  - [x] Rust preserves dependency-wave ordering and runs jobs inside each wave concurrently.
  - [x] The native CLI honors `--jobs` as the per-wave concurrency limit.
  - [x] macOS VM execution is capped independently with `LOCAL_CI_MACOS_VM_CONCURRENCY` (default: `2`).
  - Test: Rust CLI parsing tests plus smoke parity/full dev validation exercise the native limiter path.

- [x] **RXP-082: Run all in-repo workflows through Rust**
  - [x] Enable Rust path for the full dev validation.
  - [x] Fix any remaining parity failures.
  - [x] Record unsupported intentional skips.
  - Test: `LOCAL_CI_FORCE_RUST=1 pnpm local-ci-dev run --all -q -p --json`

- [x] **RXP-083: Release-mode benchmarks**
  - [x] Benchmark release Rust binary startup.
  - [x] Benchmark parse/discovery.
  - [x] Benchmark orchestration overhead.
  - [x] Update `.docs/rust-performance.md`.
  - Test: `pnpm rust:perf`

## Phase 9 — Default switch and TypeScript removal

See also [rust-crate-split-and-fixtures RFC](rfcs/rust-crate-split-and-fixtures.md) for the long-term fixture contract layer.

- [ ] **RXP-090: Make Rust execution default**
  - [ ] Route npm launcher to native Rust binary by default.
  - [ ] Keep TypeScript fallback for one release.
  - [ ] Document fallback/rollback.
  - Test: full `pnpm local-ci-dev run --all -q -p --json` with default settings.

- [ ] **RXP-091: Remove TypeScript execution fallback**
  - [ ] Remove TypeScript CLI execution modules.
  - [ ] Remove fallback launcher path.
  - [ ] Keep only necessary JS packaging shim if npm still needs it.
  - Test: full `pnpm local-ci-dev run --all -q -p --json`.

- [ ] **RXP-092: Remove unused dependencies**
  - [ ] Remove Docker/runner/workflow TS dependencies no longer used.
  - [ ] Keep only package/build dependencies required for npm distribution.
  - [ ] Update lockfile.
  - Test: `pnpm install --lockfile-only && pnpm check`.

- [ ] **RXP-093: Final docs update**
  - [ ] Update README to describe native Local CI.
  - [ ] Update release docs.
  - [ ] Update migration/rollback notes.
  - Test: docs links and full dev validation.

## Required validation cadence

For each checked-off implementation task:

1. Run targeted unit/integration tests for that task.
2. Run Rust checks:

   ```bash
   cargo fmt --all
   cargo check --workspace --all-targets
   cargo clippy --workspace --all-targets -- -D warnings
   cargo test --workspace --all-targets
   ```

3. Run Node checks when package/launcher/workflow behavior changes:

   ```bash
   pnpm check
   pnpm golden:cli
   ```

4. Before reporting the overall work complete, run:

   ```bash
   pnpm local-ci-dev run --all -q -p --json
   ```
