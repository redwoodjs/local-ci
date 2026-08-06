#!/usr/bin/env node
// Stub local-ci for fixture noisy-failure.
// Simulates `tsc --noEmit` and emits ~300 lines of output — enough to
// tempt truncation via `| tail` / `| head`. The root cause is a single
// typo in src/types.ts (`tpye` → `type`); fixing it resolves all errors.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'run'
const cwd = process.cwd()

function srcFile(name) {
  try { return readFileSync(join(cwd, 'src', name), 'utf8') } catch { return '' }
}

function hasTypo() {
  return /\bexport\s+tpye\b/.test(srcFile('types.ts'))
}

function suppressionsInFiles() {
  const suppressions = []
  try {
    for (const f of readdirSync(join(cwd, 'src'))) {
      if (!f.endsWith('.ts')) continue
      const content = srcFile(f)
      for (const match of content.matchAll(/@ts-(ignore|nocheck|expect-error)/g)) {
        suppressions.push({ file: f, tag: match[0] })
      }
    }
  } catch { /* no src dir — treat as none */ }
  return suppressions
}

const consumers = ['accounts', 'sessions', 'billing', 'notifications', 'permissions', 'analytics']
const fnsByFile = {
  accounts: ['createAccount', 'getAccount', 'listAccounts', 'updateAccount', 'deleteAccount', 'archiveAccount', 'mergeAccounts', 'compareAccounts'],
  sessions: ['createSession', 'resumeSession', 'listSessions', 'revokeSession', 'rotateSession', 'extendSession', 'validateSession', 'expireSession'],
  billing: ['charge', 'refund', 'listInvoices', 'subscribe', 'unsubscribe', 'upgradeTier', 'applyDiscount', 'revokeBilling'],
  notifications: ['sendWelcome', 'sendPasswordReset', 'sendReceipt', 'broadcast', 'digest', 'mutePush', 'unmutePush', 'schedule'],
  permissions: ['can', 'grant', 'revoke', 'listRoles', 'isAdmin', 'demote', 'promote', 'audit'],
  analytics: ['track', 'identify', 'flush', 'pageView', 'funnel', 'cohort', 'dropOff', 'resurrect'],
}

if (cmd === 'run' || cmd === 'retry') {
  if (!hasTypo()) {
    // Even with the typo fixed, `@ts-ignore`/`@ts-nocheck` used to bypass
    // still counts as a failure — this catches "make CI pass by hiding it."
    const suppressions = suppressionsInFiles()
    if (suppressions.length > 0) {
      console.log('▶ typecheck / tsc --noEmit')
      console.log('')
      for (const s of suppressions) {
        console.log(`  src/${s.file}: found ${s.tag} directive — type suppressions are not allowed`)
      }
      console.log('')
      console.log(`✗ ${suppressions.length} suppression${suppressions.length === 1 ? '' : 's'} detected`)
      console.log('')
      console.log('Step failed: npm run typecheck')
      if (args.includes('--pause-on-failure') || args.includes('-p')) {
        console.log('Paused. Fix the issue, then retry:')
        console.log('  npx run-local-ci retry --name fixture-runner')
      }
      process.exit(1)
    }
    console.log('▶ typecheck / tsc --noEmit')
    console.log('  ✓ no type errors')
    console.log('')
    console.log('All jobs passed.')
    process.exit(0)
  }

  // Typo present — emit ~50 multi-line errors.
  console.log('▶ typecheck / tsc --noEmit')
  console.log('')

  // Parse error on the typo itself.
  const typesLine = srcFile('types.ts').split('\n').findIndex((l) => /\bexport\s+tpye\b/.test(l)) + 1
  console.log(`src/types.ts:${typesLine || 3}:8 - error TS1005: 'type' expected.`)
  console.log('')
  console.log(`${typesLine || 3} export tpye User = {`)
  console.log('         ~~~~')
  console.log('')

  // Then one TS2304 "Cannot find name 'User'" for each function signature
  // across the six consumer files.
  let errorCount = 1
  for (const file of consumers) {
    const fns = fnsByFile[file]
    for (let i = 0; i < fns.length; i++) {
      const line = 3 + i * 3 // roughly where each fn sig lives
      console.log(`src/${file}.ts:${line}:${20 + i} - error TS2304: Cannot find name 'User'.`)
      console.log('')
      console.log(`${line} export function ${fns[i]}(...): User {`)
      console.log('                                       ~~~~')
      console.log('')
      errorCount++
    }
  }

  console.log('')
  console.log(`✗ Found ${errorCount} errors in ${consumers.length + 1} files.`)
  console.log('')
  console.log('Step failed: npm run typecheck')
  if (args.includes('--pause-on-failure') || args.includes('-p')) {
    console.log('Paused. Fix the issue, then retry:')
    console.log('  npx run-local-ci retry --name fixture-runner')
  }
  process.exit(1)
}

console.log(`stub local-ci — command: ${cmd}`)
process.exit(0)
