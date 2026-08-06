#!/usr/bin/env node
// Stub local-ci for fixture lint-curly-x18.
// Counts single-line `if (...) expr` (missing braces) in src/*.js and emits
// eslint-style curly-rule output. Exit 0 when clean, 1 otherwise.
//
// Supports `run` and `retry` subcommands with the real CLI's flag shape so the
// eval harness can observe which flags the agent actually passed.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'run'

const cwd = process.cwd()
const srcDir = join(cwd, 'src')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

function findViolations(file) {
  const src = readFileSync(file, 'utf8')
  const lines = src.split('\n')
  const violations = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^\s*if\s*\([^)]*\)\s+[^\s{]/.exec(line)
    if (m) violations.push({ line: i + 1, col: m.index + 1, text: line.trim() })
  }
  return violations
}

const files = (() => {
  try {
    return walk(srcDir)
  } catch {
    return []
  }
})()

let total = 0
const perFile = []
for (const f of files) {
  const v = findViolations(f)
  if (v.length) perFile.push({ file: f, violations: v })
  total += v.length
}

if (cmd === 'run' || cmd === 'retry') {
  if (total === 0) {
    console.log('▶ lint / eslint')
    console.log('  ✓ no problems')
    console.log('')
    console.log('All jobs passed.')
    process.exit(0)
  }
  console.log('▶ lint / eslint')
  for (const { file, violations } of perFile) {
    for (const v of violations) {
      console.log(
        `  ${file}:${v.line}:${v.col}  error  Expected { after 'if' condition  curly`,
      )
    }
  }
  console.log('')
  console.log(`✗ ${total} problems (${total} errors)`)
  console.log('')
  console.log('Step failed: npm run lint')
  if (args.includes('--pause-on-failure') || args.includes('-p')) {
    console.log('Paused. Fix the issue, then retry:')
    console.log('  npx run-local-ci retry --name fixture-runner')
  }
  process.exit(1)
}

console.log(`stub local-ci — command: ${cmd}`)
process.exit(0)
