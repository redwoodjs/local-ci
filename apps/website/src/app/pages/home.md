# Local CI

**Run GitHub Actions on your machine.** Caching in ~0 ms. Pause on failure. Let your AI agent fix it and retry — without pushing.

- Website: <https://local-ci.dev>
- Source: <https://github.com/redwoodjs/local-ci>
- Docs: [/docs/README.md](/docs/README.md)
- Agent skill: [/docs/SKILL.md](/docs/SKILL.md)
- Compatibility matrix: [/compatibility](/compatibility)
- Blog: [/blog](/blog)

---

## Principles

### Instant Feedback

**Reality.** Cloud CI takes minutes to spin up, install dependencies, and run tests. The feedback loop is broken.

**Advantage.** By bind-mounting your local `node_modules` and tool caches, Local CI starts in ~0 ms. Your first run warms the cache; subsequent runs are instant.

### Debug in Place

**Reality.** When a cloud CI job fails, the container is destroyed. You have to guess the fix, push, and wait again.

**Advantage.** Local CI pauses on failure. The container stays alive with all state intact. Fix the issue on your host, then retry just the failed step.

### True Compatibility

**Reality.** Other local runners use custom re-implementations of the GitHub Actions spec, leading to subtle bugs and drift.

**Advantage.** Local CI emulates the server-side API surface and feeds jobs to the unmodified, official GitHub Actions runner binary.

---

## Architecture Comparison

| Feature          | GitHub Actions     | Other local runners      | Local CI                     |
| ---------------- | ------------------ | ------------------------ | ---------------------------- |
| Runner binary    | Official           | Custom re-implementation | **Official**                 |
| API layer        | GitHub.com         | Compatibility shim       | **Full local emulation**     |
| Cache round-trip | Network (~seconds) | Varies                   | **~0 ms (bind-mount)**       |
| On failure       | Start over         | Start over               | **Pause → fix → retry step** |
| Container state  | Destroyed          | Destroyed                | **Kept alive**               |

---

## Quick Start

### 1. Run

```bash
# Run a specific workflow
npx run-local-ci run --workflow .github/workflows/ci.yml

# Run all relevant workflows for current branch
npx run-local-ci run --all
```

### 2. Retry

```bash
npx run-local-ci retry --name <runner-name>
```

---

## AI Agent Integration

Install the agent skill — works with Claude Code, Cursor, Codex, and [40+ other agents](https://agentskills.io):

```bash
npx skills add redwoodjs/local-ci --skill local-ci
```

Then add to your agent instructions (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`):

````markdown
## CI

Install the local-ci skill (one-time setup):

```bash
npx skills add redwoodjs/local-ci --skill local-ci
```

Before completing any work, run the `local-ci` skill to validate
your changes locally. If it fails, fix the issue and re-run.
Do not report work as done until it passes.
````

**Claude Code.** Local CI also ships a `/validate` skill. Copy [`.claude/commands/validate.md`](https://github.com/redwoodjs/local-ci/blob/main/.claude/commands/validate.md) into your project for automatic background execution with monitoring and retry.

---

## In Developers' Own Words

> Waiting for CI could be the subtitle of the book of the last 3 weeks of my life. The Factory Life: Waiting for CI.
>
> — Jess Martin ([@jessmartin](https://x.com/jessmartin))

> An alternative to Act for AI? I'll take it!
>
> — Eric Clemmons ([@ericclemmons](https://x.com/ericclemmons))

> You can run Github actions workflows fully locally with Local CI. Such a crazy good unlock for coding agents!
>
> — Pekka Enberg ([@penberg](https://x.com/penberg))

> Clever dude!
>
> — Cyrus ([@cyrusnewday](https://x.com/cyrusnewday))

> Okay this is awesome.
>
> — Chris ([@chriszeuch](https://x.com/chriszeuch))

> I like the look of what you're cooking here.
>
> — Andrew Jefferson ([@EastlondonDev](https://x.com/EastlondonDev))

> It's great.
>
> — Juho Vepsäläinen ([@bebraw](https://x.com/bebraw))

> Oh noice.
>
> — Ahmad Awais ([@MrAhmadAwais](https://x.com/MrAhmadAwais))

---

Built by [RedwoodJS](https://rwsdk.com).
