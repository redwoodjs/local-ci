# Local CI Demo — VHS Tape
# Records a terminal demo showing: pause-on-failure, fix, retry, pass.
#
# Prerequisites:
#   brew install vhs tmux
#   Docker running
#
# Record:
#   cd .docs/marketing/demo-recording && vhs demo.tape

Output demo.gif
Output demo.mp4

Require tmux

Set Shell "bash"
Set FontSize 14
Set Width 1400
Set Height 700
Set Padding 20
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set TypingSpeed 40ms
Set Framerate 30

# --- Boot tmux with two vertical panes ---

Hide
Type "tmux -f /dev/null -L demo new-session -x 170 -y 40 -- bash"
Enter
Sleep 1s
Type "tmux split-window -d -h -l 55 -- bash"
Enter
Sleep 500ms
Type "tmux setw pane-border-style fg=colour238"
Enter
Type "tmux setw pane-active-border-style fg=colour238"
Enter
# Reset the failure state for a clean recording
Type "echo fail > value.txt"
Enter
Sleep 500ms
# Pre-build DTU so the first run starts instantly
Type "(cd ../../../packages/dtu-github-actions && pnpm run build --silent) 2>/dev/null"
Enter
Sleep 10s
Type "clear"
Enter
Sleep 500ms
Show

# === ACT 1: Show what we're working with ===

Sleep 1s

# Show the workflow file — standard GitHub Actions
Type "cat .github/workflows/ci.yml"
Enter
Sleep 4s

# Show the broken test value
Type "cat value.txt"
Enter
Sleep 2s

# === ACT 2: Run local-ci — it starts instantly (0ms cold cache) ===

Type "pnpm run local-ci run --workflow .github/workflows/ci.yml --pause-on-failure"
Enter

# Wait for the runner to start and the test to fail (up to 2 minutes)
Wait+Screen@180s /Step failed/
Sleep 3s

# === ACT 3: Fix the bug in the right pane ===

# Switch to right pane using tmux prefix + arrow
Ctrl+B
Right
Sleep 500ms

# Show the broken value
Type "cat value.txt"
Enter
Sleep 2s

# Fix it
Type@80ms "echo pass > value.txt"
Enter
Sleep 1s

# Verify the fix
Type "cat value.txt"
Enter
Sleep 2s

# === ACT 4: Switch back to left pane and press Enter to retry ===

Ctrl+B
Left
Sleep 500ms

# The hint says "[enter]" — just press Enter to retry
Enter
Sleep 500ms

Wait+Screen@180s /passed/
Sleep 5s

# === END ===
