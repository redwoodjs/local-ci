#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runRequired(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function assertEqual(label, left, right) {
  if (left !== right) {
    throw new Error(`${label} differed\n--- TypeScript ---\n${left}\n--- Rust ---\n${right}`);
  }
}

runRequired("pnpm", ["--filter", "run-local-ci", "build"]);
runRequired("cargo", ["build", "-p", "local-ci"]);

const ts = ["node", "packages/cli/dist/native-launcher.js"];
const rust = [path.join("target", "debug", "local-ci")];
const cases = [
  { name: "help output", args: ["--help"] },
  { name: "no-args usage", args: [] },
  { name: "invalid --jobs", args: ["run", "--jobs", "0"] },
  { name: "invalid --var", args: ["run", "--var", "BAD"] },
  { name: "retry requires name", args: ["retry"] },
  { name: "abort requires name", args: ["abort"] },
];

for (const testCase of cases) {
  const tsResult = capture(ts[0], [...ts.slice(1), ...testCase.args], {
    LOCAL_CI_FORCE_TYPESCRIPT: "1",
  });
  const rustResult = capture(rust[0], testCase.args);
  assertEqual(`${testCase.name} exit status`, tsResult.status, rustResult.status);
  assertEqual(`${testCase.name} stdout`, tsResult.stdout, rustResult.stdout);
  assertEqual(`${testCase.name} stderr`, tsResult.stderr, rustResult.stderr);
  console.log(`✓ ${testCase.name}`);
}
