---
"run-local-ci": minor
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

Rename Agent CI to Local CI. The canonical package is now `run-local-ci` and the canonical executable is `local-ci`. The old `@redwoodjs/agent-ci` package forwards to Local CI, while `AGENT_CI_*`, `.env.agent-ci`, and `.github/agent-ci*` remain supported compatibility aliases throughout the `0.x` release line.
