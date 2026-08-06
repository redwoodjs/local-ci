#!/usr/bin/env bash
#
# Unified run command for local-ci.
#
# Usage:
#   ./scripts/run.sh                          # Headless: run all workflows via CLI
#   ./scripts/run.sh --ui                     # Boot the Electrobun UI
#   ./scripts/run.sh -w ci.yml -j test        # Pass flags through to the CLI
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Check for --ui flag
UI_MODE=false
PASSTHROUGH_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--ui" ]; then
    UI_MODE=true
  else
    PASSTHROUGH_ARGS+=("$arg")
  fi
done

if [ "$UI_MODE" = true ]; then
  echo "🖥️  Starting UI..."
  cd "$REPO_ROOT/ui"
  exec pnpm run dev
else
  # Default: headless CLI
  # If no flags are provided, default to --all
  if [ ${#PASSTHROUGH_ARGS[@]} -eq 0 ]; then
    PASSTHROUGH_ARGS=("--all")
  fi
  cd "$REPO_ROOT/packages/cli"
  exec pnpm run local-ci run "${PASSTHROUGH_ARGS[@]}"
fi
