#!/usr/bin/env bash
# Smoke #289: `local-ci run --json` emits a well-formed NDJSON event stream
# on stdout. Asserts run.start (with schemaVersion=1), step.start/finish for
# every step, job.finish, and a final run.finish with status=passed. Also
# asserts every JSON-shaped line on stdout parses and carries a known event.
#
# Requires Docker. Run from anywhere:
#
#   ./scripts/smoke-289.sh
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
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/.github/workflows"
cat > "$TMP/.github/workflows/ok.yml" <<'YAML'
name: ok
on: push
jobs:
  ok-job:
    runs-on: ubuntu-latest
    steps:
      - name: first
        run: echo first
      - name: second
        run: echo second
YAML

cd "$TMP"
git init -q
git config user.email smoke@289
git config user.name smoke
git remote add origin https://github.com/smoke/issue-289.git
git add . >/dev/null
git commit -q -m init
export GITHUB_REPO=smoke/issue-289

OUT="$TMP/events.ndjson"
echo "▶ local-ci run --json -w ok.yml…"
"$LOCAL_CI" run --json -w ok.yml > "$OUT" 2>"$TMP/stderr.log"
EC=$?
echo "▶ exit code: $EC"

if [ "$EC" -ne 0 ]; then
  echo "✗ FAIL: local-ci exited $EC (expected 0)"
  echo "── stderr ─────"; cat "$TMP/stderr.log"
  echo "── stdout ─────"; cat "$OUT"
  exit 1
fi

# Filter to JSON-shaped lines only and parse each one. Any malformed JSON or
# unknown event aborts.
JSON_LINES="$(grep -E '^\{' "$OUT" || true)"
if [ -z "$JSON_LINES" ]; then
  echo "✗ FAIL: no JSON events on stdout"
  cat "$OUT"
  exit 1
fi

# Every JSON line must parse and have a known `event` field.
KNOWN='run.start|run.finish|run.paused|job.start|job.finish|step.start|step.finish|diagnostic'
while IFS= read -r line; do
  ev="$(echo "$line" | jq -er '.event' 2>/dev/null || echo "<no-event>")"
  if ! echo "$ev" | grep -qE "^($KNOWN)$"; then
    echo "✗ FAIL: unrecognized event '$ev' on line: $line"
    exit 1
  fi
done <<< "$JSON_LINES"

# Required events.
require() {
  local pred="$1" desc="$2"
  if ! echo "$JSON_LINES" | jq -e "select($pred)" > /dev/null; then
    echo "✗ FAIL: missing required event — $desc"
    echo "── events ─────"; echo "$JSON_LINES"
    exit 1
  fi
}

require '.event=="run.start" and .schemaVersion==1'           "run.start with schemaVersion=1"
require '.event=="step.start" and .step=="first"'             "step.start for 'first'"
require '.event=="step.finish" and .step=="first" and .status=="passed"'   "step.finish passed for 'first'"
require '.event=="step.start" and .step=="second"'            "step.start for 'second'"
require '.event=="step.finish" and .step=="second" and .status=="passed"'  "step.finish passed for 'second'"
require '.event=="job.finish" and .status=="passed"'          "job.finish passed"
require '.event=="run.finish" and .status=="passed"'          "run.finish passed"

echo
echo "✓ PASS: NDJSON event stream is well-formed and complete."
