---
"local-ci": patch
"dtu-github-actions": patch
---

Write `FETCH_HEAD` when the Git shim simulates a successful fetch so detached checkouts can resolve the fetched commit. Closes #391.
