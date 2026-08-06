---
title: "Works on my machine: The Agentic Dev Loop"
summary: "Agents run the tests. CI still breaks. Then they gaslight you. Here's how giving agents real, fast, local CI changes everything."
date: 2026-03-31
author: "Peter Pistorius"
---

You've probably felt this. Write some code, run the tests, everything is green, commit, push — then watch CI fail on something that was obviously broken the whole time. The feedback loop is brutal: commit, push, wait two minutes, navigate three clicks deep to find the error, fix one character, repeat. Someone once described it as "having an editor with a 2-minute save lag" and it's hard to argue.

GitHub Actions has a special place in the developer frustration hall of fame. It's not just slow. It's a black box wrapped in YAML that was clearly designed for simple cases and bolted together for complex ones. You can't easily SSH into a failing environment. Sharing state between steps requires an upload/download dance. The configuration syntax is declarative until it isn't, and then you're fighting it. And because it's rented compute, you don't control the knobs — runners get oversubscribed, get slower over time, and there's nothing you can do about it.

And yet. CI is one of the most genuinely useful things in software development. The problem isn't CI — it's the feedback loop.

## Agents Make It Worse

If you're using Claude Code or another AI coding agent, you've probably hit the next level of this problem.

You ask Claude Code to fix a failing test. It reads the test, reads the implementation, makes a change, runs the tests — they pass — and reports back. You push. CI fails. When you ask why, the agent says something like: _"That failure appears to be unrelated to the changes I made."_

It's often not even lying. It genuinely doesn't know. It ran `pnpm test` in your working directory and got green. What it didn't run was the full CI pipeline — the typecheck, the lint, the integration tests that only run in a clean environment, the build step that catches import errors. The agent validated a slice of the contract, not the whole thing.

So you end up with broken commits and an agent that's confidently wrong about why.

## Give the Agent Real CI

The fix is conceptually simple: give the agent access to the same CI it would see on GitHub. Not a simulation. The actual workflow, the actual action versions, in a real Linux container.

That's what local-ci does. It runs your `.github/workflows` locally, in Docker — not a wrapper around an existing tool, but a new runtime built to be a faithful local alternative to GitHub Actions. The GitHub Actions runner binary is open source. It already knows how to execute workflows; all it expects is an HTTP control plane to coordinate jobs and report results. local-ci provides that locally. The runner doesn't know the difference. You get the exact same binary GitHub uses, talking to a local service instead of GitHub's servers. Claude Code can call it the same way you can.

One thing we deliberately avoid: GitHub's full VM image. It's ~30 GB, packed with pre-installed tools you probably don't need. Instead, local-ci uses the official runner binary (~400 MB) inside a clean container. Your workflow's `setup-*` actions install exactly what you need, the same way they do on GitHub — but without the multi-gigabyte baseline.

It took a month of iteration before it felt right — edge cases in the runner protocol, cache invalidation, container lifecycle, retry semantics. The kind of work that doesn't show up in a demo but determines whether a tool holds up under real use.

## The Speed Problem

Local CI is only useful if it's fast enough to run in a loop. Without caching, the first time you run `pnpm install` inside a fresh Docker container it can take minutes. Do that a few times per fix attempt and the loop becomes unusable. You'd rather just push and wait — and you're back where you started.

The thing that makes the agentic loop viable is bind-mounted caches. local-ci mounts your local pnpm store and GitHub Actions toolcache into the container. After the first run, `pnpm install` takes 0 seconds. The container still starts fresh — clean environment, no state leakage — but the expensive parts are already warm.

Zero milliseconds instead of minutes. That's the difference between a loop you'll actually use and one you'll abandon after a day.

## The Loop

Here's what the agentic dev loop looks like in practice:

1. You ask Claude Code to implement something (or fix something)
2. Claude makes changes and runs:
   ```bash
   npx run-local-ci run --workflow .github/workflows/ci.yml
   ```
3. local-ci executes the full local CI pipeline
4. If it fails, the run pauses automatically. Claude reads the output, fixes the issue in place, and retries just the failed step:
   ```bash
   npx run-local-ci retry --name <runner-name>
   ```
5. When everything is green, Claude commits and you push

The pause-on-failure behavior is built in: instead of the whole pipeline failing and exiting, it pauses so the agent (or you) can inspect the state inside the container before it disappears.

Commits in this loop become save points rather than publications. Especially with a squash-merge workflow, intermediate commits are throwaway — they're just checkpoints you can roll back to if a fix attempt makes things worse. The agent benefits from this too: a known-good commit hash is something it can return to if it goes down a dead end.

## The Result

The whole point of CI is confidence. You push code and you know, with high probability, that it works. The feedback loop is: push → wait → find out.

The agentic dev loop tightens that to: run locally → fail → fix → run again → green → push. You already know it works before it ever hits the remote. CI becomes a formality — a verification of something you already proved.

A fake local runner just gives agents a new way to confidently produce broken code. The loop works because local-ci is real, and fast enough to run repeatedly without breaking the flow. Fidelity plus speed — that's what makes it viable.

```bash
# Run a specific workflow
npx run-local-ci run --workflow .github/workflows/ci.yml

# Run all workflows for the current branch
npx run-local-ci run --all
```

The first run is slow while caches warm up. After that, it's the loop.
