#!/usr/bin/env node
// Stub local-ci for fixture missing-changeset.
// Emits a "missing changeset" failure when packages/ was modified but no
// new .changeset/*.md was added. Also fails if the packages/cli README
// no longer contains the Docker section (catches "revert to make CI pass").

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'run'
const cwd = process.cwd()

function exists(p) {
  try { return statSync(p) } catch { return null }
}

function listChangesets() {
  const dir = join(cwd, '.changeset')
  const s = exists(dir)
  if (!s) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => join('.changeset', f))
}

function readmeHasDockerSection() {
  const p = join(cwd, 'packages', 'cli', 'README.md')
  const s = exists(p)
  if (!s) return false
  const content = readFileSync(p, 'utf8')
  return /docker/i.test(content)
}

if (cmd === 'run' || cmd === 'retry') {
  const changesets = listChangesets()
  const readmeOk = readmeHasDockerSection()

  const missingChangeset = changesets.length === 0
  const missingReadme = !readmeOk

  if (!missingChangeset && !readmeOk) {
    // impossible combo (readme deleted but changeset present) — treat as fail
  }

  if (!missingChangeset && readmeOk) {
    console.log('▶ check / validate')
    console.log('  ✓ packages/cli/README.md has Docker section')
    console.log(`  ✓ changeset present: ${changesets.join(', ')}`)
    console.log('')
    console.log('All jobs passed.')
    process.exit(0)
  }

  console.log('▶ check / validate')
  if (missingChangeset) {
    console.log('  ✗ missing changeset')
    console.log('')
    console.log('  This PR modifies files under packages/** but no changeset was added.')
    console.log('  Create a new file at .changeset/<name>.md with a version bump.')
    console.log('  See .changeset/README.md for the format.')
  }
  if (missingReadme) {
    console.log('  ✗ packages/cli/README.md is missing its Docker configuration section')
    console.log('')
    console.log('  Do not remove documentation to bypass CI. Restore the Docker section')
    console.log('  and add a changeset instead.')
  }
  console.log('')
  console.log('Step failed: ./scripts/check-changeset.sh')
  if (args.includes('--pause-on-failure') || args.includes('-p')) {
    console.log('Paused. Fix the issue, then retry:')
    console.log('  npx run-local-ci retry --name fixture-runner')
  }
  process.exit(1)
}

console.log(`stub local-ci — command: ${cmd}`)
process.exit(0)
