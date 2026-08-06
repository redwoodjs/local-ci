#!/usr/bin/env node
// Copy the public CLI docs into the website's static assets so they are
// reachable at https://local-ci.dev/docs/... and regenerate the Agent Skills
// discovery index with fresh sha256 digests.
//
// This script is idempotent and safe to run repeatedly. It is hooked into
// `predev` and `prebuild` so the website's `public/docs/` tree and
// `public/.well-known/agent-skills/index.json` never drift from the CLI.

import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const websiteDir = resolve(__dirname, "..");
const cliDir = resolve(websiteDir, "../../packages/cli");
const publicDir = resolve(websiteDir, "public");
const docsOut = resolve(publicDir, "docs");
const skillsOut = resolve(publicDir, ".well-known/agent-skills");

// Source files from the CLI that should be published as public docs.
// Keep `SKILL.md` in this list so the Agent Skills index can link to it.
const docs = [
  { src: "README.md", dest: "README.md" },
  { src: "compatibility.md", dest: "compatibility.md" },
  { src: "compatibility.json", dest: "compatibility.json" },
  { src: "runner-image.md", dest: "runner-image.md" },
  { src: "SKILL.md", dest: "SKILL.md" },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function copyDocs() {
  await rm(docsOut, { recursive: true, force: true });
  await mkdir(docsOut, { recursive: true });

  const copied = [];
  for (const { src, dest } of docs) {
    const bytes = await readFile(resolve(cliDir, src));
    await writeFile(resolve(docsOut, dest), bytes);
    copied.push({ dest, digest: sha256(bytes) });
    console.log(`  copied ${src} → public/docs/${dest}`);
  }
  return copied;
}

async function writeAgentSkillsIndex(copied) {
  await mkdir(skillsOut, { recursive: true });

  const skillDigest = copied.find((c) => c.dest === "SKILL.md")?.digest;
  if (!skillDigest) {
    throw new Error("SKILL.md was not copied; cannot build agent-skills index");
  }

  // Agent Skills Discovery RFC v0.2.0
  // https://github.com/cloudflare/agent-skills-discovery-rfc
  const index = {
    $schema:
      "https://raw.githubusercontent.com/cloudflare/agent-skills-discovery-rfc/main/schema/index.schema.json",
    version: "0.2.0",
    skills: [
      {
        name: "local-ci",
        type: "skill",
        description:
          "Run GitHub Actions workflows locally with pause-on-failure for AI-agent-driven CI iteration.",
        url: "https://local-ci.dev/docs/SKILL.md",
        sha256: skillDigest,
      },
    ],
  };

  const path = resolve(skillsOut, "index.json");
  await writeFile(path, JSON.stringify(index, null, 2) + "\n");
  console.log(`  wrote public/.well-known/agent-skills/index.json`);
}

const copied = await copyDocs();
await writeAgentSkillsIndex(copied);
console.log("docs synced.");
