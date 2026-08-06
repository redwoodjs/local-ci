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

Pipes, redirects, and backgrounding are all safe. When stdout isn't a TTY (any pipe, file redirect, or background process) the launcher detaches the run automatically: the foreground process exits **77** the instant a step pauses, while the worker keeps the container paused so you can `retry`. `| tee log`, `> log.txt`, and `&` work as expected.

For machine-readable monitoring, add `--json` (or set `LOCAL_CI_JSON=1`) to emit an NDJSON event stream — one JSON object per line. Watch for `"event":"run.paused"` (carries `runner` and `retry_cmd`) and `"event":"run.finish"` (carries `status: passed|failed`).

If the output is long, let it be long. Read it.

## After a failure

When a step fails, local-ci pauses. The output tells you which runner paused and what retry command to issue. Fix the file on your host, then:

```bash
npx run-local-ci retry --name <runner-name>
```

To re-run from an earlier step:

```bash
npx run-local-ci retry --name <runner-name> --from-step <N>
```

Retry behaves the same as `run`: it tails the same log, exits 77 if a step re-fails, and is safe to pipe or redirect.

## Do not

- Do not skip running local-ci because the fix "looks obvious" from the file. The only thing that proves the fix works is a green local-ci run.
- Do not disable lint rules, delete failing tests, or remove CI steps to make it pass. Fix the underlying issue.
- Do not omit `--pause-on-failure`. It is what makes the fix/retry loop fast; without it the container tears down and the next run pays the full startup cost again.
