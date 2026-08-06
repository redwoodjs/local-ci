---
name: local-ci
description: Run GitHub Actions workflows locally with pause-on-failure for AI-agent-driven CI iteration
keywords: [github-actions, local-ci, pause-on-failure, ai-agent, runner]
---

## What local-ci does

Runs the official GitHub Actions runner binary locally (in Docker), emulating GitHub's cloud API.
Cache is bind-mounted (instant). When a step fails, the container pauses — you can fix and retry the failed step without restarting.

## When to use local-ci (not `act`)

- You want bit-for-bit compatibility with remote GitHub Actions
- You need pause-on-failure for AI agent debugging loops
- Cache round-trip speed matters

## Key commands

- Run workflow: `npx run-local-ci run --workflow <path>`
- Run all relevant workflows (those whose `on` triggers match the current branch/event, just like GitHub): `npx run-local-ci run --all`
- Retry after fix: `npx run-local-ci retry --name <runner>`
- Abort: `npx run-local-ci abort --name <runner>`

## Agent output mode

Pass `--json` (or set `LOCAL_CI_JSON=1`) to emit an NDJSON event stream on stdout — one JSON object per line, with `run.start`/`paused`/`finish`, `job.start`/`finish`, `step.start`/`finish`, and `diagnostic` events. `run.start` carries `schemaVersion: 1`. Pair with `--pause-on-failure`: when stdout isn't a TTY the launcher detaches and the foreground process exits **77** the instant a `run.paused` event fires, so callers can react cleanly without parsing plaintext.

## Common mistakes

- Don't push to remote CI to test changes — use `npx run-local-ci run` locally first
- Don't use `--from-start` when only the last step failed — use `retry` with no flags to re-run only the failed step
- The `AI_AGENT=1` env variable disables animated output for cleaner agent logs
- Use `--no-matrix` to collapse matrix jobs into a single run — your local machine is likely faster than GitHub's runners, so parallelizing across matrix combinations is unnecessary
