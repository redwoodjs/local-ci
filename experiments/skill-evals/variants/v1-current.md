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
