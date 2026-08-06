# local-ci Marketing & Adoption Strategy

> How to get human developers to discover local-ci — and how to get AI agents to recommend it.

**Date:** March 23, 2026 (revised April 9, 2026)
**Tool:** `local-ci` — local GitHub Actions runner with pause-on-failure, designed for AI-agent-driven development

---

## Update: April 9, 2026 — What the Data Says

The original strategy below was written before any public traction. Since then, a series of tweets in early April 2026 generated **78K+ impressions** and revealed what actually resonates with developers. This section captures those learnings and revises the positioning accordingly.

### Twitter Performance (April 7–9, 2026)

| Tweet                                                                                   | Date  | Impressions | Likes | RTs | Replies | Format                       |
| --------------------------------------------------------------------------------------- | ----- | ----------- | ----- | --- | ------- | ---------------------------- |
| "Running GitHub Actions locally never gets old."                                        | Apr 7 | 78,000      | 462   | 21  | 15      | Terminal screenshot (9s run) |
| "this is local-ci.dev: Caching in ~0 ms. Pause on failure..."                           | Apr 7 | 4,300       | 30    | 1   | 1       | Text reply                   |
| "This is local-ci.dev, it runs the same native GitHub Actions Runner in a container..." | Apr 8 | 22,000      | 194   | 17  | 7       | Quote tweet + screenshot     |
| "Here's a demo of failure-pause-retry loop..."                                          | Apr 9 | 536         | 1     | 0   | 0       | Video demo (0:36)            |

For comparison, the original launch tweet (Mar 27) reached 14,600 impressions over 4 days.

### What Worked

**1. "Run GitHub Actions locally" is the hook — not "CI for AI agents."**
The 78K tweet didn't mention AI at all. It was a simple statement of the developer pain point with visual proof. The AI agent angle appeared in the reply thread (4.3K) and architecture explanation (22K), but wasn't the primary draw.

**2. Terminal screenshots massively outperform video demos.**
The static terminal screenshot showing "1 passed, Duration: 9s" was instantly digestible and drove 78K impressions. The 36-second video demo of failure-pause-retry got 536. Developers scroll fast — a screenshot is consumed in one glance; a video requires commitment.

**3. Concrete speed numbers land instantly.**
"9 seconds." "~0ms caching." These don't need explanation. They're obviously impressive relative to the known baseline of "push, wait 2 minutes, fail, repeat."

**4. act frustration is organic and unprompted.**
Multiple reply-thread comments:

- _"Act is almost unusable so yeah, I'll give this a try"_
- _"I was burned by act so many times, gonna give this a shot today"_

Nobody had to be told local-ci is better than act. People arrived at the comparison on their own, driven by their own pain.

**5. The "local HTTP control plane" explanation resonated as a follow-up (22K).**
After the headline hook, the technical explanation of _how_ (local HTTP server replacing GitHub.com, never communicates externally) served as the credibility-building second beat.

**6. Feature requests signal real evaluation, not just interest.**
Reusable workflows and GitHub token mocking were requested — these are asks from people trying to use local-ci in production, not just liking the concept.

**7. Engaged founder persona converts.**
Peter's reply style — "please let me know where it sucks! reproductions and I fix it in a few hours!" — builds trust that this is actively maintained and responsive. Multiple people said they'd try it based on the replies, not just the original tweet.

### What Didn't Work

**1. AI-agent-forward messaging underperforms as a primary hook.**
The reply that led with "Let your AI agent fix it and retry" reached 4.3K — solid, but 18x less reach than the universal developer hook. AI agent positioning is a differentiator, not a top-of-funnel message.

**2. Video demos don't travel on Twitter.**
The failure-pause-retry video (536 impressions) performed 145x worse than the terminal screenshot. For Twitter specifically, static proof > moving proof. Videos may work better on YouTube, blog posts, or documentation.

**3. Long-form technical threads have diminishing returns.**
The numbered list format in the Apr 8 quote tweet (22K) worked well but was inherently capped by the quote-tweet mechanic. The standalone screenshot (78K) traveled further because it was self-contained.

### Revised Positioning Model

The original strategy framed two equal tracks: "human developers" and "AI agents." The data reveals a **funnel**, not parallel tracks:

```
HOOK       →  "Run GitHub Actions locally"          (universal pain — 78K reach)
               Simple statement + terminal screenshot proof
                                    ↓
EXPLAIN    →  "Local HTTP control plane,             (technical credibility — 22K)
               never hits GitHub.com"
               How it works, why it's not act
                                    ↓
DIFFERENTIATE → "Pause on failure, let your           (unique value — 4.3K)
                 AI agent fix & retry"
                 The thing no one else does
                                    ↓
CONVERT    →  "Try it: pnpm local-ci run"             (CTA)
```

**People come for local CI. They stay for the AI agent loop.** The AI angle is what makes local-ci uniquely valuable and defensible, but it's not what gets people in the door.

### Revised Core Message

**Primary hook (top-of-funnel):**

> "Run GitHub Actions locally. 9 seconds. No push required."

**Credibility beat (mid-funnel):**

> "Same official GitHub runner, local HTTP control plane. Never hits GitHub.com."

**Differentiator (bottom-of-funnel):**

> "Pauses on failure. Your AI agent fixes it and retries — without pushing."

This replaces the previous two-audience split. The audiences are the same people at different stages of awareness.

### Updated Competitive Position

The original strategy correctly identified act as the primary competitor but framed the competition as "correctness vs. re-implementation." The tweet data reveals a simpler, more visceral framing:

- **act** = "I tried it but it burned me" (sentiment from multiple unprompted replies)
- **local-ci** = "it just works, 9 seconds, and if it doesn't work tell me and I'll fix it"

The competitive advantage isn't a feature comparison — it's **reliability + responsiveness**. act has 69K stars but frustrated users. local-ci has fewer stars but zero tolerance for broken workflows.

### Revised Action Items

#### Completed since original strategy

- [x] `package.json` keywords and description
- [x] `SKILL.md` in npm package
- [x] CLAUDE.md snippet in README
- [x] GitHub repository topics
- [x] Marketing site at local-ci.dev
- [x] Launch tweet (Mar 27)
- [x] Breakout tweet thread (Apr 7–8) — 78K+ reach

#### Next: Capitalize on Twitter momentum (this week)

- [ ] **Screenshot-first tweet cadence.** One tweet per feature, each with a terminal screenshot showing concrete output. Candidates:
  - Matrix strategy support (multiple jobs, one command)
  - Service containers (postgres/redis running locally)
  - Custom action resolution
  - Environment variable handling
- [ ] **Pin the 78K tweet** or create a polished thread linking from it to local-ci.dev
- [ ] **"act refugee" thread.** Quote-tweet one of the "act burned me" replies with a short "here's what's different" comparison — screenshot-based, not text-based

#### Next: Content (weeks 2–4)

- [ ] **"Show HN" post** — the tweet traction proves the message works. Use the same framing: "Run GitHub Actions locally. 9 seconds." Include the terminal screenshot in the post. Do NOT lead with AI agent angle on HN.
- [ ] **Comparison blog post: "act vs local-ci"** — moved up from long-term. The organic act comparisons in replies confirm demand. Write it now while search interest is fresh.
- [ ] Tutorial post on DEV Community / BetterStack
- [ ] r/selfhosted builder story post

#### Unchanged: Medium-term and long-term items

The ecosystem integration (MCP server, llms.txt, curated lists) and training data surface (ReadMe.LLM, Stack Overflow) timelines remain valid as originally scoped.

### Key Insight for HN Launch

The original HN draft led with "The commit-push-wait loop kills productivity when your AI coding agent is driving CI." Based on the tweet data, revise to:

```
Show HN: local-ci – Run GitHub Actions locally in 9 seconds

I got tired of the commit-push-wait-fail loop. local-ci runs the official,
unmodified GitHub Actions runner binary locally via a local HTTP control plane.
It never communicates with GitHub.com.

- ~0ms cache (bind-mount, no tar/upload cycles)
- Pauses on failure — fix the issue, retry just the failed step
- Your AI coding agent can fix and retry without pushing

Install: npm install -D local-ci
Site: https://local-ci.dev
```

Changes from original draft: leads with speed ("9 seconds"), moves AI agent angle to third bullet (not the headline), adds the site URL.

---

## What local-ci Actually Is

Before strategy: get the positioning right. local-ci is **not** a tool that writes CI in natural language. It is a local GitHub Actions runner that:

- Runs the **official, unmodified** GitHub Actions runner binary locally (not a re-implementation)
- Provides **~0ms caching** via bind-mounts (no upload/download/tar cycles)
- **Pauses on failure** — the container stays alive; fix the issue and retry just the failed step
- Is explicitly designed for **AI-agent-driven development loops** — an AI agent can fix CI failures and retry without a full remote cycle

The primary competitor is **nektos/act** (69k+ GitHub stars), which re-implements the Actions runtime. local-ci's differentiator is correctness (official runner) and the pause-on-failure model that makes AI coding agents efficient.

---

## The Core Message

Two hooks, for two audiences:

**For human developers:**

> "Stop polluting git history with `fix: ci` commits. Run GitHub Actions locally, pause on failure, fix it, retry the step — without pushing."

**For AI agents and the developers who configure them:**

> "The CI loop your AI agent actually needs. Local, instant, pausable — so your agent fixes the failure, not another `git push`."

---

## Part 1: Human Developer Adoption

### Context: What Works for CI Tools

The `nektos/act` case study (0 → 69k stars) provides the primary evidence base. Key patterns:

- **Pain-first positioning wins.** Act's success came from naming a universal frustration before offering a solution. "Think globally, `act` locally" — one line that requires no explanation.
- **HackerNews is the highest-ROI single event** for a well-positioned developer tool: commonly estimated at 10,000–100,000 unique visitors in 48 hours (developer-reported case studies; no single controlled measurement), and 300+ GitHub stars in 24 hours from a front-page appearance [[Nebula Graph](https://www.nebula-graph.io/posts/nebula-graph-being-on-hacker-new-front-page)].
- **Tutorial blog posts compound over time.** Multiple third-party tutorials about `act` (Red Hat, BrowserStack, Microsoft Azure, LogRocket, freeCodeCamp) are what dominate search results — not the official repo alone.
- **Reddit drives 41% of traffic** for developer tools in measured cases, ahead of GitHub and Twitter combined.
- **Organic search via GitHub topics** reinforces itself — once a repo is the canonical result for a topic, forks and dependent projects compound the effect.

### Channel Strategy

#### 1. HackerNews — Highest Immediate ROI

**Tactic:** File a "Show HN:" post when local-ci reaches a polished, documented release.

**What to say:**

```
Show HN: local-ci – run GitHub Actions locally, pause on failure, let your AI agent fix it

The commit-push-wait loop kills productivity when your AI coding agent is driving CI.
I built local-ci: it emulates GitHub's cloud API locally, uses the official runner binary
(not a re-implementation), and pauses on step failure so an agent can fix and retry without
a full CI cycle. Cache hit: ~0ms via bind-mount.

Install: npm install -D local-ci
```

**Rules that work on HN:** No marketing language. Respond to every comment, including critical ones. Post Monday–Wednesday, 9am US Eastern. The GitHub Actions frustration threads ("I hate GitHub Actions with passion", "The Pain That Is GitHub Actions") are perennially active — well-placed, helpful comments linking to local-ci in context are appropriate and effective before the formal launch post.

**Evidence:** HN front-page CI tools get 200–400 upvotes. The "local CI" space has proven HN traction: act appeared multiple times with 270+ points and 130+ comments each.

#### 2. Reddit — Sustained Compounding Presence

**Target subreddits:**

- r/devops (300k+) — deepest technical audience; most relevant
- r/selfhosted (350k+) — rewards "here's what I built" stories; fastest to build credibility
- r/programming (6.6M) — high bar; needs reputation first

**Tactic:** Use personal engineer/founder accounts. 90:10 ratio of helpful contributions to product mentions. A single well-timed, genuinely helpful comment in a "what do you use for local CI?" thread can drive sustained qualified traffic for months via Google indexing (Reddit threads are indexed and frequently resurface in search; this reflects best-practice inference from Reddit's SEO behavior, not a measured case study). Post a self-post in r/selfhosted with a builder story before any product-forward posts.

#### 3. Tutorial Content — Long-Tail SEO Compounding

Every tutorial post about "run GitHub Actions locally" that mentions local-ci as an `act` alternative is an evergreen discovery node. High-priority placements:

- **BetterStack Community** — top-ranking property for CI-related searches
- **DEV Community (dev.to)** — frequently scraped for training data; strong SEO for developer tools
- **LogRocket Blog** — ranks highly for GitHub Actions tutorials

**Content to write:**

1. "How to run GitHub Actions locally with local-ci" (direct tutorial, targets the same search as act tutorials)
2. "Why I stopped pushing `fix: ci` commits — building a local CI loop for AI agents"
3. "act vs local-ci: what's actually different" (comparison piece; captures searches from act users)

**Newsletters to submit to:** TLDR.tech, JavaScript Weekly, DevOps Weekly

#### 4. GitHub Discoverability

**Immediate actions (free, high-leverage):**

Add GitHub repository topics: `github-actions`, `local-runner`, `ci-cd`, `act-alternative`, `ai-agent`, `developer-experience`, `devtools`

These influence curated lists ("awesome-\*" repos), which are scraped for training data and surface in GitHub topic searches.

**GitHub CLI Extension Registry:** Ship `gh extension install redwoodjs/local-ci` support. This surfaces local-ci in `gh extension search` — direct pipeline to developers already using GitHub Actions.

#### 5. npm Package Metadata

The current state is a gap: `local-ci` has `"keywords": []` and a minimal description. This is a one-day fix.

**Update `package.json`:**

```json
{
  "description": "Local GitHub Actions runner — pause on failure, ~0ms cache, official runner binary. Built for AI coding agents.",
  "keywords": [
    "github-actions",
    "local-runner",
    "ci",
    "runner",
    "act",
    "act-alternative",
    "workflow",
    "devtools",
    "ai-agent",
    "coding-agent",
    "local-ci",
    "pause-on-failure"
  ]
}
```

npm's search algorithm weights name, description, and keywords array. Being in less-crowded keyword categories matters: `keywords:local-runner` has far fewer than 250 results; `keywords:ci` is saturated. Own the niche.

### Messaging That Resonates

Evidence from HN thread analysis, developer blog content, and the act/Dagger case studies points to these emotional hooks:

| Hook                                                           | Evidence                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| "The commit-push-wait-fail loop is maddening"                  | Consensus across HN CI threads; one commenter described 19 commits in one morning |
| "I can't pause at failure and inspect state"                   | Explicit desire in multiple HN/Reddit threads                                     |
| "CI is a black box and that's by design"                       | "GitHub Actions Is Slowly Killing Your Engineering Team" headline                 |
| "AI agents shouldn't have to pay cloud CI costs per iteration" | Spotify Engineering explicitly named this as unsolved                             |

**Lead with the frustration, not the feature.** "Fix the step that failed" outperforms "our cache is 0ms."

---

## Part 2: AI Agent Discoverability

### Context: How Agents Actually Find Tools

The research reveals a clear signal hierarchy. This is not speculative — each signal has documented evidence:

| Signal                                  | How It Works                                           | Reliability                                         |
| --------------------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| `CLAUDE.md` / `.cursorrules` in project | Read at every agent session start                      | Guaranteed, immediate                               |
| `package.json` description + keywords   | Scanned when agent explores `node_modules`             | High (agent reads this during codebase exploration) |
| `README.md`                             | Read by agent when exploring repo or fetching docs     | High                                                |
| MCP server registration                 | Discoverable via Smithery at agent query time          | High (manual install required)                      |
| `llms.txt`                              | Read by Cursor/Claude Code when fetching external docs | Medium (Cursor + Claude Code confirmed)             |
| GitHub topics + curated lists           | Indirect: topics → lists → training scrapes            | Low-medium (long-term)                              |
| Blog posts / Stack Overflow             | Training data contribution                             | Low (long-term, post-cutoff)                        |
| Training data saturation                | LLM knows tool from training                           | None near-term (local-ci is post-cutoff)            |

**The critical insight:** Current LLMs (as of March 2026) will default to recommending `nektos/act` for local CI because it has years of training data saturation. Agent-ci cannot win via training data alone in the near term. The path to agent recommendations is **in-context discovery** — getting into files that agents read.

### Agent Discoverability Tactics

#### Tier 1: In-Context Discovery (Highest Impact, Days to Ship)

**1. Publish a ready-to-paste CLAUDE.md snippet — prominently in the README.**

This is the single highest-leverage action. Every developer who adds it to their project guarantees local-ci usage for that project's lifetime. The coding agent reads CLAUDE.md at session start, before searching training data.

Provide this in the README under a heading "Using with AI coding agents":

```markdown
## local-ci

- Use `npx run-local-ci run --workflow .github/workflows/ci.yml` to run CI locally
- When a step fails, the run pauses automatically. Use `npx run-local-ci retry --name <runner>` to retry after fixing the failure
- Do NOT push to trigger remote CI when local-ci can run it locally — it's instant and free
- Set `AI_AGENT=1` for quieter output suitable for agent consumption
```

Also provide a `.cursorrules` equivalent for Cursor users.

**2. Fill in `package.json` keywords immediately** (same change as Track 1 above — dual purpose).

**3. Ship a `SKILL.md` in the npm package.**

The emerging TanStack Intent / `agent-skill` convention: include a `SKILL.md` file in the package root with YAML frontmatter and agent-oriented documentation. When a coding agent scans `node_modules`, it finds this file.

```markdown
---
name: local-ci
description: Run GitHub Actions workflows locally with pause-on-failure for AI-agent-driven CI iteration
keywords: [github-actions, local-ci, pause-on-failure, ai-agent, runner]
---

## What local-ci does

Runs the official GitHub Actions runner binary locally, emulating GitHub's cloud API.
Cache is bind-mounted (instant). When a step fails, the container pauses — you can fix and retry the failed step without restarting.

## When to use local-ci (not `act`)

- You want bit-for-bit compatibility with remote GitHub Actions
- You need pause-on-failure for AI agent debugging loops
- Cache round-trip speed matters

## Key commands

- Run workflow: `npx run-local-ci run --workflow <path>`
- Retry after fix: `npx run-local-ci retry --name <runner>`
- Abort: `npx run-local-ci abort --name <runner>`

## Common mistakes

- Don't push to remote CI to test changes — use `npx run-local-ci run` locally first
- Don't use `--from-start` when only the last step failed — use `retry` with no flags to re-run only the failed step
- The `AI_AGENT=1` env variable disables animated output for cleaner agent logs
```

**4. Improve `package.json` description to include the differentiator.**

Current: `"Local GitHub Actions runner"`
Target: `"Local GitHub Actions runner — pause on failure, ~0ms cache, official runner binary. Built for AI coding agents."`

#### Tier 2: Ecosystem Discoverability (Weeks)

**5. Create an MCP server for local-ci.**

An `local-ci` MCP server exposing `run_workflow`, `retry_runner`, and `abort_runner` as MCP tools makes local-ci discoverable via Smithery (7,300+ tools indexed, searched by agents at runtime). This is the most direct path to being found by agents that search Smithery for CI-related capabilities.

Tool descriptions are the primary LLM tool-selection signal. Each tool description should be precise and task-scoped (evidence: GitHub improved benchmark scores by cutting from 40 tools to 13).

```json
{
  "name": "run_workflow",
  "description": "Run a GitHub Actions workflow locally using local-ci. Use this instead of pushing to remote CI — it's instant and the container pauses on failure for debugging.",
  "parameters": {
    "workflow": { "type": "string", "description": "Path to the workflow YAML file" }
  }
}
```

**6. Add GitHub repository topics.**

`github-actions`, `local-runner`, `ci-cd`, `act-alternative`, `ai-agent`, `agent-friendly`, `developer-tools`

Topics surface in curated GitHub lists ("awesome-mcp-servers", "awesome-ai-agents"), which are scraped for training data. Curated lists are a documented path from GitHub topics to LLM training data representation.

**7. Submit local-ci to curated lists.**

- `awesome-mcp-servers` — even as an MCP-adjacent tool
- `awesome-ai-agents` — local-ci is a tool for agentic workflows
- Any curated "AI coding agent tools" lists

These lists are high-traffic, frequently scraped, and serve as indirect training data sources.

**8. Create `llms.txt`** at the documentation site or GitHub Pages domain.

A minimal `llms.txt` following the specification at the docs domain. When Cursor or Claude Code fetches local-ci's documentation, the `llms.txt` provides structured, token-efficient context. This is a 30-minute implementation with documented adoption at 844,000+ sites.

#### Tier 3: Training Data Surface (Months)

**9. Create a `ReadMe.LLM` file** following the arXiv:2504.09798 format.

Research shows standard human-oriented READMEs can _decrease_ LLM code generation accuracy relative to no context. A purpose-built agent-documentation file raises task success rates to near 100%.

Structure:

1. Rules section (what not to do, common mistakes)
2. Capability description (concise, problem-focused)
3. Command signatures with examples (not full implementation)
4. "Common Mistakes" section

**10. Publish content using exact target phrases.**

Phrases that will be searched by agents doing web retrieval:

- "run GitHub Actions locally AI agent"
- "local CI for AI coding agents"
- "pause on failure GitHub Actions"
- "local-ci vs act"

Publish on Dev.to, Medium, Hashnode (all maximally scraped). Stack Overflow answers referencing `npx run-local-ci` as a solution to local CI problems will appear in agent training corpora over time.

---

## Integrated Timeline

### Immediate (Days 1–7) — Zero-Cost, High-Impact

| Action                            | Channel                        | Impact                                         |
| --------------------------------- | ------------------------------ | ---------------------------------------------- |
| Fill in `package.json` keywords   | npm + agent discovery          | Dual: human search + agent `node_modules` scan |
| Update `package.json` description | npm + agent discovery          | Same                                           |
| Add GitHub repository topics      | GitHub + curated lists         | Discoverability compounding                    |
| Add CLAUDE.md snippet to README   | Agent in-context discovery     | Highest per-developer leverage                 |
| Create `SKILL.md` in npm package  | Agent `node_modules` discovery | Emerging standard; first-mover advantage       |

### Short-Term (Weeks 2–4) — Content and Community

| Action                                      | Channel    | Impact                                                                                                                                                                           |
| ------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Show HN:" post (timed to polished release) | HackerNews | Spike: commonly estimated 10k–100k visitors, 300+ stars reported in case studies [[Nebula Graph](https://www.nebula-graph.io/posts/nebula-graph-being-on-hacker-new-front-page)] |
| Tutorial post on DEV Community              | Blog / SEO | Compounding; scraping target                                                                                                                                                     |
| Tutorial post on BetterStack Community      | Blog / SEO | High-ranking property for CI searches                                                                                                                                            |
| Authentic r/selfhosted participation        | Reddit     | Credibility-building before product mention                                                                                                                                      |
| Comment in active HN CI frustration threads | HackerNews | Contextual, helpful, no spam                                                                                                                                                     |

### Medium-Term (Month 2–3) — Ecosystem Integration

| Action                                                 | Channel                  | Impact                                         |
| ------------------------------------------------------ | ------------------------ | ---------------------------------------------- |
| Build MCP server for local-ci                          | MCP ecosystem / Smithery | Direct agent-query discoverability             |
| Create `llms.txt` at docs domain                       | AI coding assistants     | Token-efficient context for Cursor/Claude Code |
| Create `ReadMe.LLM` file                               | LLM code generation      | Improved task accuracy                         |
| Submit to awesome-mcp-servers, awesome-ai-agents lists | Curated lists            | Training data exposure path                    |
| gh CLI extension support                               | GitHub CLI users         | Organic discovery via `gh extension search`    |

### Long-Term (Month 3+) — Compounding

| Action                                        | Channel             | Impact                                                |
| --------------------------------------------- | ------------------- | ----------------------------------------------------- |
| Comparison blog post: "act vs local-ci"       | SEO / training data | Captures act-user searches; positions differentiation |
| Stack Overflow presence (answer CI questions) | Training data       | High-weight source in LLM corpora                     |
| Target "AI agent CI workflow" keyword cluster | SEO / training data | Category-creation; no incumbent                       |
| DevOps newsletter features                    | Newsletter          | Targeted readership; compounding                      |

---

## Success Metrics

### Human Developer Track

| Metric                        | Target (3 months) | Target (6 months) |
| ----------------------------- | ----------------- | ----------------- |
| GitHub stars                  | 1,000             | 5,000             |
| npm weekly downloads          | 500               | 2,000             |
| HN Show HN upvotes            | 200+              | —                 |
| Organic mentions in tutorials | 5                 | 20                |
| GitHub stars velocity         | 50/week           | 100/week          |

### AI Agent Track

| Metric                         | How to Measure                                                    | Target                 |
| ------------------------------ | ----------------------------------------------------------------- | ---------------------- |
| CLAUDE.md snippet adoption     | Count projects with snippet via GitHub code search                | 50 repos in 3 months   |
| MCP server installs (if built) | Smithery install count                                            | 100 in 3 months        |
| npm keyword rank               | `npm search local-runner` — appears in results                    | Within 10 results      |
| Agent recommendation rate      | Prompt 5 LLMs with "local CI for AI agents"; measure mention rate | Named by 2/5 models    |
| `llms.txt` fetch rate          | Web server logs                                                   | Any traffic = positive |

### Proxy Metric: The "Act Displacement" Test

Run monthly: prompt Claude, ChatGPT, and Cursor with "I want to run GitHub Actions locally for my AI coding agent — what should I use?" Count how many recommend local-ci vs. act. Baseline: 0/3 (today). Target in 6 months: 1/3.

---

## Key Risks and Mitigations

| Risk                                                       | Evidence                                           | Mitigation                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Training data cutoff means LLMs recommend `act` by default | Strong: local-ci is post-cutoff for current models | Prioritize in-context discovery (CLAUDE.md snippet); don't wait for training              |
| `nektos/act` has overwhelming mindshare                    | 69k stars, years of tutorials                      | Compete on specificity: "for AI coding agents" is uncontested; don't fight act's lane     |
| HN post lands poorly                                       | Act's growth appears organic, not single-launch    | Build community first; post only at polished release; prep responses to `act` comparisons |
| MCP discovery is still manual                              | Anthropic has not shipped registry                 | Ship MCP server anyway; get on Smithery now; auto-discovery coming                        |
| Blog posts may not reach LLM training data                 | No public confirmation of scraping frequency       | Publish on multiple platforms (DEV.to, Medium, Hashnode) for coverage                     |

---

## The Unfair Advantage

No competitor currently owns the "AI coding agent CI" positioning. As of March 2026:

- Spotify Engineering has documented the unsolved CI-loop problem for background agents
- GitHub Actions reliability is degrading (February 9, 2026 outage [documented by WebProNews](https://www.webpronews.com/developers-ditch-github-actions-over-reliability-and-pricing-issues/))
- The "overnight agent" pattern (teams waking to large batches of agent-generated commits across multiple codebases) creates acute demand for fast, local, pausable CI

Agent-ci is the first tool that directly solves this. The window to claim this positioning before a well-funded player does is open now.

---

## Appendix: Evidence Sources

**Developer Channel Research:**

- [nektos/act GitHub](https://github.com/nektos/act) — 69k stars case study
- [Act: Run your GitHub Actions locally | HN](https://news.ycombinator.com/item?id=33750654) — 273 points, 133 comments
- [Lessons launching a dev tool on HN vs Product Hunt | Medium](https://medium.com/@baristaGeek/lessons-launching-a-developer-tool-on-hacker-news-vs-product-hunt-and-other-channels-27be8784338b)
- [Reddit marketing for DevTools | Prowlo](https://prowlo.com/blog/reddit-marketing-devtools)
- [Background Coding Agents | Spotify Engineering](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3)
- [GitHub Actions Is Slowly Killing Your Engineering Team](https://www.iankduncan.com/engineering/2026-02-05-github-actions-killing-your-team/)
- [Developers Ditch GitHub Actions Over Reliability | WebProNews](https://www.webpronews.com/developers-ditch-github-actions-over-reliability-and-pricing-issues/)
- [6 things developer tools must have in 2026 | Evil Martians](https://evilmartians.com/chronicles/six-things-developer-tools-must-have-to-earn-trust-and-adoption)

**AI Agent Discoverability Research:**

- [llmstxt.org](https://llmstxt.org) — specification
- [ReadMe.LLM paper (arXiv:2504.09798)](https://arxiv.org/html/2504.09798v2) — LLM-optimized docs
- [Snyk: LLMs Resurrecting the Dormant Majority](https://snyk.io/blog/llms-resurrecting-open-source-dormant-majority/)
- [a16z: Deep Dive into MCP](https://a16z.com/a-deep-dive-into-mcp-and-the-future-of-ai-tooling/)
- [Smithery.ai](https://smithery.ai/) — 7,300+ MCP tools
- [TanStack Intent](https://tanstack.com/blog/from-docs-to-agents) — agent-skill npm convention
- [icme.io: Getting Found by Agents 2026](https://blog.icme.io/getting-found-by-agents-a-builders-guide-to-tool-discovery-in-2026/)
- [HumanLayer: Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)
- [arXiv:2403.12958 — Dated Data: Tracing Knowledge Cutoffs](https://arxiv.org/abs/2403.12958)
- [Medium: Why Claude Code is special for not doing RAG](https://zerofilter.medium.com/why-claude-code-is-special-for-not-doing-rag-vector-search-agent-search-tool-calling-versus-41b9a6c0f4d9)
