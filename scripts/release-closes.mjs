#!/usr/bin/env node
// Capture issue-closing references from pending changesets into
// .release-closes.json, and rewrite keywords to "Refs #N" so the
// "chore: version packages" PR doesn't close them on merge. After
// publish, `apply` closes the captured issues with a comment that
// points at the PR that introduced the fix.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGESET_DIR = join(ROOT, ".changeset");
const CLOSES_FILE = join(ROOT, ".release-closes.json");
const KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
const REPO = process.env.GITHUB_REPOSITORY || "redwoodjs/local-ci";

function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function findPRForChangeset(relPath) {
  const sha = sh(`git log -1 --format=%H -- ${JSON.stringify(relPath)}`);
  if (!sha) {
    return null;
  }
  try {
    const out = sh(`gh api repos/${REPO}/commits/${sha}/pulls --jq '.[0].number'`);
    return out ? Number.parseInt(out, 10) : null;
  } catch {
    return null;
  }
}

function capture() {
  const entries = [];
  const files = readdirSync(CHANGESET_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
  for (const file of files) {
    const relPath = `.changeset/${file}`;
    const fullPath = join(CHANGESET_DIR, file);
    const text = readFileSync(fullPath, "utf8");
    const issues = [...text.matchAll(KEYWORD_RE)].map((m) => Number.parseInt(m[1], 10));
    if (issues.length === 0) {
      continue;
    }
    const pr = findPRForChangeset(relPath);
    for (const issue of issues) {
      entries.push({ issue, pr, changeset: file });
    }
    writeFileSync(
      fullPath,
      text.replace(KEYWORD_RE, (_, n) => `Refs #${n}`),
    );
  }
  writeFileSync(CLOSES_FILE, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Captured ${entries.length} close reference(s) -> .release-closes.json`);
}

function apply() {
  if (!existsSync(CLOSES_FILE)) {
    console.log("No .release-closes.json found; nothing to close.");
    return;
  }
  const entries = JSON.parse(readFileSync(CLOSES_FILE, "utf8"));
  if (entries.length === 0) {
    console.log(".release-closes.json is empty; nothing to close.");
    return;
  }
  for (const { issue, pr } of entries) {
    const msg = pr ? `Closes Issue #${issue} via PR #${pr}.` : `Closes Issue #${issue}.`;
    try {
      sh(`gh issue close ${issue} --repo ${REPO} --comment ${JSON.stringify(msg)}`);
      console.log(`Closed #${issue}${pr ? ` (PR #${pr})` : ""}`);
    } catch (err) {
      console.log(`Could not close #${issue}: ${err.message?.split("\n")[0] ?? err}`);
    }
  }
}

const cmd = process.argv[2];
if (cmd === "capture") {
  capture();
} else if (cmd === "apply") {
  apply();
} else {
  console.error("Usage: release-closes.mjs <capture|apply>");
  process.exit(1);
}
