# Runner image

local-ci runs each job inside a Docker container. By default that container is `ghcr.io/actions/actions-runner:latest` — the official GitHub self-hosted runner image. It ships the runner agent, Node.js, git, curl, jq, unzip, and not much else. In particular, it does **not** include `build-essential`, `gcc`, `cc`, `python3`, `clang`, or any language toolchain.

This is very different from GitHub's hosted `ubuntu-latest` runner, which is a ~30GB VM image preloaded with hundreds of tools (see [`actions/runner-images`](https://github.com/actions/runner-images)). That VM is **not published as a container image** — there is nothing to pull — so local-ci cannot use it directly.

If a workflow that runs green on GitHub fails locally with `linker 'cc' not found`, `python: command not found`, `you do not have 'xz' installed`, or similar, this gap is why.

## Adding tools: `.github/local-ci.Dockerfile`

Create a Dockerfile at `.github/local-ci.Dockerfile` in your repo. local-ci picks it up automatically on the next run, builds it once, and caches the result.

```dockerfile
FROM ghcr.io/actions/actions-runner:latest
RUN sudo apt-get update \
 && sudo apt-get install -y --no-install-recommends \
      build-essential \
      pkg-config \
 && sudo rm -rf /var/lib/apt/lists/*
```

That's it. No config file. No flags.

- The image is tagged `local-ci-runner:<sha-of-Dockerfile-contents>`, so every edit forces a rebuild and identical contents reuse the cached build.
- **The first run is slow — local-ci has to build the image and cache it (~60–90s for a common toolchain). Every run after that reuses the cached image and takes ~0s.** local-ci prints a one-line notice while the build is running so you can tell why it's pausing.
- All jobs in your repo use this image unless they set an explicit `container:` directive (which still works — see [Per-job overrides](#per-job-overrides)).

## Directory form: `.github/local-ci/Dockerfile`

If you need to `COPY` files into the image — corporate CA certs, a pinned binary, a lockfile for apt — use the directory form:

```
.github/
  local-ci/
    Dockerfile
    ca-bundle.pem
    ...
```

```dockerfile
FROM ghcr.io/actions/actions-runner:latest
COPY ca-bundle.pem /usr/local/share/ca-certificates/corp.crt
RUN sudo update-ca-certificates \
 && sudo apt-get update && sudo apt-get install -y build-essential
```

local-ci builds it with `.github/local-ci/` as the context, so everything next to the Dockerfile is copyable. The hash includes every file in the context, so adding or changing any of them forces a rebuild.

If both forms are present, the directory form wins.

## Common recipes

These are copy-paste examples — local-ci does not ship any of them as a default.

**Rust / cargo (`cc-rs`, native build scripts):**

```dockerfile
FROM ghcr.io/actions/actions-runner:latest
RUN sudo apt-get update \
 && sudo apt-get install -y --no-install-recommends build-essential pkg-config \
 && sudo rm -rf /var/lib/apt/lists/*
```

**Node.js native modules (`node-gyp`, `sharp`, `bcrypt`):**

```dockerfile
FROM ghcr.io/actions/actions-runner:latest
RUN sudo apt-get update \
 && sudo apt-get install -y --no-install-recommends build-essential python3 \
 && sudo rm -rf /var/lib/apt/lists/*
```

**Go with cgo:**

```dockerfile
FROM ghcr.io/actions/actions-runner:latest
RUN sudo apt-get update \
 && sudo apt-get install -y --no-install-recommends build-essential \
 && sudo rm -rf /var/lib/apt/lists/*
```

**Nix (`cachix/install-nix-action`, `DeterminateSystems/nix-installer-action`):**

```dockerfile
FROM ghcr.io/actions/actions-runner:latest
RUN sudo apt-get update \
 && sudo apt-get install -y --no-install-recommends xz-utils \
 && sudo rm -rf /var/lib/apt/lists/*
```

**Ruby native gems:**

```dockerfile
FROM ghcr.io/actions/actions-runner:latest
RUN sudo apt-get update \
 && sudo apt-get install -y --no-install-recommends build-essential libffi-dev libyaml-dev \
 && sudo rm -rf /var/lib/apt/lists/*
```

## Per-job overrides

The standard GitHub Actions `jobs.<id>.container:` directive is still honored — and takes priority over `.github/local-ci.Dockerfile`. Use it when a single job needs a different environment than the rest of your repo:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    container: my-org/deploy-runner:v2
    steps:
      - run: ./deploy.sh
```

When a job sets `container:`, local-ci runs that image **verbatim**. It does **not** layer `.github/local-ci.Dockerfile` on top, and it does **not** build anything. Whatever you put in `container:` is what runs, exactly as on GitHub-hosted runners. This keeps the "same YAML runs locally and on GitHub" parity promise — locally layering would silently change the environment relative to GitHub.

If you want both your own base image **and** local-ci's extras, pick one:

- Skip `container:` and put everything in `.github/local-ci.Dockerfile` (one image, applies to all jobs).
- Or build your own image that inherits from your preferred base and adds what you need, then reference it with `container:`.

## CI escape hatch: `LOCAL_CI_RUNNER_IMAGE`

Setting the `LOCAL_CI_RUNNER_IMAGE` environment variable overrides all discovery and uses that image directly:

```bash
LOCAL_CI_RUNNER_IMAGE=my-org/internal-runner:v3 local-ci run --all
```

Highest priority (after per-job `container:`). Useful for CI pipelines that want to force a specific image without touching files in the repo.

## Resolution order

Highest priority wins:

1. `jobs.<id>.container:` in workflow YAML (per-job override)
2. `LOCAL_CI_RUNNER_IMAGE` environment variable
3. `.github/local-ci/Dockerfile` (directory form)
4. `.github/local-ci.Dockerfile` (simple form)
5. `ghcr.io/actions/actions-runner:latest` (built-in default)

## Build caching

When local-ci builds from one of your Dockerfiles, it:

1. Hashes the Dockerfile contents (simple form) or Dockerfile + all context files (directory form), sorted deterministically.
2. Tags the image `local-ci-runner:<hash-prefix>`.
3. Checks if that tag already exists locally — if so, reuses it.
4. Otherwise runs `docker build`, pulling `ghcr.io/actions/actions-runner:latest` first if needed (most Dockerfiles inherit from it).

Clean up old builds with `docker image prune` or `docker rmi local-ci-runner:<tag>` as normal — they're regular Docker images with no special lifecycle.
