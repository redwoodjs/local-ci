# Changeset Rule (MANDATORY)

Every pull request that changes code in `packages/` **must** include a changeset file. Before creating a PR, always:

1. Run `pnpm changeset` to create a changeset file interactively, or manually create one in `.changeset/` with a random lowercase name (e.g., `.changeset/cool-dogs-fly.md`) using this format:

```markdown
---
"local-ci": patch
"dtu-github-actions": patch
---

Short description of the change.
```

2. Set the bump type (`patch`, `minor`, or `major`) based on the change:
   - `patch` — bug fixes, internal refactors, dependency updates
   - `minor` — new features, new CLI flags, new capabilities
   - `major` — breaking changes to CLI interface, config format, or public API

3. Both packages are versioned together (fixed versioning), so include both in the changeset header.

4. **Linking issues.** If the change resolves a reported issue, write `Closes #N` (or `Fixes #N` / `Resolves #N`) in the changeset body; use `Refs #N` / `(#N)` for a mention you don't want to close. See [RELEASING.md → Linking issues](../../RELEASING.md#linking-issues) for how the release workflow defers the close until publish.

**Do not create a PR without a changeset.** If the change is docs-only or CI-only and doesn't affect published packages, you may skip the changeset but must note why in the PR description.
