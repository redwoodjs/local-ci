# Smoke benchmark suite

Use `pnpm smoke:bench` to compare the TypeScript and native Rust orchestrators on the same curated smoke workflow set.

```bash
# Full default smoke benchmark, one run per workflow/implementation
pnpm smoke:bench

# Repeat each workflow three times and write a markdown report
pnpm smoke:bench --iterations 3 --output .docs/generated-smoke-benchmark.md

# Benchmark one workflow while iterating locally
pnpm smoke:bench --workflow .github/workflows/smoke-matrix.yml --no-build
```

The suite builds `packages/cli/dist/cli.js` and `target/release/local-ci`, then runs each selected workflow through both implementations with isolated `LOCAL_CI_WORKING_DIR` roots and the same `--jobs` limit.

Metrics are collected with `/usr/bin/time`:

- wall time
- user CPU time
- system CPU time
- approximate CPU percent
- maximum resident set size

These numbers measure the host Local CI process tree. Docker daemon and job-container CPU/memory are not included, so use the suite to compare orchestration overhead rather than total machine load.
