#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const mappings = {
  "linux-x64": "local-ci-linux-x64",
  "linux-arm64": "local-ci-linux-arm64",
  "macos-x64": "local-ci-darwin-x64",
  "macos-arm64": "local-ci-darwin-arm64",
};

let staged = 0;
for (const [target, packageDir] of Object.entries(mappings)) {
  const source = path.join(distDir, target, "local-ci");
  if (!fs.existsSync(source)) {
    continue;
  }
  const dest = path.join(root, "packages", packageDir, "bin", "local-ci");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, 0o755);
  staged += 1;
  console.log(`staged ${target} -> ${path.relative(root, dest)}`);
}

if (staged === 0) {
  throw new Error(
    `No native binaries found under ${path.relative(root, distDir)}/<target>/local-ci`,
  );
}
