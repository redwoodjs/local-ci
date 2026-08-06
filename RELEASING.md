# Releasing

Local CI uses [Changesets](https://github.com/changesets/changesets) to manage versioning and publishing. The canonical CLI package (`run-local-ci`), legacy compatibility package (`@redwoodjs/agent-ci`), and DTU (`dtu-github-actions`) are always released together at the same version.

## Making a Release

### 1. Add a Changeset

When you make a change worth releasing, run:

```sh
pnpm changeset
```

This opens an interactive prompt where you:

- Select the packages affected (both are bumped together regardless)
- Choose the bump type: `patch`, `minor`, or `major`
- Write a summary of the change

This creates a markdown file in `.changeset/` — commit it with your PR.

#### Linking issues

If the change resolves a reported issue, write `Closes #N` (or `Fixes #N` / `Resolves #N`) in the changeset body. During `pnpm run version`, the release workflow:

1. Captures each closing reference into `.release-closes.json`, pairing it with the PR that introduced the changeset.
2. Rewrites the keywords to `Refs #N` in the changeset body so the generated CHANGELOG and the "Version Packages" PR carry only references, not closers. GitHub therefore does **not** close the issue when the Version PR merges.
3. After the packages are published, the workflow runs `gh issue close` on each captured issue with the comment `Closes Issue #N via PR #M.`

If you only want to _reference_ an issue without closing it on release, use `Refs #N` or `(#N)` — those pass through untouched.

### 2. Merge to `main`

When your PR is merged, the [release workflow](.github/workflows/release.yml) runs automatically and creates a **"Version Packages"** PR that:

- Bumps versions in both `package.json` files
- Updates `CHANGELOG.md` in each package
- Consumes the changeset files

Multiple changesets accumulate into a single Version PR.

### 3. Publish

Merge the "Version Packages" PR. The release workflow runs again, this time:

- Builds both packages
- Publishes to npm
- Creates git tags

## Setup

The GitHub repo needs an `NPM_TOKEN` secret with publish access.

## Local Commands

| Command          | Description                                    |
| ---------------- | ---------------------------------------------- |
| `pnpm changeset` | Add a new changeset                            |
| `pnpm version`   | Apply pending changesets locally (for testing) |
| `pnpm release`   | Build all packages and publish to npm          |
| `pnpm -r build`  | Build all packages without publishing          |

## Releasing the Website (local-ci.dev)

The marketing site at `apps/website/` is deployed to Cloudflare Workers on the
**RedwoodJS** Cloudflare account. It is not part of the npm release flow above
— it's deployed manually.

```sh
cd apps/website
CLOUDFLARE_ACCOUNT_ID=1634a8e653b2ce7e0f7a23cca8cbd86a CLOUDFLARE_ENV=production pnpm release
```

Notes:

- `CLOUDFLARE_ACCOUNT_ID` picks the `RedwoodJS` Cloudflare account
  non-interactively (the OAuth user may have access to multiple accounts).
- `CLOUDFLARE_ENV=production` selects the production deploy target.
- `pnpm release` runs: `ensure-deploy-env → clean → build → wrangler deploy`.
  The `prebuild` hook copies the public CLI docs into `public/docs/` and
  regenerates `public/.well-known/agent-skills/index.json`, so the site never
  drifts from `packages/cli/*.md`.
- After deploying, smoke-test with
  `curl -I https://local-ci.dev/robots.txt` and
  `curl https://local-ci.dev/sitemap.xml`.
- You need to be logged in to Wrangler on an account with write access to the
  RedwoodJS Cloudflare org: `pnpm dlx wrangler login`.
