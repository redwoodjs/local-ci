#!/usr/bin/env bash
#
# Boot up a devcontainer agent on a specific branch, in its own git worktree.
#
# Usage:
#   ./scripts/agents-up.sh <branch>      # Start agent on <branch>, auto-assign slot
#   ./scripts/agents-up.sh <branch> <N>  # Start agent N on <branch>
#
# If <branch> doesn't exist it will be created from the current HEAD.
# Each agent gets an isolated worktree at ../local-ci-agent-N/ so multiple
# agents can work on separate branches simultaneously.
#

set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PARENT_DIR="$(dirname "$WORKSPACE_DIR")"
REPO_NAME="$(basename "$WORKSPACE_DIR")"

# Find the VS Code CLI
if command -v code &> /dev/null; then
  CODE="code"
else
  echo "❌ Could not find the 'code' CLI."
  echo "   Install it via: VS Code → Command Palette → 'Shell Command: Install code command in PATH'"
  exit 1
fi

# Parse arguments
if [ $# -eq 0 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <branch> [agent-number]"
  exit 1
fi

BRANCH="$1"

TEMPLATE="${WORKSPACE_DIR}/.devcontainer/devcontainer.json.template"

if [ ! -f "$TEMPLATE" ]; then
  echo "❌ Template not found at ${TEMPLATE}"
  exit 1
fi

# Check if the branch is already checked out in an existing worktree
EXISTING_WORKTREE=$(git -C "$WORKSPACE_DIR" worktree list --porcelain \
  | awk '/^worktree /{wt=$2} /^branch refs\/heads\/'"${BRANCH}"'$/{print wt}')

if [ -n "$EXISTING_WORKTREE" ]; then
  # Re-open the existing worktree
  AGENT_DIR="$EXISTING_WORKTREE"
  AGENT_N=$(echo "$AGENT_DIR" | grep -o '[0-9]*$')
  echo "🌿 Branch '${BRANCH}' is already checked out at ${AGENT_DIR}"
else
  # Assign a slot and create a new worktree
  if [ $# -eq 2 ]; then
    AGENT_N="$2"
  else
    AGENT_N=1
    while [ -d "${PARENT_DIR}/${REPO_NAME}-agent-${AGENT_N}" ]; do
      AGENT_N=$((AGENT_N + 1))
    done
  fi
  AGENT_DIR="${PARENT_DIR}/${REPO_NAME}-agent-${AGENT_N}"

  if git -C "$WORKSPACE_DIR" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
    echo "🌿 Checking out existing branch '${BRANCH}' into ${AGENT_DIR}..."
    git -C "$WORKSPACE_DIR" worktree add "$AGENT_DIR" "$BRANCH"
  else
    echo "🌿 Creating new branch '${BRANCH}' in ${AGENT_DIR}..."
    git -C "$WORKSPACE_DIR" worktree add -b "$BRANCH" "$AGENT_DIR"
  fi
fi

# Generate the devcontainer config at the standard location inside the worktree
echo "📝 Generating devcontainer config..."
mkdir -p "${AGENT_DIR}/.devcontainer"
sed "s|{{N}}|${AGENT_N}|g; s|{{WORKSPACE_DIR}}|${WORKSPACE_DIR}|g" "$TEMPLATE" > "${AGENT_DIR}/.devcontainer/devcontainer.json"

# Open VS Code — devcontainer.json is at the standard location so the URI is simple
echo "🖥️  Opening VS Code..."
HEX=$(printf '%s' "$AGENT_DIR" | xxd -p | tr -d '\n')
"$CODE" --new-window --folder-uri "vscode-remote://dev-container+${HEX}/workspaces/${REPO_NAME}-agent-${AGENT_N}"

echo ""
echo "✅ Agent-${AGENT_N} is ready on branch '${BRANCH}'."
