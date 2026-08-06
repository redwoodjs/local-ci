---
name: local-ci
description: Run GitHub Actions CI locally with Local CI to validate changes before pushing. Use when testing, running checks, or validating code changes.
license: MIT
compatibility: Requires Node.js 18+ and Docker
metadata:
  author: redwoodjs
  version: "1.0.0"
---

# Local CI

Run the full CI pipeline locally before pushing. CI was green before you started — any failure is caused by your changes.

## Run

```bash
npx run-local-ci run --quiet --all --pause-on-failure
```

Pipes are safe — pause-on-failure works through `| tee log`, `> log.txt`, etc. When stdout isn't a TTY the launcher detaches the run and the foreground process exits **77** the moment a step pauses, freeing the pipe while the container stays paused for `retry`.

## Retry

When a step fails, the run pauses automatically. Fix the issue, then retry:

```bash
npx run-local-ci retry --name <runner-name>
```

To re-run from an earlier step:

```bash
npx run-local-ci retry --name <runner-name> --from-step <N>
```

Repeat until all jobs pass. Do not push to trigger remote CI when local-ci can run it locally.

## Machine-readable output (`--json`)

For programmatic monitoring, add `--json` (or set `LOCAL_CI_JSON=1`) to emit an NDJSON event stream on stdout — one JSON object per line. Events:

- `run.start` (with `schemaVersion: 1`, `runId`)
- `job.start`, `job.finish` (`status: passed|failed`)
- `step.start`, `step.finish` (`status: passed|failed|skipped`)
- `run.paused` (carries `runner` + `retry_cmd`)
- `run.finish` (`status: passed|failed`)
- `diagnostic`

`--json` is decoupled from `--quiet`, and the diff renderer is auto-suppressed under `--json` so ANSI sequences don't collide with the stream. Combined with the exit-77 pause signal above, this gives agents a robust contract: parse `run.paused` events, react, and call `retry` — no plaintext grep required.
