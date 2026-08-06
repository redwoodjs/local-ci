# Skill evals

Measure whether `skills/local-ci/SKILL.md` (and variants) cause agents to do the right thing in realistic CI-failure scenarios.

## What it is

A matrix: `variants × fixtures → scorecard`.

- **Variants** = candidate wordings of the skill text (`variants/*.md`).
- **Fixtures** = synthetic mini-repos in a known-failing state (`fixtures/<name>/repo/`), plus a rubric (`expect.yaml`).
- **Runner** = headless `claude -p` with the variant injected as `CLAUDE.md`.
- **Scorer** = regex checks over the captured transcript, per rubric item in `expect.yaml`.
- **Output** = `scorecard.json` + a markdown table you can commit.

## v1 scope

- **Agents:** Claude Code only (`runners/claude-code.mjs`).
- **Ground-truth CI check:** the fixture ships a **mocked `local-ci`** (`fake-local-ci/`) that counts violations in source files and emits canned eslint-style output — no Docker, runs in seconds. The agent's edits change the stub's output on the next invocation, closing the fix/retry loop. Swap in a real `local-ci` dependency later if fidelity matters.
- **Scoring:** regex-only. Add an LLM-judge pass later for semantic checks like "did it root-cause vs. suppress."

## Run

```bash
pnpm install                          # or: pnpm install --ignore-workspace at the monorepo root
pnpm eval                             # default N=3 trials per cell
pnpm eval --n 5                       # more trials = tighter confidence
pnpm eval --variant v2-run-first      # limit variants
pnpm eval --fixture missing-changeset # limit fixtures
```

## Rescore without re-running

Every live trial saves `_meta.json`, `_streams.json`, and `_events.jsonl` into its tmp workdir. When you change a rubric pattern, replay the stored transcripts against the current rubric without spending another Claude call:

```bash
pnpm rescore                          # rescore every saved trial, emit scorecard-replay.md
pnpm rescore --fixture lint-curly-x18 # filter
pnpm rescore --last-n 5               # only the 5 most recent trials per (variant, fixture) cell
```

Use this when iterating on rubric regexes — both of the false-positive bugs in the first version of `no_tail_pipe` were caught this way, for free.

## Layout

```
experiments/skill-evals/
├── run.mjs                 # entry: matrix loop + scorecard emit
├── runners/
│   └── claude-code.mjs     # wraps `claude -p … --output-format stream-json`
├── scorers/
│   └── grep.mjs            # rubric evaluator (pattern match over transcript)
├── variants/
│   └── v1-current.md       # baseline: current SKILL.md text
└── fixtures/
    └── lint-curly-x18/
        ├── task.md         # prompt handed to the agent
        ├── expect.yaml     # rubric for this fixture
        └── repo/           # scratch repo (copied per eval run)
            ├── package.json
            ├── .eslintrc.json
            ├── src/index.js           # 18 curly violations
            └── fake-local-ci/         # mock CLI
                └── bin/local-ci.mjs
```

## Adding a fixture

Each fixture is a past mistake made into a regression test. If a real agent run ever does something wrong, build a fixture that reproduces the trap.

1. `mkdir fixtures/<name>/repo` — minimal files to reproduce the failure.
2. Write `task.md` — the exact prompt the agent gets. Keep it generic ("make CI pass").
3. Write `expect.yaml` — list rubric items (`kind: grep`, `stream: tool_calls|file_edits`, `must: present|absent`).
4. `pnpm eval` — confirm the baseline variant fails or passes as expected.
