# Rust Native Binary Rewrite Tasks

This is the working checklist for moving Local CI from a Node/TypeScript CLI to a native Rust binary while keeping npm install support and adding direct binary distribution.

## Phase 0 — Planning

- [x] **RUST-000: Rust rewrite RFC**
  - [x] Define the migration strategy.
  - [x] Decide which platforms are supported first.
  - [x] Decide how long the TypeScript implementation remains available as a fallback.
  - [x] Document install targets: npm, GitHub Releases, Homebrew, and optional shell installer.
  - Test: `pnpm format:check`

- [x] **RUST-001: Rust workspace scaffold**
  - [x] Add a Cargo workspace.
  - [x] Add the native `local-ci` binary crate.
  - [x] Add `cargo fmt`, `cargo check`, `cargo clippy`, and test scripts.
  - [x] Add initial CI checks for the Rust workspace.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

## Phase 1 — CLI Parity Foundation

- [x] **RUST-010: CLI argument parser**
  - [x] Implement `local-ci --help`.
  - [x] Define commands: `run`, `retry`, `abort`, and `clean`.
  - [x] Match the existing usage text closely enough for golden tests.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`
  - Test: `diff -u <(node packages/cli/src/cli.ts --help) <(cargo run --quiet -p local-ci -- --help)`

- [x] **RUST-011: Config/env loading**
  - [x] Port `.env.local-ci` loading.
  - [x] Support `LOCAL_CI_*` environment variables.
  - [x] Preserve shell environment precedence.
  - [x] Preserve `DOCKER_HOST` rejection behavior.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`
  - Test: `DOCKER_HOST=unix:///bad.sock cargo run --quiet -p local-ci -- --help` exits 1 with the rename error

- [x] **RUST-012: Log/state directory handling**
  - [x] Port the current log directory layout.
  - [x] Preserve run metadata file formats.
  - [x] Preserve result file formats used by agents and tests.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

## Phase 2 — Low-Risk Commands

- [x] **RUST-020: `clean` command**
  - [x] Port old log pruning behavior.
  - [x] Preserve retention rules.
  - [x] Add parity tests against fixture directories.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-021: `retry` / `abort` commands**
  - [x] Port paused runner signaling.
  - [x] Keep the signaling protocol compatible with the TypeScript implementation.
  - [x] Support retrying the failed step.
  - [x] Support `--from-step <N>`.
  - [x] Support `--from-start`.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

## Phase 3 — Workflow Parsing

- [x] **RUST-030: Workflow file loading**
  - [x] Parse GitHub Actions YAML.
  - [x] Preserve unsupported-feature diagnostics.
  - [x] Add fixtures for existing smoke workflows.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-031: `run --workflow` discovery**
  - [x] Load one workflow file.
  - [x] Discover runnable jobs.
  - [x] Preserve current default SHA behavior.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-032: `run --all` discovery**
  - [x] Discover relevant workflows for the current branch/event.
  - [x] Preserve path/filter behavior.
  - [x] Preserve skipped-workflow reporting.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-033: Matrix expansion**
  - [x] Port matrix include/exclude behavior.
  - [x] Preserve generated job names.
  - [x] Support `--no-matrix`.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-034: Expression evaluation**
  - [x] Port required GitHub expression behavior.
  - [x] Cover string functions like `contains`, `startsWith`, and `endsWith`.
  - [x] Cover contexts used by existing smoke tests.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-035: Reusable workflows**
  - [x] Support local reusable workflows.
  - [x] Support remote reusable workflow fetching.
  - [x] Preserve remote workflow cache behavior.
  - [x] Preserve `--github-token` behavior.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

## Phase 4 — DTU Server

- [x] **RUST-040: Ephemeral DTU server**
  - [x] Start a local mock GitHub Actions API server.
  - [x] Stop it cleanly after runs.
  - [x] Preserve assigned URLs and environment values expected by runners.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-041: Runner registration/job endpoints**
  - [x] Port endpoints used by the official GitHub Actions runner.
  - [x] Preserve runner registration flow.
  - [x] Preserve job assignment flow.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-042: Cache API**
  - [x] Port local cache restore behavior.
  - [x] Port local cache save behavior.
  - [x] Preserve cache key/version matching behavior.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-043: Artifact API**
  - [x] Port artifact upload behavior.
  - [x] Port artifact download behavior.
  - [x] Preserve Azure block blob compatibility used by actions.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

## Phase 5 — Docker Runner Execution

- [x] **RUST-050: Docker socket resolution**
  - [x] Port default Docker socket behavior.
  - [x] Port OrbStack handling.
  - [x] Port Docker Desktop handling.
  - [x] Preserve diagnostics and hints.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-051: Container config builder**
  - [x] Port environment variable construction.
  - [x] Port bind mounts.
  - [x] Port extra hosts.
  - [x] Port Docker network settings.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-052: Runner image handling**
  - [x] Pull the default runner image.
  - [x] Build custom runner images from `.github/local-ci.Dockerfile`.
  - [x] Preserve image hash/tag behavior.
  - [x] Preserve missing-tool hints.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-053: Job execution**
  - [x] Start runner containers.
  - [x] Stream logs.
  - [x] Collect timeline files.
  - [x] Build job results.
  - [x] Write run summaries.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-054: Service containers**
  - [x] Port workflow service container creation.
  - [x] Port service networking.
  - [x] Port service health checks.
  - [x] Port cleanup behavior.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-055: Pause/retry on failure**
  - [x] Preserve paused container lifecycle.
  - [x] Preserve paused runner reporting.
  - [x] Retry failed step.
  - [x] Retry from a specific step.
  - [x] Retry from the start.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

## Phase 6 — macOS VM Support

- [x] **RUST-060: macOS host capability detection**
  - [x] Detect supported Apple Silicon hosts.
  - [x] Detect `tart`.
  - [x] Detect `sshpass`.
  - [x] Preserve skip reasons and install hints.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-061: Tart VM lifecycle**
  - [x] Clone/start VMs.
  - [x] Resolve VM IP addresses.
  - [x] Stop/delete VMs after runs.
  - [x] Preserve concurrency limits.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-062: macOS runner binary caching**
  - [x] Fetch the macOS Actions runner binary.
  - [x] Cache it on the host.
  - [x] Reuse it across runs.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-063: macOS job execution parity**
  - [x] Copy workspace into the VM.
  - [x] Configure runner credentials.
  - [x] Stream logs/results back to the host.
  - [x] Preserve skip/degraded reporting.
  - Test: `cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

## Phase 7 — Packaging and Distribution

- [x] **RUST-070: Native release build workflow**
  - [x] Build Linux x64 binary.
  - [x] Build Linux arm64 binary.
  - [x] Build macOS x64 binary.
  - [x] Build macOS arm64 binary.
  - [x] Sign/notarize macOS binaries if required.
  - Test: `node --input-type=module -e "import fs from 'node:fs'; import YAML from 'yaml'; const doc = YAML.parse(fs.readFileSync('.github/workflows/native-binaries.yml','utf8')); if (!doc.jobs?.build?.strategy?.matrix?.include || doc.jobs.build.strategy.matrix.include.length !== 4) throw new Error('native matrix missing targets')" && cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-071: npm native binary packages**
  - [x] Keep `npm install local-ci` working.
  - [x] Add platform-specific optional packages.
  - [x] Add a small JS launcher that resolves the native binary.
  - [x] Preserve `npx run-local-ci` behavior.
  - Test: `pnpm --filter run-local-ci test && pnpm --filter run-local-ci typecheck && pnpm check && pnpm --filter run-local-ci build && LOCAL_CI_FORCE_TYPESCRIPT=1 node packages/cli/dist/native-launcher.js --help && cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-072: GitHub Release assets**
  - [x] Publish downloadable binaries.
  - [x] Publish checksums.
  - [x] Document direct download usage.
  - Test: `node --input-type=module -e "import fs from 'node:fs'; import YAML from 'yaml'; const doc = YAML.parse(fs.readFileSync('.github/workflows/native-binaries.yml','utf8')); if (doc.permissions.contents !== 'write') throw new Error('release upload needs contents write'); const steps = doc.jobs.build.steps.map(s => s.name).filter(Boolean); if (!steps.includes('Publish GitHub Release assets')) throw new Error('missing release upload step')" && pnpm --filter run-local-ci test && pnpm check && cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-073: Homebrew formula**
  - [x] Create or update a Homebrew tap.
  - [x] Install the native binary.
  - [x] Add a smoke test to the formula.
  - Test: `node scripts/render-homebrew-formula.mjs v0.16.1 <checksums-dir> <out-file> && grep -q 'bin.install "local-ci"' <out-file> && grep -q 'local-ci --help' <out-file> && pnpm check && cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-074: Shell installer**
  - [x] Add optional `curl | sh` installer.
  - [x] Detect OS and architecture.
  - [x] Verify checksums.
  - [x] Install into a user-selected prefix.
  - Test: `LOCAL_CI_BASE_URL=file://<tmp>/releases LOCAL_CI_OS=linux LOCAL_CI_ARCH=x64 ./install.sh --version v0.0.0 --prefix <tmp>/install && <tmp>/install/bin/local-ci && pnpm check && cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

## Phase 8 — Validation and Migration

- [x] **RUST-080: Golden CLI tests**
  - [x] Compare TypeScript and Rust output for `--help`.
  - [x] Compare common error messages.
  - [x] Compare basic command behavior.
  - Test: `pnpm golden:cli && pnpm check && cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-081: Smoke workflow parity**
  - [x] Run existing smoke workflows through the Rust binary.
  - [x] Track unsupported gaps.
  - [x] Close parity gaps before switching defaults.
  - Test: `pnpm rust:smoke:parity && pnpm check && cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-082: Performance benchmarks**
  - [x] Measure startup time.
  - [x] Measure workflow parse time.
  - [x] Measure job orchestration overhead.
  - [x] Compare against the TypeScript implementation.
  - Test: `pnpm rust:perf && pnpm check && cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [x] **RUST-083: Default binary switch**
  - [x] Make the Rust implementation the default `local-ci` binary.
  - [x] Keep TypeScript fallback temporarily if needed.
  - [x] Document rollback instructions.
  - Test: `pnpm golden:cli && pnpm check && cargo fmt --all && cargo check --workspace --all-targets && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`

- [ ] **RUST-084: Remove TypeScript implementation**
  - [ ] Remove obsolete TypeScript CLI code after parity is proven.
  - [ ] Remove fallback launcher code.
  - [ ] Remove unused dependencies.
  - [ ] Update docs to describe the native implementation.
  - Blocked: top-level Rust `run` still has the execution gap tracked in `.docs/rust-smoke-parity.md`; keep the TypeScript fallback until `.docs/rust-execution-parity-plan.md` is complete.
