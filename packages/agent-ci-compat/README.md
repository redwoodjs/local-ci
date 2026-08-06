# @redwoodjs/agent-ci

Agent CI has been renamed to **Local CI**.

Install the canonical package:

```sh
npm install --save-dev run-local-ci
```

Then replace `agent-ci` commands with `local-ci`:

```sh
local-ci run --all
```

This compatibility package forwards existing `agent-ci` commands to Local CI and will remain available through the `0.x` release line.
