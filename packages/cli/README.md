# Local CI

**Run GitHub Actions on your machine. Caching in ~0 ms. Pause on failure. Fix and retry — before you commit, before you push.**

<p align="center">
  <img src="https://raw.githubusercontent.com/redwoodjs/local-ci/main/.docs/marketing/demo.gif" alt="Local CI demo — pause on failure, fix, retry" width="700" />
</p>

Local CI is a ground-up rewrite of the GitHub Actions orchestration layer that runs entirely on your own machine. It doesn't wrap or shim the runner: it **replaces the cloud API** that the official [GitHub Actions Runner](https://github.com/actions/runner) talks to, so the same runner binary that executes your jobs on GitHub.com executes them locally, bit-for-bit.

Actions like `actions/checkout`, `actions/setup-node`, and `actions/cache` work out of the box — no patches, no forks, no network calls to GitHub. Dependencies that took a couple of minutes to install on GitHub's runners install in a few seconds on the second run because package-manager caches stay local and completed dependency trees can be cloned from immutable snapshots.

---

## Why Local CI?

Remote CI is the final gatekeeper — it runs on every push and decides what ships. That's its job. The problem is what happens when it fails: you push, you wait, you read logs, you push again. Every retry pays the full cost of a fresh run, and the gatekeeper ends up being used as a debugger.

Local CI is a **pre-flight check** that runs on your own machine before you commit. Catch the failure in seconds, fix it locally, only push work that's already green — and let remote CI stay the gatekeeper.

Existing "run actions locally" tools either re-implement steps in a compatibility layer or require you to maintain a separate config. Local CI does neither.

|                            | GitHub Actions     | Other local runners      | **Local CI**                            |
| -------------------------- | ------------------ | ------------------------ | --------------------------------------- |
| Runner binary              | Official           | Custom re-implementation | **Official**                            |
| API layer                  | GitHub.com         | Compatibility shim       | **Full local emulation**                |
| Cache round-trip           | Network (~seconds) | Varies                   | **~0 ms (local filesystem)**            |
| On failure                 | Start over         | Start over               | **Pause → fix → retry the failed step** |
| Container state on failure | Destroyed          | Destroyed                | **Kept alive**                          |
| Requires a clean commit    | Yes                | Yes                      | **No — runs against working tree**      |

### ~0 ms caching

Local CI replaces GitHub's cloud cache with **local filesystem caches**. Package-manager stores, Playwright browsers, and the runner tool cache live on the host with no upload or download round-trip. Every job gets private writable `node_modules`; pnpm, Yarn, and Bun jobs can start from an immutable lockfile-keyed snapshot cloned with copy-on-write when the host supports it. npm jobs share npm's download cache because `npm ci` removes `node_modules` by design.

For workflows with several independent jobs, use `--prewarm-through <workflow:job:step-id>` to populate the dependency cache once before the real jobs start in parallel. The selected step must have a stable `id`. Local CI runs a disposable copy of that job from the beginning through the selected step, atomically publishes a completed snapshot, and clones it into each real job's private workspace. You can also set `LOCAL_CI_PREWARM_THROUGH` in `.env.local-ci` to make this automatic for a repo. Without explicit prewarming, jobs remain isolated and safe; the first successful job can populate the cache for later runs.

### Pause on failure

Step 6 failed. Fix the file. Retry just that step. Green. No checkout, no reinstall, no waiting.

When a step fails, Local CI **pauses** instead of tearing down. The container stays alive with all state intact — environment variables, installed tools, intermediate build artifacts. Your edits on the host are synced into the container, so you (or your AI agent) can fix the issue and **retry just the failed step**.

### Real GitHub Actions Runner, real compatibility

Local CI does not re-implement GitHub Actions. It emulates the **server-side API surface** — the Twirp endpoints, the Azure Block Blob artifact protocol, the cache REST API — and feeds jobs to the unmodified, official runner. If your workflow runs on GitHub, it runs here.

---

## Prerequisites

- **Docker** — a running Docker provider:
  - **macOS:** [OrbStack](https://orbstack.dev/) (recommended) or Docker Desktop
  - **Linux:** Native Docker Engine or Docker Desktop
- **Optional — for `runs-on: macos-*` jobs** (Apple Silicon Macs only):
  - [tart](https://github.com/cirruslabs/tart) — `brew install cirruslabs/cli/tart`
  - `sshpass` — `brew install hudochenkov/sshpass/sshpass`

  Without both, macOS jobs are skipped with a reason. See [macOS jobs](#macos-jobs) below.

## Quick start

```bash
# Run a specific workflow
npx run-local-ci run --workflow .github/workflows/ci.yml

# Run all relevant workflows for the current branch
npx run-local-ci run --all
```

Local CI runs against your **current working tree** — uncommitted changes are included automatically. No need to commit or stash before running.

### Migrating from Agent CI

Agent CI is now Local CI. Install and invoke the canonical package with `npx run-local-ci`; the executable installed into `node_modules/.bin` is `local-ci`.

Existing `@redwoodjs/agent-ci` installations continue to work throughout the remaining `0.x` releases. The compatibility package forwards the `agent-ci` executable to Local CI. Existing `AGENT_CI_*` environment variables, `.env.agent-ci`, `.github/agent-ci.Dockerfile`, and legacy Agent CI Docker resources are also recognized. New configuration should use `LOCAL_CI_*`, `.env.local-ci`, and `.github/local-ci.Dockerfile`.

Committing is optional, but it's a useful pattern: commit → run → fail → fix with `--pause-on-failure` → retry → commit the fix. When you do commit, the commit becomes a save point you can return to if the fix makes things worse. Your AI agent benefits from the same pattern — it can roll back to a known-good state before trying a different fix.

### Rust runner from source

The npm package keeps `npx run-local-ci` on the TypeScript execution path. The Rust runner is available in this repository for parity testing, but published npm installs do not include a native runner yet. Native npm platform packages and release archives are deferred until the release workflow builds, stages, and verifies real target binaries.

To try the Rust runner from a checkout, build or run it directly with Cargo:

```bash
cargo run -p local-ci -- run --workflow .github/workflows/ci.yml
# or
cargo build --release -p local-ci
./target/release/local-ci run --workflow .github/workflows/ci.yml
```

The development wrapper can also build and run the Rust binary from a checkout:

```bash
LOCAL_CI_FORCE_RUST=1 pnpm local-ci-dev run --workflow .github/workflows/ci.yml
```

For published npm installs, `LOCAL_CI_FORCE_RUST=1 npx run-local-ci ...` is expected to fail until native binary packaging lands. To force the TypeScript path explicitly, run with `LOCAL_CI_FORCE_TYPESCRIPT=1` or `LOCAL_CI_FORCE_TS=1`.

### Retry a failed step

```bash
npx run-local-ci retry --name <runner-name>
```

---

## CLI reference

### `local-ci run`

Run GitHub Actions workflow jobs locally.

| Flag                                       | Short | Description                                                                                                                                                                                                         |
| ------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--workflow <path>`                        | `-w`  | Path to the workflow file                                                                                                                                                                                           |
| `--all`                                    | `-a`  | Discover and run all relevant workflows for the current branch                                                                                                                                                      |
| `--pause-on-failure`                       | `-p`  | Pause on step failure for interactive debugging                                                                                                                                                                     |
| `--quiet`                                  | `-q`  | Suppress animated rendering (also enabled by `AI_AGENT=1`)                                                                                                                                                          |
| `--json`                                   |       | Emit NDJSON event stream on stdout (also enabled by `LOCAL_CI_JSON=1`); see [Agent output mode](#agent-output-mode-ndjson-event-stream)                                                                             |
| `--no-matrix`                              |       | Collapse all matrix combinations into a single job (uses first value of each key)                                                                                                                                   |
| `--jobs <N>`                               | `-j`  | Maximum jobs to run at once                                                                                                                                                                                         |
| `--prewarm-through <workflow:job:step-id>` |       | If the dependency cache is cold, run one disposable job through the selected step `id` and atomically publish its completed cache before starting the real jobs. Also configurable with `LOCAL_CI_PREWARM_THROUGH`. |
| `--github-token [<token>]`                 |       | GitHub token for fetching remote reusable workflows (auto-resolves via `gh auth token` if no value given). Also available as `LOCAL_CI_GITHUB_TOKEN` env var                                                        |
| `--commit-status`                          |       | Post a GitHub commit status after the run (requires `--github-token`)                                                                                                                                               |
| `--var KEY=VALUE`                          |       | Provide a workflow variable (`${{ vars.KEY }}`); repeat for multiple                                                                                                                                                |
| `--var-file <path\|->`                     |       | Load workflow variables from a JSON file, or use `-` to read JSON from stdin                                                                                                                                        |

#### Prewarm `node_modules` before parallel jobs

Every job has private writable `node_modules`, so parallel installs cannot corrupt another job. When several first-wave jobs install the same lockfile, Local CI recommends explicit prewarming to avoid repeating cold installation work.

Add a stable `id` to the install step you want to use as the prewarm boundary:

```yaml
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - id: install
        run: pnpm install --frozen-lockfile
```

Then run:

```bash
local-ci run --all --prewarm-through .github/workflows/ci.yml:test:install
```

To make this automatic for the repo, put the same selector in `.env.local-ci`:

```env
LOCAL_CI_PREWARM_THROUGH=.github/workflows/ci.yml:test:install
```

The CLI flag wins over the env setting. If the lockfile-keyed Local CI dependency cache has a valid completion manifest, Local CI skips the disposable prewarm job. Interrupted staging directories and package-manager-owned sentinel files are never treated as completed caches.

### `local-ci retry`

Retry a paused runner after fixing the failure.

| Flag              | Short | Description                                   |
| ----------------- | ----- | --------------------------------------------- |
| `--name <name>`   | `-n`  | Name of the paused runner to retry (required) |
| `--from-step <N>` |       | Re-run from step N, skipping earlier steps    |
| `--from-start`    |       | Re-run all steps from the beginning           |

Without `--from-step` or `--from-start`, retry re-runs only the failed step (the default).

### `local-ci abort`

Abort a paused runner and tear down its container.

| Flag            | Short | Description                                   |
| --------------- | ----- | --------------------------------------------- |
| `--name <name>` | `-n`  | Name of the paused runner to abort (required) |

---

## Secrets

Workflow secrets (`${{ secrets.FOO }}`) are resolved in order:

1. **`.env.local-ci`** file in the repo root (`KEY=VALUE` syntax, `#` comments supported)
2. **Shell environment variables** — any env var matching a required secret name acts as a fallback
3. **`--github-token`** — automatically provides `secrets.GITHUB_TOKEN`

```bash
# All three approaches work:
# 1. .env.local-ci file
echo "CLOUDFLARE_API_TOKEN=xxx" >> .env.local-ci

# 2. Inline env vars
CLOUDFLARE_API_TOKEN=xxx local-ci run -w .github/workflows/deploy.yml

# 3. --github-token for GITHUB_TOKEN specifically
local-ci run -w .github/workflows/ci.yml --github-token
```

---

## Vars

Workflow variables (`${{ vars.FOO }}`) are provided via `--var` flags or a JSON `--var-file`. There's no fallback to shell environment variables — this keeps workflow vars distinct from shell env vars.

```bash
local-ci run -w .github/workflows/deploy.yml \
  --var DEPLOY_ENV=production \
  --var API_URL=https://api.example.com
```

`--var-file` accepts either a JSON object:

```json
{
  "DEPLOY_ENV": "production",
  "API_URL": "https://api.example.com"
}
```

or GitHub CLI output:

```bash
gh variable list --json name,value --limit 1000 |
  local-ci run --all --var-file -
```

If the same variable appears in multiple places, later `--var-file` flags override earlier ones, and explicit `--var KEY=VALUE` flags override all file values.

If a workflow references a var (`${{ vars.FOO }}`) and no matching var is supplied, the run fails with a message listing the missing vars.

---

## Environment variables

All configuration is available via environment variables. For persistent machine-local overrides, create a `.env.local-ci` file in your project root — Local CI loads it automatically (`KEY=VALUE` syntax, `#` comments supported).

Only `LOCAL_CI_*`-prefixed keys from `.env.local-ci` are applied to the CLI process environment (so they influence Docker/network resolution, etc.). Non-prefixed keys in the file are still resolved as workflow secrets via `${{ secrets.FOO }}`. Shell environment variables always take precedence over `.env.local-ci` entries.

### General

| Variable                   | Default                         | Description                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_REPO`              | auto-detected from `git remote` | Override the `owner/repo` used when emulating the GitHub API. Useful when the remote URL can't be detected automatically.                                                                                                                                                                    |
| `AI_AGENT`                 | unset                           | Set to `1` to enable quiet mode (suppress animated rendering). Same effect as `--quiet`.                                                                                                                                                                                                     |
| `LOCAL_CI_JSON`            | unset                           | Set to `1` to emit the NDJSON event stream on stdout. Same effect as `--json`.                                                                                                                                                                                                               |
| `LOCAL_CI_DETACHED`        | unset                           | Set to `1` to force `--pause-on-failure` to use the detached launcher even on a TTY (for manual verification of the pause-then-exit-77 flow). The launcher uses this same env var internally to mark its worker child (with the worker's log path as the value), so do not set it to a path. |
| `DEBUG`                    | unset                           | Enable verbose debug logging. See [Debugging](#debugging) for supported namespaces.                                                                                                                                                                                                          |
| `LOCAL_CI_GITHUB_TOKEN`    | unset                           | GitHub token for fetching remote reusable workflows. Alternative to the `--github-token` CLI flag.                                                                                                                                                                                           |
| `LOCAL_CI_PREWARM_THROUGH` | unset                           | Persistent default for `--prewarm-through <workflow:job:step-id>`. The CLI flag wins when both are set.                                                                                                                                                                                      |

### Docker

| Variable                                      | Default                             | Description                                                                                                                                                                                                       |
| --------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOCAL_CI_DOCKER_HOST`                        | `unix:///var/run/docker.sock`       | Docker daemon socket or URL. Set to `ssh://user@host` or `tcp://…` to use a remote daemon. **Note:** the standard `DOCKER_HOST` env var is not honoured — setting it causes local-ci to exit with a rename error. |
| `LOCAL_CI_DTU_HOST`                           | `host.docker.internal`              | Hostname or IP that runner containers use to reach the DTU mock server on the host.                                                                                                                               |
| `LOCAL_CI_DOCKER_EXTRA_HOSTS`                 | `host.docker.internal:host-gateway` | Comma-separated `host:ip` entries passed to Docker `ExtraHosts`. Fully replaces the default when set.                                                                                                             |
| `LOCAL_CI_DOCKER_HOST_GATEWAY`                | `host-gateway`                      | Override the default `host-gateway` token or IP for the automatic host mapping.                                                                                                                                   |
| `LOCAL_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS` | unset                               | Set to `1` to disable the default `host.docker.internal` mapping.                                                                                                                                                 |
| `LOCAL_CI_DOCKER_BRIDGE_GATEWAY`              | auto-detected                       | Fallback gateway IP when Local CI runs inside Docker and cannot detect its container IP.                                                                                                                          |

---

## Runner image

By default, jobs run inside `ghcr.io/actions/actions-runner:latest` — the official self-hosted runner image. It includes the runner agent, Node.js, git, curl, jq, and unzip, but **not** build toolchains, `python3`, `xz`, or other tools that GitHub's hosted `ubuntu-latest` VM ships.

If a workflow fails with a missing tool, create a Dockerfile to add it:

```dockerfile
# .github/local-ci.Dockerfile
FROM ghcr.io/actions/actions-runner:latest
RUN sudo apt-get update \
 && sudo apt-get install -y --no-install-recommends <your-packages> \
 && sudo rm -rf /var/lib/apt/lists/*
```

Local CI picks it up automatically — no flags, no config. The image is built once and cached by content hash.

For the full guide — directory form with `COPY` support, per-job overrides, common recipes (Rust, Node native modules, Go, Ruby, Nix), the `LOCAL_CI_RUNNER_IMAGE` escape hatch, and build caching details — see [runner-image.md](https://github.com/redwoodjs/local-ci/blob/main/packages/cli/runner-image.md).

---

## macOS jobs

Jobs with `runs-on: macos-*` run in a real, throwaway macOS VM on Apple Silicon hosts with [tart](https://github.com/cirruslabs/tart) and `sshpass` installed. On any other host (Linux, Intel Mac, or missing tools), macOS jobs are skipped with a clear reason message.

The VM uses the official [cirruslabs](https://github.com/cirruslabs/macos-image-templates) images and is destroyed after the job finishes. The runner binary is fetched once and cached on the host.

Default image mapping:

| `runs-on:`               | Image                        |
| ------------------------ | ---------------------------- |
| `macos-13`               | `macos-ventura-xcode:latest` |
| `macos-14`               | `macos-sonoma-xcode:latest`  |
| `macos-15`               | `macos-sequoia-xcode:latest` |
| `macos-26`               | `macos-tahoe-xcode:latest`   |
| `macos` / `macos-latest` | `macos-sonoma-xcode:latest`  |

### Environment variables

| Variable                        | Default         | Description                                                                                                 |
| ------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `LOCAL_CI_MACOS_VM_IMAGE`       | see table above | Override the image (e.g. `ghcr.io/cirruslabs/macos-sonoma-xcode:latest`).                                   |
| `LOCAL_CI_MACOS_VM_CONCURRENCY` | `2`             | Max concurrent macOS VMs. tart's free tier allows 2 simultaneously — raise only if you have a tart license. |

### Caveats

- Only Apple Silicon hosts are supported — Virtualization.framework cannot run macOS guests on Intel Macs.
- Windows jobs (`runs-on: windows-*`) are not yet supported and always skip.

---

## Remote Docker

Local CI connects to Docker via the `LOCAL_CI_DOCKER_HOST` environment variable. By default it uses the local socket (`unix:///var/run/docker.sock`), but you can point it at any remote Docker daemon:

```bash
LOCAL_CI_DOCKER_HOST=ssh://user@remote-server npx run-local-ci run --workflow .github/workflows/ci.yml
```

> **Note:** the standard `DOCKER_HOST` env var is **not** honoured. If you have it set for the regular Docker CLI, local-ci exits with an error asking you to rename to `LOCAL_CI_DOCKER_HOST`. This lets local-ci target a different daemon than your shell's `docker` CLI without the two colliding — and it lets the value live in `.env.local-ci`.

### Docker host resolution for job containers

By default, Local CI uses `host.docker.internal` for container-to-host DTU traffic and adds a default Docker host mapping:

- `host.docker.internal:host-gateway`

This keeps behavior OS-agnostic and works on Docker Desktop and modern native Docker.

If your setup is custom, use environment overrides:

- `LOCAL_CI_DTU_HOST` — override the hostname/IP used by runner containers to reach DTU
- `LOCAL_CI_DOCKER_EXTRA_HOSTS` — comma-separated `host:ip` entries passed to Docker `ExtraHosts` (full replacement for defaults)
- `LOCAL_CI_DOCKER_HOST_GATEWAY` — override the default `host-gateway` token/IP for automatic mapping
- `LOCAL_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS=1` — disable the default `host.docker.internal` mapping
- `LOCAL_CI_DOCKER_BRIDGE_GATEWAY` — fallback gateway IP used when Local CI runs inside Docker and cannot detect its container IP, and as an explicit DTU host override outside Docker when `LOCAL_CI_DTU_HOST` is not set

When using a remote daemon (`LOCAL_CI_DOCKER_HOST=ssh://...`), `host-gateway` resolves relative to the remote Docker host. If DTU is not reachable from that host, set `LOCAL_CI_DTU_HOST` and `LOCAL_CI_DOCKER_EXTRA_HOSTS` explicitly for your network.

---

## Native Rust concurrency status

The opt-in native Rust runner runs jobs in each dependency wave concurrently and honors the shared `--jobs` limit. macOS VM jobs are also capped separately with `LOCAL_CI_MACOS_VM_CONCURRENCY` (default: `2`) so Tart VMs are not oversubscribed.

---

## YAML compatibility

See [compatibility.md](https://github.com/redwoodjs/local-ci/blob/main/packages/cli/compatibility.md) for detailed GitHub Actions workflow syntax support.

## Debugging

Set the `DEBUG` environment variable to enable verbose debug logging. It accepts a comma-separated list of glob patterns matching the namespaces you want to see:

| Value                             | What it shows                 |
| --------------------------------- | ----------------------------- |
| `DEBUG=local-ci:*`                | All debug output              |
| `DEBUG=local-ci:cli`              | CLI-level logs only           |
| `DEBUG=local-ci:runner`           | Runner/container logs only    |
| `DEBUG=local-ci:dtu`              | DTU mock-server logs only     |
| `DEBUG=local-ci:boot`             | Boot/startup timing logs only |
| `DEBUG=local-ci:cli,local-ci:dtu` | Multiple namespaces           |

- Output goes to **stderr** so stdout stays clean for piping.
- If `DEBUG` is unset or empty, all debug loggers become **no-ops** (zero overhead).
- Pattern matching uses [minimatch](https://github.com/isaacs/minimatch) globs, so `local-ci:*` matches all four namespaces.

```bash
DEBUG=local-ci:* npx run-local-ci run --workflow .github/workflows/ci.yml
```

---

## Agent output mode (NDJSON event stream)

When `--json` is passed (or `LOCAL_CI_JSON=1` is set), Local CI emits a
structured stream of newline-delimited JSON events on stdout — one JSON
object per line, each with an `event` discriminator field. Wrappers (LLM
agents, status dashboards, TUIs) can parse these instead of regex-scraping
the human-readable output.

`--json` is decoupled from `--quiet`/`AI_AGENT=1`: the latter only suppresses
the animated renderer. Pass both to combine "no terminal animation" with
"machine-readable stream." The animated renderer is automatically suppressed
when `--json` is set so its ANSI sequences don't collide with the JSON
stream on stdout.

The schema is versioned via `schemaVersion` on `run.start`. Version `1` defines
these events:

| Event         | Required fields                                                                | Optional fields                     |
| ------------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| `run.start`   | `ts`, `schemaVersion`, `runId`                                                 | `repo`, `branch`                    |
| `run.finish`  | `status` (`passed`/`failed`)                                                   | `ts`, `durationMs`                  |
| `run.paused`  | `runner`, `retry_cmd`                                                          | `ts`, `step`, `attempt`, `workflow` |
| `job.start`   | `ts`, `job`, `runner`                                                          | `workflow`                          |
| `job.finish`  | `ts`, `job`, `runner`, `status`                                                | `workflow`, `durationMs`            |
| `step.start`  | `ts`, `job`, `runner`, `step`, `index`                                         |                                     |
| `step.finish` | `ts`, `job`, `runner`, `step`, `index`, `status` (`passed`/`failed`/`skipped`) | `durationMs`                        |
| `diagnostic`  | `ts`, `level` (`info`/`warning`/`error`), `message`                            | `code`, `details`                   |

Example:

```json
{"event":"run.start","ts":"2026-04-28T10:15:00.000Z","schemaVersion":1,"runId":"run-1745837700000"}
{"event":"job.start","ts":"…","job":"lint","runner":"local-ci-1-job","workflow":"ci.yml"}
{"event":"step.start","ts":"…","job":"lint","runner":"local-ci-1-job","step":"eslint","index":1}
{"event":"step.finish","ts":"…","job":"lint","runner":"local-ci-1-job","step":"eslint","index":1,"status":"passed","durationMs":4123}
{"event":"job.finish","ts":"…","job":"lint","runner":"local-ci-1-job","workflow":"ci.yml","status":"passed","durationMs":8000}
{"event":"diagnostic","ts":"…","level":"warning","code":"prewarm_recommended","message":"2 parallel jobs will start with a cold dependency cache","details":{"selector":".github/workflows/ci.yml:test:install","candidateCount":2}}
{"event":"run.finish","ts":"…","status":"passed","durationMs":18210}
```

Stderr carries the existing human-readable progress lines and is kept free
of NDJSON noise. Non-JSON output passes through unchanged on stdout.

## The agentic dev loop

The loop: commit → Local CI runs → failure → your agent fixes the file in place with `--pause-on-failure` → retry the failed step → commit the fix → push. Local dependency caches and the paused container make this loop tight enough to work without waiting minutes for a fresh install between attempts.

Install the agent skill:

```bash
npx skills add redwoodjs/local-ci --skill local-ci
```

This works with Claude Code, Cursor, Codex, and [40+ other agents](https://agentskills.io). Then add to your agent instructions (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, etc.):

```markdown
## CI

Install the local-ci skill (one-time setup):

\`\`\`bash
npx skills add redwoodjs/local-ci --skill local-ci
\`\`\`

Before completing any work, run the `local-ci` skill to validate your changes locally. If it fails, fix the issue and re-run. Do not report work as done until it passes.
```
