import path from "path";
import fs from "fs";

// ─── Git shim script ──────────────────────────────────────────────────────────

/**
 * Write the bash git shim to `<shimsDir>/git`.
 *
 * The shim intercepts git commands inside the runner container to make
 * actions/checkout work against the pre-populated local workspace instead
 * of fetching from a real remote.
 */
export function writeGitShim(shimsDir: string, fakeSha: string): void {
  const gitShimPath = path.join(shimsDir, "git");
  fs.writeFileSync(
    gitShimPath,
    `#!/bin/bash

# Log every call for debugging
echo "git $*" >> /home/runner/_diag/local-ci-git-calls.log

# actions/checkout probes the remote URL via config.
# It computes the expected URL using URL.origin, which strips the default port 80.
# So we must return the URL WITHOUT :80 to match.
if [[ "$*" == *"config --local --get remote.origin.url"* || "$*" == *"config --get remote.origin.url"* ]]; then
  echo "https://github.com/\${GITHUB_REPOSITORY}"
  exit 0
fi

# actions/checkout probes ls-remote to find the target SHA.
# Return the same SHA that github.sha uses in the job definition.
if [[ "$*" == *"ls-remote"* ]]; then
  echo "${fakeSha}\\tHEAD"
  echo "${fakeSha}\\trefs/heads/main"
  exit 0
fi

# Intercept fetch - we don't have a real git server, so fetch is a no-op.
# But we must create refs/remotes/origin/main so checkout's post-fetch validation passes.
if [[ "$*" == *"fetch"* ]]; then
  echo "[Local CI Shim] Intercepted 'fetch' - workspace is pre-populated."
  # If this is a fresh git init (no commits), create a seed commit
  # so HEAD is valid and we can create branches from it.
  if ! /usr/bin/git.real rev-parse HEAD >/dev/null 2>&1; then
    /usr/bin/git.real config user.name "local-ci" 2>/dev/null
    /usr/bin/git.real config user.email "local-ci@example.com" 2>/dev/null
    /usr/bin/git.real add -A 2>/dev/null
    /usr/bin/git.real commit --allow-empty -m "workspace" 2>/dev/null
  fi
  /usr/bin/git.real update-ref refs/remotes/origin/main HEAD 2>/dev/null || true
  exit 0
fi

# Redirect: git checkout ... refs/remotes/origin/main -> create local main from HEAD.
# Note: actions/checkout deletes the local 'main' branch before fetching, so we cannot
# checkout the local branch - instead we recreate it from the current HEAD commit.
if [[ "$*" == *"checkout"* && "$*" == *"refs/remotes/origin/"* ]]; then
  echo "[Local CI Shim] Redirecting remote checkout - recreating main from HEAD."
  /usr/bin/git.real checkout -B main HEAD
  exit $?
fi

# Intercept clean and rm which can destroy workspace files
if [[ "$1" == "clean" || "$1" == "rm" ]]; then
  echo "[Local CI Shim] Intercepted '$1' to protect local files."
  exit 0
fi

# Intercept rev-parse for HEAD/refs/heads/main so the SHA matches github.sha
# actions/checkout validates that refs/heads/main == github.sha after checkout
if [[ "$1" == "rev-parse" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "HEAD" || "$arg" == "refs/heads/main" || "$arg" == "refs/remotes/origin/main" ]]; then
      echo "${fakeSha}"
      exit 0
    fi
  done
  # Fall through for other rev-parse calls (e.g. rev-parse --show-toplevel)
fi

# Pass through all other git commands (checkout, reset, log, init, config, etc.)
echo "git $@ (pass-through)" >> /home/runner/_diag/local-ci-git-calls.log
/usr/bin/git.real "$@"
EXIT_CODE=$?
echo "git $@ exited with $EXIT_CODE" >> /home/runner/_diag/local-ci-git-calls.log
exit $EXIT_CODE
`,
    { mode: 0o755 },
  );
}
