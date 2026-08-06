# Local CI — Agent Instructions

This file is the single source of truth for agent instructions in this repo. It is surfaced to Claude Code as `CLAUDE.md` and to every other harness (pi, Codex, etc.) as `AGENTS.md` via a symlink.

## Rules

- [Changeset Required](.claude/rules/changeset-required.md) — Every PR must include a changeset and update the root CHANGELOG.md

## CI

Before completing any work, validate all workflows against the in-tree dev build. If it fails, fix the issue and re-run. Do not tell the user work is done until it passes.

- **Claude Code:** run `/local-ci-dev` (from `.claude/commands/local-ci-dev.md`; `/validate` still works as an alias).
- **pi:** run `/skill:local-ci-dev` (from `.pi/skills/local-ci-dev/SKILL.md`).

Both wrap the same background-monitor-retry workflow around `pnpm local-ci-dev run --all`.

## Code

- This is a Node.js ESM project (`.mjs` files). Use `import`, not `require`.
- Package manager is pnpm (pinned via `packageManager` in package.json).
- Docker operations go through `src/docker.mjs`. Cloud operations through `src/cloud.mjs`.
- The user authenticates via OAuth (`gh auth login`), never API keys.
