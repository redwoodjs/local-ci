# Marketing

## Demo Recording

Terminal demo of local-ci using [VHS](https://github.com/charmbracelet/vhs).

### Prerequisites

```bash
brew install vhs tmux
```

Docker must be running.

### Record

```bash
cd .docs/marketing/demo-recording
vhs demo.tape
```

The tape automatically resets `value.txt` to `fail` before each recording. Produces `demo.gif`.

### What the demo shows

1. **Standard GitHub Actions workflow** — real `actions/checkout`, `actions/setup-node`, `runs-on: ubuntu-latest`
2. **Instant startup** — no cache downloads, runner boots immediately
3. **Pause on failure** — test fails, runner pauses with error output visible
4. **Fix and retry** — fix the bug in the right pane, press Enter to retry, tests pass

### Tuning

- Adjust `Sleep` durations in `demo.tape` if your machine is faster/slower
- `Wait+Screen` commands auto-wait for key output, so most timings are resilient
- Change `Set Theme` to try different color schemes
