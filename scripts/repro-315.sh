#!/usr/bin/env bash
# Reproduce issue #315: `local-ci run --pause-on-failure` blocks indefinitely
# when stdout is piped or redirected. With the fix in place, the launcher
# exits with code 77 the instant the worker pauses, freeing the caller's pipe.
#
# Without the fix this script's `timeout 60` fires (exit 124).
# With the fix the script exits 77 within a few seconds of the step failing.
#
# Requires Docker. Run from anywhere:
#
#   ./scripts/repro-315.sh
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_CI="$REPO_ROOT/scripts/local-ci-dev.sh"

TMP="$(mktemp -d)"
RUNNER_NAME=""

cleanup() {
  # Best-effort: abort whatever runner the worker launched and tear down the
  # tmp repo. We don't know the runner name until the sentinel arrives, so
  # parse it from the captured output if available.
  if [ -n "$RUNNER_NAME" ]; then
    "$LOCAL_CI" abort --name "$RUNNER_NAME" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# Tiny throwaway repo with a workflow whose single step fails immediately.
mkdir -p "$TMP/.github/workflows"
cat > "$TMP/.github/workflows/fail.yml" <<'YAML'
name: fail
on: push
jobs:
  fail-job:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "step about to fail"
          exit 1
YAML

cd "$TMP"
git init -q
git config user.email repro@315
git config user.name repro
git remote add origin https://github.com/repro/issue-315.git
git add . >/dev/null
git commit -q -m init
export GITHUB_REPO=repro/issue-315

OUT="$TMP/out.log"
echo "▶ local-ci run -w fail.yml -p (piped through cat, 60s timeout)…"
START=$SECONDS
set +e
timeout 60 "$LOCAL_CI" run -w fail.yml -p 2>&1 | tee "$OUT" | cat >/dev/null
EC="${PIPESTATUS[0]}"
set -e
ELAPSED=$((SECONDS - START))

# Grab the runner name from the run.paused NDJSON event for cleanup.
RUNNER_NAME="$(grep -oE '"event":"run.paused"[^}]*"runner":"[^"]+"' "$OUT" | grep -oE '"runner":"[^"]+"' | head -1 | cut -d'"' -f4 || true)"

echo
echo "▶ exit code: $EC   elapsed: ${ELAPSED}s   runner: ${RUNNER_NAME:-<none>}"
echo
echo "▶ tail of captured output:"
tail -10 "$OUT"

case "$EC" in
  124)
    echo
    echo "✗ FAIL: command timed out at 60s — issue #315 is still reproducible."
    exit 1
    ;;
  77)
    echo
    echo "✓ PASS: launcher exited 77 in ${ELAPSED}s — fix works."
    exit 0
    ;;
  *)
    echo
    echo "✗ UNEXPECTED: exit $EC (expected 77 for paused, 124 for hang)."
    exit 1
    ;;
esac
