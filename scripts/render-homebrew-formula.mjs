#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [versionArg, checksumsDirArg, outFileArg] = process.argv.slice(2);

if (!versionArg || !checksumsDirArg) {
  console.error(
    "Usage: node scripts/render-homebrew-formula.mjs <version> <checksums-dir> [out-file]",
  );
  process.exit(1);
}

const version = versionArg.replace(/^v/, "");
const tag = `v${version}`;
const checksumsDir = path.resolve(checksumsDirArg);
const templatePath = path.join(root, "packaging/homebrew/Formula/local-ci.rb.template");

function readSha(platform) {
  const file = path.join(checksumsDir, `local-ci-${tag}-${platform}.tar.gz.sha256`);
  const content = fs.readFileSync(file, "utf8").trim();
  const [sha] = content.split(/\s+/);
  if (!/^[a-f0-9]{64}$/i.test(sha)) {
    throw new Error(`Invalid sha256 in ${file}`);
  }
  return sha.toLowerCase();
}

const rendered = fs
  .readFileSync(templatePath, "utf8")
  .replaceAll("{{VERSION}}", version)
  .replaceAll("{{MACOS_ARM64_SHA256}}", readSha("macos-arm64"))
  .replaceAll("{{MACOS_X64_SHA256}}", readSha("macos-x64"));

if (outFileArg) {
  const outFile = path.resolve(outFileArg);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, rendered);
} else {
  process.stdout.write(rendered);
}
