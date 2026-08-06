# Tweet Queue

Drafts ready to post. Each follows the formula that worked on Apr 7 (78K impressions):

- **One-line hook** — relatable developer pain or satisfying outcome
- **Terminal screenshot** — concrete proof, instantly digestible
- **Short** — no threads, no walls of text, no "show more"
- **No AI-agent lead** — universal developer hook first; AI angle in replies if at all

Post cadence: ~1 per day, screenshot-first. Reply to your own tweet with context/CTA only if the original gets traction.

---

## Tweet 1: The dirty tree

**Hook:** Running CI before you commit is underrated.

**Screenshot needed:** Terminal showing `pnpm local-ci run --all tests.yml` succeeding on a dirty working tree — with `git status` above it showing uncommitted changes.

**Copy:**

> Running CI before you commit is underrated.

**Reply (post only if traction):**

> local-ci runs against your working tree directly. No need to commit, no need to push. Just run it.
>
> local-ci.dev

**Why this works:** The Apr 7 tweet proved that simple "I do X and it feels good" statements outperform explanations. "Before you commit" reframes local CI from "debugging tool" to "quality gate" — something every developer wants but doesn't have. The dirty tree is local-ci's actual superpower for daily workflow.

---

## Tweet 2: The speed comparison

**Hook:** Concrete before/after speed comparison.

**Screenshot needed:** Split-screen or sequential showing: (1) a GitHub Actions run taking 2-4 minutes, (2) the same workflow via local-ci taking 9 seconds. Or just the local-ci side with a caption that implies the comparison.

**Copy:**

> Same workflow. Same actions. 9 seconds instead of 4 minutes.

**Reply (post only if traction):**

> local-ci runs the official GitHub Actions runner locally. Cache is bind-mounted (~0ms), no upload/download cycles.
>
> local-ci.dev

**Why this works:** The "9 seconds" in the Apr 7 screenshot was the single most compelling data point. Making the comparison explicit ("instead of 4 minutes") makes it even more visceral. Everyone knows how long their CI takes.

---

## Tweet 3: The retry

**Hook:** Show the pause-and-retry in a screenshot, not a video.

**Screenshot needed:** Terminal showing a failed step, then the same step succeeding after a retry — two runs visible in one screenshot. Key: show the step name, the error, and then the green checkmark.

**Copy:**

> Step 6 failed. Fixed the file. Retried just that step. Green.
>
> No commit. No push. No waiting.

**Why this works:** The Apr 9 video of this same feature got 536 impressions. The hypothesis: the feature is compelling but the format was wrong. A screenshot showing the before/after in one glance tests whether the _feature_ resonates when delivered in the proven _format_.

---

## Tweet 4: Git hooks

**Hook:** Pre-push hook that actually catches things.

**Screenshot needed:** A `.git/hooks/pre-push` or `package.json` script showing local-ci wired as a pre-push hook, then a terminal showing it catching a failure before the push goes through.

**Copy:**

> Added local-ci to my pre-push hook. Now CI runs in 9 seconds before every push.
>
> Haven't seen a red CI on GitHub in a week.

**Why this works:** Someone in the Apr 7 replies asked "is it comfortably git-hookable?" — confirming demand for this use case. "Haven't seen a red CI on GitHub in a week" is the outcome every developer wants. It's aspirational but believable.

---

## Tweet 5: Service containers

**Hook:** Database-dependent tests running locally.

**Screenshot needed:** Terminal showing a workflow with `services: postgres` running locally via local-ci, with the test step passing.

**Copy:**

> Running GitHub Actions with service containers locally. Postgres spins up, tests run, 12 seconds total.

**Reply (post only if traction):**

> local-ci supports service containers natively. Same `services:` block you already have in your workflow YAML.
>
> local-ci.dev

**Why this works:** Service containers are the #1 reason people think "I can't run this locally." Showing it just working removes the biggest mental objection. Concrete timing ("12 seconds") follows the speed-as-proof pattern.

---

## Tweet 6: The act comparison (use sparingly)

**Hook:** Don't lead with the comparison. Let the result speak.

**Screenshot needed:** Terminal showing local-ci running a workflow that's known to fail on act — ideally one with `actions/setup-node` or another action that act handles incorrectly.

**Copy:**

> This workflow fails on act. Runs fine on local-ci.
>
> Official runner binary. Not a re-implementation.

**Why this works:** The organic "act burned me" replies prove the demand exists. But the Apr 7 data shows you don't need to name act — people bring it up themselves. This tweet names act only because the screenshot makes the comparison undeniable. Use this one after a few more "positive" tweets; don't lead your cadence with a competitor attack.

---

## Tweet 7: The quiet mode / agent output

**Hook:** Show what your AI agent actually sees.

**Screenshot needed:** Terminal showing `AI_AGENT=1 pnpm local-ci run --all tests.yml` with the minimal, token-efficient output. Maybe side-by-side with normal output.

**Copy:**

> What your AI agent sees when it runs CI locally. Minimal tokens, just the signal.

**Reply (post only if traction):**

> Set AI_AGENT=1 for quiet mode. On failure, it outputs just the error and the step name — so your agent knows exactly what to fix.
>
> local-ci.dev

**Why this works:** This is the one tweet where the AI-agent angle is the primary hook — but it works because the _format_ is still a screenshot, and the hook is about what you _see_ (visual), not what it _does_ (abstract). Test whether the AI-agent audience responds when the delivery format is right.

---

## Tweet 8: The workflow matrix

**Hook:** Matrix strategies running locally.

**Screenshot needed:** Terminal showing a workflow with a matrix strategy (e.g., node versions 18/20/22) running all variants locally.

**Copy:**

> Matrix strategy running locally. Three Node versions, one command, 15 seconds.

**Why this works:** Matrix strategies are another "surely that can't work locally" feature. Showing it working with a concrete time is the same formula as Tweet 1.

---

## Ordering Recommendation

Post in this order to maximize variety and sustain momentum:

1. **Tweet 2** (speed comparison) — rides the "9 seconds" momentum from Apr 7
2. **Tweet 1** (dirty tree) — introduces a new use case
3. **Tweet 4** (git hooks) — answers the question from the Apr 7 replies
4. **Tweet 3** (retry screenshot) — re-tests the retry feature in screenshot format
5. **Tweet 5** (service containers) — expands perceived capability
6. **Tweet 8** (matrix strategy) — same pattern, different feature
7. **Tweet 7** (quiet mode) — tests AI-agent hook with proven format
8. **Tweet 6** (act comparison) — save for last; let organic comparisons build first

Space them ~1 per day. If one pops (>10K impressions), reply with context and CTA. If it doesn't, move to the next — don't thread a dead tweet.
