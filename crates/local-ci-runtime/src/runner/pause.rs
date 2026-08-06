use super::*;

pub(super) fn apply_shell_override(script: &str, shell: Option<&str>) -> String {
    let Some(shell) = shell.map(str::trim).filter(|shell| !shell.is_empty()) else {
        return script.to_owned();
    };
    let invocation = match shell {
        "sh" => "sh -e",
        "python" => "python3",
        "pwsh" => "pwsh -NoLogo -NoProfile -NonInteractive -Command -",
        _ => return script.to_owned(),
    };
    let delimiter = "__LOCAL_CI_SHELL_WRAP_EOF__";
    format!("{invocation} <<'{delimiter}'\n{script}\n{delimiter}")
}

pub(super) fn normalize_step_condition(condition: &str) -> String {
    condition
        .trim()
        .strip_prefix("${{")
        .and_then(|value| value.strip_suffix("}}"))
        .map(str::trim)
        .unwrap_or_else(|| condition.trim())
        .to_owned()
}

pub fn wrap_pause_on_failure_steps(steps: &mut [DtuJobStep]) {
    for (index, step) in steps.iter_mut().enumerate() {
        if let Some(script) = step.run.as_deref() {
            let script = apply_shell_override(script, step.shell.as_deref());
            step.run = Some(wrap_pause_on_failure_script(&script, &step.name, index + 1));
            step.shell = None;
        }
    }
}

pub fn wrap_pause_on_failure_script(script: &str, step_name: &str, step_index: usize) -> String {
    let safe_name = step_name.replace('\'', "'\\''");
    format!(
        r#"__SIGNALS="/tmp/local-ci-signals"
mkdir -p "$__SIGNALS"
__STEP_INDEX={step_index}
__WORKDIR="${{PWD:-}}"
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
  if [ -n "$__WORKDIR" ]; then cd / && cd "$__WORKDIR"; fi
  set +e
  (
{script}
  ) > "$__SIGNALS/step-output" 2>&1
  __EC=$?
  cat "$__SIGNALS/step-output"
  set -e
  if [ $__EC -eq 0 ]; then exit 0; fi
  printf '%s\n%s\n%s' '{safe_name}' "$__ATTEMPT" "$__STEP_INDEX" > "$__SIGNALS/paused"
  echo "::error::Step failed (exit $__EC). Paused — waiting for retry signal."
  while [ ! -f "$__SIGNALS/retry" ] && [ ! -f "$__SIGNALS/abort" ]; do sleep 1; done
  if [ -f "$__SIGNALS/abort" ]; then rm -f "$__SIGNALS/abort" "$__SIGNALS/paused"; exit $__EC; fi
  if [ -f "$__SIGNALS/from-step" ]; then
    __FROM_STEP=$(cat "$__SIGNALS/from-step")
    if [ "$__FROM_STEP" = '*' ]; then
      touch "$__SIGNALS/restart"
      rm -f "$__SIGNALS/retry" "$__SIGNALS/paused"
      exit 86
    fi
    if [ "$__FROM_STEP" -lt "$__STEP_INDEX" ] 2>/dev/null; then
      touch "$__SIGNALS/restart"
      rm -f "$__SIGNALS/retry" "$__SIGNALS/paused"
      exit 86
    fi
    if [ "$__FROM_STEP" -gt "$__STEP_INDEX" ] 2>/dev/null; then
      rm -f "$__SIGNALS/retry" "$__SIGNALS/paused"
      exit 0
    fi
    rm -f "$__SIGNALS/from-step"
  fi
  rm -f "$__SIGNALS/retry" "$__SIGNALS/paused"
  echo "Retrying step..."
done"#
    )
}
