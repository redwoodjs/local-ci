// ─── Pause-on-failure step wrapping ───────────────────────────────────────────
//
// Wraps `run:` step scripts in a retry loop so the runner pauses on failure
// and waits for an external signal (retry / abort) before continuing.

/**
 * Wrap a bash script in the pause-on-failure retry loop.
 *
 * The wrapper:
 *  1. Checks for a `from-step` signal file — if present and this step's index
 *     is below the target, the step is skipped (exit 0). When the target is
 *     reached the signal file is removed so subsequent steps run normally.
 *  2. Runs the original script
 *  3. On success → exits 0
 *  4. On failure → writes a `paused` signal file, emits a `::error::` annotation,
 *     and polls until a `retry` or `abort` signal file appears.
 *
 * @param stepIndex  1-based index of this step across ALL steps (matches the UI numbering)
 */
export function wrapStepScript(script: string, stepName: string, stepIndex: number): string {
  // Escape single-quotes in the step name so it's safe inside the echo
  const safeName = stepName.replace(/'/g, "'\\''");
  // The original script runs in a subshell `( ... )` so that:
  //  1. `exit N` inside the script terminates the subshell, not the retry loop
  //  2. The runner's `set -e` (bash -e {0}) doesn't bypass the wrapper
  return `__SIGNALS="/tmp/local-ci-signals"
__STEP_INDEX=${stepIndex}
# ── from-step skip logic ──
if [ -f "$__SIGNALS/from-step" ]; then
  __FROM_STEP=$(cat "$__SIGNALS/from-step")
  if [ "$__FROM_STEP" != '*' ] && [ "$__STEP_INDEX" -lt "$__FROM_STEP" ] 2>/dev/null; then
    echo "Skipping step $__STEP_INDEX (rewind target: step $__FROM_STEP)"
    exit 0
  fi
  rm -f "$__SIGNALS/from-step"
  echo "Resuming from step $__STEP_INDEX."
fi
__ATTEMPT=0
while true; do
  __ATTEMPT=$((__ATTEMPT + 1))
  set +e
  (
    ${script}
  ) > >(tee "$__SIGNALS/step-output") 2>&1
  __EC=$?
  set -e
  if [ $__EC -eq 0 ]; then exit 0; fi
  printf '%s\\n%s\\n%s' '${safeName}' "$__ATTEMPT" "$__STEP_INDEX" > "$__SIGNALS/paused"
  echo "::error::Step failed (exit $__EC). Paused — waiting for retry signal."
  while [ ! -f "$__SIGNALS/retry" ] && [ ! -f "$__SIGNALS/abort" ]; do sleep 1; done
  if [ -f "$__SIGNALS/abort" ]; then rm -f "$__SIGNALS/abort" "$__SIGNALS/paused"; exit $__EC; fi
  rm -f "$__SIGNALS/retry" "$__SIGNALS/paused"
  echo "Retrying step..."
done`;
}

/**
 * Clone a steps array, wrapping `run:` steps when `pauseOnFailure` is enabled.
 *
 * Only steps with `Reference.Type === "Script"` (i.e. `run:` steps) are wrapped.
 * `uses:` steps are left untouched because the runner's action dispatcher handles
 * them internally and can't be wrapped at the shell level.
 *
 * Step indices are 1-based across ALL steps (matching the tree UI numbering),
 * not just the `run:` steps.
 */
export function wrapJobSteps(steps: any[], pauseOnFailure: boolean): any[] {
  if (!pauseOnFailure || !steps) {
    return steps;
  }

  return steps.map((step, idx) => {
    if (step?.Reference?.Type !== "Script" || !step?.Inputs?.script) {
      return step;
    }
    const stepIndex = idx + 1; // 1-based to match UI
    return {
      ...step,
      Inputs: {
        ...step.Inputs,
        script: wrapStepScript(
          step.Inputs.script,
          step.Name || step.DisplayName || "step",
          stepIndex,
        ),
      },
    };
  });
}

// ─── Output capture step injection ────────────────────────────────────────────
//
// Appends a synthetic step that reads `$GITHUB_OUTPUT` files and echoes their
// contents to stdout with a `::local-ci-output::` prefix. The DTU parses these
// lines and persists them to `outputs.json` so the CLI can resolve cross-job
// outputs via `needs.*.outputs.*`.
//
// This step is necessary because the runner's FinalizeJob step deletes
// `_temp/_runner_file_commands/` _inside_ the container before it exits,
// making the files unreachable from the host.

/**
 * Build the shell script for the output-capture synthetic step.
 *
 * Reads all `set_output_*` files from `GITHUB_OUTPUT`'s directory and
 * echoes each `key=value` line with the prefix `::local-ci-output::`.
 * Multiline values (heredoc format) are flattened into single-line JSON.
 */
function outputCaptureScript(): string {
  return `# Local CI: capture step outputs for cross-job passing
DIR="$(dirname "$GITHUB_OUTPUT")"
if [ -d "$DIR" ]; then
  for f in "$DIR"/set_output_*; do
    [ -f "$f" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      if echo "$line" | grep -q '<<'; then
        # Heredoc: key<<DELIMITER ... DELIMITER
        KEY=$(echo "$line" | cut -d'<' -f1)
        DELIM=$(echo "$line" | sed 's/^[^<]*<<//')
        VAL=""
        while IFS= read -r hline || [ -n "$hline" ]; do
          [ "$hline" = "$DELIM" ] && break
          [ -n "$VAL" ] && VAL="$VAL\\\\n$hline" || VAL="$hline"
        done
        echo "::local-ci-output::$KEY=$VAL"
      else
        echo "::local-ci-output::$line"
      fi
    done < "$f"
  done
fi`;
}

/**
 * Create a synthetic step object for output capture.
 * Uses `if: always()` semantics by setting `Condition` so it runs even
 * if prior steps failed.
 */
export function createOutputCaptureStep(): Record<string, any> {
  return {
    Name: "__local_ci_output_capture",
    DisplayName: "Capture outputs",
    Reference: { Type: "Script" },
    Inputs: {
      script: outputCaptureScript(),
    },
    Condition: "always()",
    Environment: {},
    ContextName: "__local_ci_output_capture",
  };
}

/**
 * Append the output-capture step to a steps array.
 * Only adds it if there are existing steps and the job has outputs defined.
 */
export function appendOutputCaptureStep(steps: any[]): any[] {
  if (!steps || steps.length === 0) {
    return steps;
  }
  return [...steps, createOutputCaptureStep()];
}
