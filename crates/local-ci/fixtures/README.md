# Local CI Rust fixtures

Machine-readable contracts for the native Rust implementation. See
[.docs/rfcs/rust-crate-split-and-fixtures.md](../../../.docs/rfcs/rust-crate-split-and-fixtures.md).

## Layout

- `workflows/` — workflow YAML inputs
- `plans/` — expected planning output (schedule waves, job ids) loaded by Rust and TypeScript fixture checks
- `events/` — normalized NDJSON event contracts
- `run-results/` — normalized run-result JSON contracts
- `docker-socket/` — Docker socket resolution contracts
- `job-limits/` — default concurrency limit vectors

Add a workflow + expected plan snapshot together. Keep snapshots stable: no absolute paths,
timestamps, or host-specific values.
