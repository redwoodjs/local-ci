# RFC: Rust Native Binary Rewrite

## Status

Accepted as the working plan for the Rust rewrite checklist in [`../rust-rewrite-tasks.md`](../rust-rewrite-tasks.md).

## Problem

Local CI is currently distributed as an npm-installed Node.js CLI. That works well for JavaScript users, but it ties every install path to a Node runtime and npm-compatible package installation. We want Local CI to become a native binary so users can install it through npm, GitHub Releases, Homebrew, and other package managers without changing the CLI contract.

## Goals

- Keep the existing `local-ci` command and CLI behavior stable.
- Keep `npm install local-ci` and `npx run-local-ci` working.
- Add direct native binary installs for users who do not want npm.
- Preserve compatibility with the official GitHub Actions runner.
- Preserve current pause/retry, cache, artifact, Docker, and macOS VM behavior.
- Migrate safely with tests that compare the Rust implementation against the TypeScript implementation before switching defaults.

## Non-goals

- Do not rewrite the official GitHub Actions runner.
- Do not remove npm distribution during the migration.
- Do not switch the default implementation until smoke workflow parity is proven.
- Do not intentionally change the public CLI interface as part of the rewrite.

## Language choice

The native implementation will be written in Rust.

Reasons:

- Mature ecosystem for HTTP servers/clients, async orchestration, Docker clients, YAML parsing, filesystem work, and cross-platform releases.
- Good binary distribution story for Linux and macOS on x64 and arm64.
- Strong type system and memory safety for a long-running orchestration tool.
- Good test tooling for golden CLI tests, integration tests, and benchmarks.

## Migration strategy

Use an incremental side-by-side migration:

1. Add a Rust workspace and native `local-ci` binary crate.
2. Implement low-risk CLI behavior first: help text, config/env loading, `clean`, `retry`, and `abort`.
3. Add golden tests that compare Rust output to the current TypeScript CLI.
4. Port workflow parsing and scheduling.
5. Port the DTU server.
6. Port Docker and macOS runner execution.
7. Run the existing smoke workflows through the Rust binary.
8. Switch the npm package launcher to prefer the Rust binary after parity is proven.
9. Keep a temporary TypeScript fallback during the first native release window.
10. Remove the TypeScript implementation only after the Rust binary has passed the full smoke suite and at least one release cycle.

## Supported platforms

Initial native binary targets:

- `aarch64-apple-darwin` — macOS Apple Silicon
- `x86_64-apple-darwin` — macOS Intel
- `x86_64-unknown-linux-gnu` — Linux x64
- `aarch64-unknown-linux-gnu` — Linux arm64

Windows is not an initial target because Local CI does not currently support Windows workflow execution locally. The Rust code should avoid unnecessary Unix-only assumptions outside runner execution paths so Windows support can be evaluated later.

## TypeScript fallback policy

The TypeScript implementation remains available until all of these are true:

- The Rust binary passes golden CLI tests against the TypeScript CLI.
- The Rust binary passes the existing smoke workflow suite.
- npm, direct binary, and Homebrew installs all run the same Rust binary.
- A rollback path is documented.
- A native release has shipped without blocking regressions.

The fallback can then be removed in a later cleanup task.

## Install and distribution targets

### npm

The npm package remains the compatibility install path.

Planned shape:

- `local-ci` keeps the public package name and `local-ci` bin entry.
- The package ships a small JavaScript launcher.
- The launcher resolves a platform-specific optional package when available.
- If no platform package is available during the migration window, the launcher can fall back to the TypeScript implementation.

### GitHub Releases

Each release should attach native binaries and checksums for the supported platforms. The assets are the source of truth for direct downloads, Homebrew, and the shell installer.

### Homebrew

A Homebrew formula should install the macOS binaries from GitHub Releases and include a smoke test such as `local-ci --help`.

### Shell installer

A shell installer is optional, but if added it should:

- Detect OS and architecture.
- Download the matching release asset.
- Verify checksums.
- Install into a user-selected prefix.

## Testing gates

Every checklist item should define the smallest meaningful test before being marked complete. Examples:

- CLI tasks: Rust unit tests and golden output comparisons.
- Config tasks: fixture-based environment and `.env.local-ci` tests.
- Workflow tasks: fixture workflows and smoke workflow parity.
- DTU tasks: HTTP route tests and runner protocol fixtures.
- Docker tasks: container config unit tests plus local smoke workflows.
- Packaging tasks: archive/package smoke tests for each supported target.

Do not advance a task checkbox unless its specific tests pass.

## Rollback plan

Until the default switch is complete, rollback is simple: keep the npm launcher pointed at the TypeScript implementation or restore the TypeScript fallback path. After the Rust binary becomes the only implementation, rollback should use a normal patch release that restores the previous known-good binary or re-enables the fallback launcher.
