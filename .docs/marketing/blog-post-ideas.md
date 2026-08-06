# Blog Post Todos

Ideas sourced from https://github.com/redwoodjs/local-ci/pull/98#issuecomment-4149707581

---

## [ ] Local CI Attestation

**The idea:** After local-ci passes locally, upload a GitHub commit status tagged with the `git write-tree` hash and the list of checks that passed. Remote CI checks on startup — if the tree hash matches, skip everything. Turbo remote cache but for the whole pipeline.

**Points to make:**

- Explain `git write-tree` as a content hash of the entire working tree (not a commit hash)
- Trust model: creating the attestation requires `gh` auth with push access — same trust boundary as pushing code, so no new attack surface
- This is not about preventing malicious actors; it's about eliminating redundant compute
- Compare to turbo remote cache: turbo deduplicates at the task level (skip unchanged packages), attestation deduplicates at the pipeline level (skip the whole run)
- Show the round-trip: local pass → upload status → remote CI queries → tree hash match → `skip=true`
- Call out that this is currently experimental but the mechanism works

---

## [ ] The CI Rabbit Hole Effect

**The idea:** Running CI locally with local-ci didn't just validate the pipeline — it forced users to actually look at what CI does, surfacing problems they didn't know they had.

**Points to make:**

- Real example: discovered TypeScript was doing 14M type instantiations due to `satisfies WithContext<X>` on schema-dts types (800+ Schema.org union members). Five return type annotations → 3M instantiations, 36s → 7s check time, 5.7GB → 2GB memory
- Real example: turbo remote cache was never working because 36 `globalEnv` vars busted every cache key
- Neither issue was on the team's radar before local-ci
- The mechanism: running CI locally makes feedback tight enough that you actually investigate failures rather than just retrying
- Angle: local-ci as a CI auditing tool, not just a CI runner

---

## [ ] Local vs. Remote Execution Strategy

**The idea:** Remote CI bursts with parallelism because memory is abundant. Local CI must serialize because Docker Desktop caps at 8GB. The same workflow definition should produce different execution strategies depending on environment.

**Points to make:**

- Concrete example: typecheck alone needed ~6GB; running typecheck + lint + graphql-check in parallel blew past 8GB on Docker Desktop
- Remote runners have 16–32GB and can absorb parallel jobs; local machines cannot
- Current workaround: collapse parallel jobs into a sequential job for local runs
- The design question: should local-ci automatically detect memory pressure and serialize? Should workflows declare memory requirements?
- This is an open design space — invite community input

---

## [ ] The Agentic Dev Loop

**The idea:** Claude Code running CI locally, fixing failures, retrying, and only pushing when green. local-ci's bind-mounted caches make iteration fast enough for this loop to actually work.

**Points to make:**

- The loop: commit → local-ci runs → failure → Claude Code fixes in place using `--pause-on-failure` → retry failed step → commit fix → push
- Bind-mounted pnpm store + toolcache turns 170s pnpm install into 8s on second run — this is what makes the agentic loop viable
- Commits become save points, not publications (especially with squash-merge workflows)
- local-ci gives Claude Code a real Linux environment with the actual action versions — not a simulated local run
- Connect to the broader vision: the goal is a world where you never push broken code because the agent already ran and fixed CI

---

## [ ] Commits as Save Points (A Pattern, Not a Requirement)

**The idea:** local-ci can run against dirty/uncommitted code, but committing before a run turns the commit into a save point — especially useful in the fix-retry loop.

**Points to make:**

- Clarify: local-ci runs against your working tree, committed or not — no friction required
- The optional pattern: commit → run → fail → fix with `--pause-on-failure` → retry → commit fix → done
- When you do commit, the commit becomes a save point you can return to if the fix makes things worse
- Particularly useful with squash-merge workflows where intermediate commits are throwaway anyway
- The agentic angle: Claude Code benefits from save points because it can roll back to a known-good state before trying a different fix

---

## [ ] Actions Budget: Running E2E Tests Locally to Save CI Minutes

**The idea:** E2E tests are often the biggest consumer of GitHub Actions minutes. Running them locally with local-ci before pushing means they never hit remote CI — protecting your budget for the tests that truly need to run on every push.

**Points to make:**

- E2E suites are expensive: slow, parallelized, often the #1 actions cost driver
- The pattern: run E2E locally with local-ci before pushing; gate remote CI on a passing attestation
- Pairs with attestation — if local E2E passed, remote CI can skip them entirely
- Who this is for: open source maintainers and small teams on free/limited Actions plans, but also companies paying for compute
- Source: @rachelnabors runs E2E locally because they "eat all my actions budget"

---

## [ ] Local CI vs. Remote CI: They're Not the Same Job

**The idea:** Rachel's follow-up question — "what about all the tests that run every time people push code?" — is the real design question. Not everything should move local. local-ci is a complement to remote CI, not a replacement.

**Points to make:**

- Local CI = shift-left, fast feedback, agentic loops, expensive test suites before push
- Remote CI = authoritative gate, cross-platform, runs on every push from every contributor
- The right model: local CI as a pre-flight check, remote CI as the source of truth
- local-ci doesn't ask you to remove your remote CI — it asks you to stop waiting for it when you don't have to
- The attestation feature is the bridge: local pass → remote CI trusts the result and skips
- Connects to the hybrid execution design question from the jokull thread
