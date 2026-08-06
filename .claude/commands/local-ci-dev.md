---
description: Run local CI to verify changes before completing work
aliases: [validate]
---

// turbo-all

1. Run local-ci in the **background** with the NDJSON event stream enabled so you can monitor and react to failures:

```bash
pnpm local-ci-dev run --all -q -p --json 2>&1
```

Use `run_in_background: true` on the Bash tool. This returns an output file path. The launcher detaches automatically when stdout isn't a TTY; the foreground process exits **77** the instant a step pauses, while the worker keeps the container alive for `retry`.

2. Set up a **Monitor** on the output file to catch pause/finish events from the NDJSON stream:

```bash
tail -f <output-file> 2>/dev/null | grep --line-buffered -E '"event":"(run\.paused|run\.finish)"'
```

`run.paused` carries the `runner` name and `retry_cmd` you'll need in step 4. `run.finish` carries `status: passed|failed`.

3. Wait for either a monitor event (pause/finish) or a background task completion notification. If `run.finish` reports `status: passed` (or the background task exits 0 with no pause), stop the monitor with `TaskStop` and you're done.

4. If a step fails, the runner pauses and waits (foreground exit code 77; `run.paused` event in the log). **CI was passing before your work started**, so the failure is caused by your changes. Investigate and fix it:

- Read the output file for the full failure details.
- Identify and fix the issue in your code.
- Retry the failed runner (run in background and monitor the output):

```bash
pnpm local-ci-dev retry --name <runner-name>
```

- If the fix requires re-running from an earlier step:

```bash
pnpm local-ci-dev retry --name <runner-name> --from-step <N>
```

- Monitor the original output file for the retry results.
- Repeat until the job passes.

5. Once all jobs have passed, you're done.
