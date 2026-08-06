# RFC: Rust crate split + fixture contract layer

## Status

Implemented — companion to [rust-native-binary-rewrite.md](./rust-native-binary-rewrite.md) and [rust-execution-parity-plan.md](../rust-execution-parity-plan.md).

## Problem

The native Rust implementation (~16k LOC) mirrors the TypeScript CLI without a shared contract layer. Parity is enforced by smoke workflows and a thin golden CLI check, but logic drift is still likely (`--all` orchestration, default job limits, plan shapes, NDJSON events).

The single `local-ci` crate also mixes pure planning (workflow parse, schedule, expr) with IO-heavy runtime code (docker, dtu, macos_vm), slowing compile/test loops and making boundaries easy to violate.

## Goals

1. Split the workspace into **pure core** vs **runtime** vs **thin CLI bin**.
2. Introduce **fixture-driven contracts** both Rust and TypeScript must pass before Phase 9 (default switch).
3. Keep the public `local-ci` command unchanged.

## Non-goals

- Rewriting the DTU in a third language or deleting TS before RXP-090.
- Async/tokio migration (blocking subprocess model stays until a measured need).
- Publishing fixture schemas to npm in v1 of this RFC.

## Proposed crate layout

```
crates/
  local-ci-core/          # pure domain — no std::process, no TcpListener
    workflow/
    expr/
    matrix/
    plan/                 # RunPlan, schedule, decide, route (no execute)
    reusable/             # reusable workflow expansion + refs
    events/               # NDJSON event types + serialization
    state/                # run-result.json types

  local-ci-runtime/       # IO + traits
    docker/
    dtu/
    runner/
    macos_vm/
    workspace/
    wave/                 # ConcurrentJobPool + default concurrency limits

  local-ci/               # binary + lib re-exports for tests
    main.rs               # exit codes, stdio only
    cli/                  # clap (future), env bootstrap

  local-ci-fixtures/      # optional test-only crate: load + assert fixtures
```

Dependency direction: `local-ci` → `local-ci-runtime` → `local-ci-core`. Nothing in `core` depends on `runtime`.

### Migration phases

| Phase | Work                                                    | Gate                          | Status |
| ----- | ------------------------------------------------------- | ----------------------------- | ------ |
| RCS-1 | Extract `local-ci-core` with workflow/expr/plan modules | `cargo test -p local-ci-core` | Done   |
| RCS-2 | Move docker/dtu/runner/macos_vm to `local-ci-runtime`   | existing `cargo test` green   | Done   |
| RCS-3 | Thin bin crate; `lib.rs` loses USAGE string             | `golden:cli`                  | Done   |
| RCS-4 | Fixture contract CI (below)                             | TS + Rust both pass           | Done   |

Each phase is a mergeable PR. No big-bang split.

## Fixture contract layer

### Directory layout

```
crates/local-ci/fixtures/
  README.md
  workflows/              # input YAML
  plans/                  # expected RunPlan JSON (stable subset)
  events/                 # expected NDJSON lines per scenario
  run-results/            # expected run-result.json
  docker-socket/          # env + expected resolution (from existing TS tests)
  job-limits/             # CPU/memory default concurrency vectors
```

### Contract rules

1. **Plans** — JSON snapshots of `RunPlan` with stable fields only (job ids, schedule waves, runner names, routes). Omit timestamps and absolute paths.
2. **Events** — Normalized NDJSON: strip `ts`, `runId`, durations, and volatile paths before compare.
3. **Run results** — Schema version + job names + status; omit timestamps, SHAs, absolute paths, and duration jitter in unit fixtures.
4. **Docker socket** — Probe input + expected socket URI/bind mount, or expected error substrings.
5. **Job limits** — Shared CPU/memory vectors for the default concurrency calculation.
6. **TS runner** — `pnpm fixtures:check` runs the same loader against TS plan/output/socket helpers (Phase RCS-4).

### CI integration

`.github/workflows/tests.yml` runs the fixture contracts after Rust unit tests:

```yaml
- name: Check fixture contracts
  run: |
    cargo test -p local-ci-core fixture
    cargo test -p local-ci-runtime docker_socket_fixture_contracts_match_snapshots
    pnpm fixtures:check
```

`pnpm fixtures:check` compares the TypeScript plan, event, run-result, Docker socket, and job-limit helpers to the same committed fixtures.

### Adding a fixture

1. Add `workflows/my-case.yml`.
2. Run `cargo test plan_fixture_my_case -- --nocapture` once to bless snapshot (or hand-write minimal JSON).
3. PR must include both input and expected output.

## Error model (follow-up hardening)

Initial typed boundary coverage is in place for Docker socket resolution (`DockerSocketError`). Future hardening can continue replacing `Result<T, String>` at crate boundaries with:

```rust
#[derive(Debug, thiserror::Error)]
pub enum Error { ... }
```

Convert to user strings in `local-ci` bin only. Prioritize `plan`, `docker`, `wave` modules first.

## DTU typing (follow-up hardening)

The runtime crate boundary is now in place for DTU internals. A later DTU-only refactor can replace `BTreeMap<String, Value>` job storage with:

```rust
struct RunnerSession { ... }
struct DtuStateInner {
    runners: BTreeMap<RunnerName, RunnerSession>,
    cache: CacheStore,
    artifacts: ArtifactStore,
}
```

Single `Mutex<DtuStateInner>`. Serialize to JSON at HTTP handlers only.

## CLI (follow-up hardening)

The CLI parser/help now lives in `local-ci/src/cli.rs`; `lib.rs` only exposes modules and re-exports. A later ergonomics-only change can replace the hand-written usage string with `clap` derive while keeping `golden:cli` as the compatibility gate.

## Wave executor

`local-ci-runtime/src/wave.rs` owns the generic concurrent worker pool, while `run_command/wave.rs` keeps Local CI-specific job dispatch:

- `SharedExecutionContext` behind `Arc` (no per-worker clone).
- `run_concurrent_workers` — testable concurrency primitive with unit tests for `max_jobs`.
- Future: global session limiter for `--all` wraps multiple `execute_wave_jobs` calls.

## Success criteria

- `cargo test -p local-ci-core` completes in &lt;5s on CI.
- At least 10 plan fixtures cover matrix, needs, reusable, macOS route, skip-if.
- No file in `local-ci-core` imports `std::process::Command`.
- TS and Rust both pass fixture CI before RXP-090.

## Decisions

1. Fixtures live in-repo under `crates/local-ci/fixtures` so Rust and TypeScript checks share one committed contract source.
2. Snapshots are committed JSON, not `insta`, to keep TS consumption simple.
3. TS `workflow-parser.ts` stays until the native path is the default and RXP-090 follow-ups decide the deletion point.

## References

- [rust-execution-parity-plan.md](../rust-execution-parity-plan.md) — RXP-081b concurrency, RXP-090 default switch
- [rust-native-binary-rewrite.md](./rust-native-binary-rewrite.md) — migration strategy
- `scripts/golden-cli-rust.mjs` — existing CLI help contract
- `scripts/rust-smoke-parity.mjs` — end-to-end smoke contract
