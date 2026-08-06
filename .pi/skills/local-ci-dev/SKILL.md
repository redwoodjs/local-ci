---
name: local-ci-dev
description: Run local CI via the in-tree dev build of local-ci (`pnpm local-ci-dev`) to verify changes to this repo before completing work. Runs `pnpm local-ci-dev run --all` in the background, watches the log for step failures, and retries failed runners after fixes. Use before reporting work as complete, or whenever the user asks to validate, run CI, or check that changes pass. Distinct from the published `local-ci` skill, which targets downstream users via `npx run-local-ci`.
---

# Local CI (dev build)

Run local CI against the in-tree dev build (`pnpm local-ci-dev`) to verify changes to this repo before completing work.

This skill relies on two pi-native tools added by `.pi/extensions/background-shell.ts`: **`bash_background`** (start a command, return immediately) and **`monitor_wait`** (block until the log matches a pattern or the task exits). If those tools aren't available in your pi, load/reload the extension — `/reload` if you're already in a session, or relaunch pi — before continuing.

## Steps

1. **Start local-ci in the background** with `bash_background`, with the NDJSON event stream enabled:

   ```json
   { "command": "pnpm local-ci-dev run --all -q -p --json" }
   ```

   This returns `{ taskId, outputFile, pid }` without blocking. Because stdout isn't a TTY, the launcher detaches automatically: the foreground process exits **77** the moment a step pauses, while the worker keeps the container alive for `retry`.

2. **Wait for a pause or completion** with `monitor_wait`, matching the NDJSON event discriminators (silence is not success — a crash or hang with a success-only filter looks identical to still-running):

   ```json
   {
     "taskId": "<from step 1>",
     "pattern": "\"event\":\"(run\\.paused|run\\.finish)\"",
     "timeoutMs": 600000
   }
   ```

   `monitor_wait` returns when **any** of the following happens:
   - the regex matches a new line → `stoppedBecause: "match"`, inspect `matches`. A `run.paused` line carries the `runner` name + `retry_cmd`; a `run.finish` line carries `status: passed|failed`.
   - the task exits → `stoppedBecause: "exit"`, inspect `state` (`succeeded` or `failed`) and `exitCode`. Exit code **77** means a step paused — treat it like a `run.paused` match.
   - the timeout elapses → `stoppedBecause: "timeout"`, loop back and call `monitor_wait` again (it resumes from the previous byte offset automatically)

3. **On success** (`run.finish` with `status: passed`, or `state: "succeeded"`), you're done.

4. **On failure** (`run.paused` match or `exitCode: 77`), read the full output file for details:

   ```bash
   tail -n 200 <outputFile>
   ```

   **CI was passing before your work started**, so the failure is caused by your changes. Fix the issue in your code, then retry the failed runner — again via `bash_background` + `monitor_wait`:

   ```bash
   pnpm local-ci-dev retry --name <runner-name>
   ```

   If the fix requires re-running from an earlier step:

   ```bash
   pnpm local-ci-dev retry --name <runner-name> --from-step <N>
   ```

   Repeat until the job passes.

5. Once all jobs have passed, you're done.
