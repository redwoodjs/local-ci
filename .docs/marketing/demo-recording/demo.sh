#!/usr/bin/env bash
# Live demo of local-ci's pause/retry loop.
# Run:  bash .docs/marketing/demo-recording/demo.sh

set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEMO_DIR/../../.." && pwd)"
SESSION="local-ci-demo"

command -v tmux >/dev/null || { echo "tmux is required (brew install tmux)"; exit 1; }

cd "$DEMO_DIR"

echo "==> Resetting value.txt to 'fail'"
echo fail > value.txt

echo "==> Pre-building dtu-github-actions (one-time warmup)"
(cd "$REPO_ROOT/packages/dtu-github-actions" && pnpm --silent run build) >/dev/null 2>&1
echo "    done."
echo

cat <<'EOF'
┌─ DEMO — local-ci pause / retry loop ──────────────────────────┐
│                                                               │
│  Layout       [ left = runner ]   [ right = your shell ]      │
│                                                               │
│  Tmux         Ctrl+B  ←  / →    switch panes                  │
│               Ctrl+B  d         detach (session keeps going)  │
│                                                               │
│  When the runner pauses on failure:                           │
│    1. Ctrl+B  →           switch to right pane                │
│    2. [Enter]             run the pre-typed fix:              │
│                             echo pass > value.txt             │
│    3. Ctrl+B  ←           back to runner pane                 │
│    4. [Enter]             retry the failed step               │
│                                                               │
│  Quit         Ctrl+C in the runner pane,  then  exit          │
│                                                               │
└───────────────────────────────────────────────────────────────┘
EOF
echo
read -r -p "Press [Enter] to start the demo..."

tmux -L demo kill-session -t "$SESSION" 2>/dev/null || true

RUNNER_CMD="cd '$DEMO_DIR' && '$REPO_ROOT/scripts/local-ci-dev.sh' run --workflow .github/workflows/ci.yml -p; echo; read -r -p 'Demo finished. Press [Enter] to close...'"

LEFT=$(tmux -L demo new-session -d -s "$SESSION" -x 200 -y 50 -c "$DEMO_DIR" \
  -P -F '#{pane_id}' -- bash -c "$RUNNER_CMD")
RIGHT=$(tmux -L demo split-window -h -t "$LEFT" -l 60 -c "$DEMO_DIR" \
  -P -F '#{pane_id}' -- bash)
tmux -L demo setw -t "$SESSION" pane-border-style "fg=colour238"
tmux -L demo setw -t "$SESSION" pane-active-border-style "fg=colour244"

# Pre-type the fix in the right pane (no Enter — the presenter triggers it live)
tmux -L demo send-keys -t "$RIGHT" "echo pass > value.txt"

# Start focused on the runner pane so the audience sees the workflow boot
tmux -L demo select-pane -t "$LEFT"

tmux -L demo attach -t "$SESSION"

# Cleanup once the user detaches/exits
tmux -L demo kill-session -t "$SESSION" 2>/dev/null || true
