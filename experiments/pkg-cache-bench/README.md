# Package Manager Cache Benchmark

Benchmarks install speed for **NPM**, **Yarn**, and **Bun** across 4 caching scenarios
using a real [create-rwsdk](https://www.npmjs.com/package/create-rwsdk) project.

## Why

Local CI already caches PNPM installs via warm `node_modules` bind-mounts (symlinked into containers).
This experiment measures whether the same strategy works for other package managers.

## Run

```bash
# All package managers
bash bench.sh

# Specific ones
bash bench.sh --pm npm
bash bench.sh --pm yarn
bash bench.sh --pm bun
bash bench.sh --pm npm,bun
```

## Scenarios

| #   | Scenario         | What it tests                                           |
| --- | ---------------- | ------------------------------------------------------- |
| 1   | **Cold install** | Fresh install, no cache, no `node_modules`              |
| 2   | **Warm cache**   | Global cache populated, but `node_modules` deleted      |
| 3   | **Warm modules** | `node_modules` already present, incremental install     |
| 4   | **Symlink only** | Symlink a cached `node_modules` — **no install at all** |

**Scenario 4 is the interesting one** — it's what Local CI does for PNPM. If it's ≫5× faster
than cold install, the warm-modules strategy generalises to all package managers.

## Requirements

- **npm** (bundled with Node)
- **yarn** v1: `npm i -g yarn`
- **bun**: `curl -fsSL https://bun.sh/install | bash`
