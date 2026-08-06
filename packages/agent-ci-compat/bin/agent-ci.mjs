#!/usr/bin/env node

console.warn(
  "[Local CI] @redwoodjs/agent-ci has been renamed to the run-local-ci package. " +
    "Install the new package and run `local-ci` instead.",
);

const { runNativeOrTypeScript } = await import("run-local-ci/native-launcher");
await runNativeOrTypeScript(process.argv.slice(2));
