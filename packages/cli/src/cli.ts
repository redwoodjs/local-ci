#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { applyLocalCiEnv } from "./config.ts";

function resolveRepoRoot() {
  let repoRoot = process.cwd();
  while (repoRoot !== "/" && !fs.existsSync(path.join(repoRoot, ".git"))) {
    repoRoot = path.dirname(repoRoot);
  }
  return repoRoot === "/" ? process.cwd() : repoRoot;
}

async function main() {
  // Bootstrap: `.env.local-ci` (LOCAL_CI_* keys only) → process.env, shell wins.
  applyLocalCiEnv(resolveRepoRoot());

  // DOCKER_HOST was removed in favor of LOCAL_CI_DOCKER_HOST so that the value
  // can live in .env.local-ci without colliding with the shell's expectation
  // that DOCKER_HOST points at the real Docker daemon.
  if (process.env.DOCKER_HOST) {
    console.error(
      "[Local CI] Error: DOCKER_HOST is no longer supported.\n" +
        "  Rename it to LOCAL_CI_DOCKER_HOST (shell env or .env.local-ci).",
    );
    process.exit(1);
  }
  if (process.env.LOCAL_CI_DOCKER_HOST) {
    // Forward to DOCKER_HOST so dockerode's default client picks it up.
    process.env.DOCKER_HOST = process.env.LOCAL_CI_DOCKER_HOST;
  }

  const args = process.argv.slice(2);
  const command = args[0];

  // Lazy-load command modules so light commands (--help, clean, retry, abort)
  // don't pay the cost of loading dockerode/grpc-js/protobufjs/ssh2 and the
  // full workflow parser. See issue #334.
  if (command === "run") {
    const { default: runCmd } = await import("./commands/run.ts");
    await runCmd(args);
  } else if (command === "retry" || command === "abort") {
    const { default: retryAbort } = await import("./commands/retry-abort.ts");
    await retryAbort(command, args);
  } else if (command === "clean") {
    const { default: clean } = await import("./commands/clean.ts");
    clean();
  } else {
    printUsage();
    process.exit(command === "--help" || command === "-h" ? 0 : 1);
  }
}

function printUsage() {
  console.log("Usage: local-ci <command> [args]");
  console.log("");
  console.log("Commands:");
  console.log("  run [sha] --workflow <path>   Run all jobs in a workflow file (defaults to HEAD)");
  console.log(
    "  run --all                     Run all relevant PR/Push workflows for current branch",
  );
  console.log("  retry --name <name>           Send retry signal to a paused runner");
  console.log("    --from-step <N>              Re-run from step N (skips earlier steps)");
  console.log("    --from-start                 Re-run all run: steps from the beginning");
  console.log("  abort --name <name>           Send abort signal to a paused runner");
  console.log("  clean                         Delete old per-run log directories");
  console.log("");
  console.log("Options:");
  console.log("  -w, --workflow <path>         Path to the workflow file");
  console.log("  -a, --all                     Discover and run all relevant workflows");
  console.log("  -p, --pause-on-failure         Pause on step failure for interactive debugging");
  console.log(
    "  -q, --quiet                   Suppress animated rendering (also enabled by AI_AGENT=1)",
  );
  console.log(
    "      --json                    Emit NDJSON event stream on stdout (also enabled by LOCAL_CI_JSON=1)",
  );
  console.log(
    "      --no-matrix               Collapse all matrix combinations into a single job (uses first value of each key)",
  );
  console.log("  -j, --jobs <N>                Maximum jobs to run at once");
  console.log("      --prewarm-through <workflow:job:step-id>");
  console.log(
    "                                Populate the private dependency cache before parallel jobs",
  );
  console.log("                                Or set: LOCAL_CI_PREWARM_THROUGH env var");
  console.log(
    "      --github-token [<token>]  GitHub token for fetching remote reusable workflows",
  );
  console.log(
    "                                (auto-resolves via `gh auth token` if no value given)",
  );
  console.log("                                Or set: LOCAL_CI_GITHUB_TOKEN env var");
  console.log(
    "      --commit-status           Post a GitHub commit status after the run (requires --github-token)",
  );
  console.log(
    "      --var KEY=VALUE           Provide a workflow variable (${{ vars.KEY }}); repeat for multiple",
  );
  console.log("      --var-file <path|->       Load workflow variables from JSON file or stdin");
  console.log("");
  console.log("Secrets:");
  console.log("  Workflow secrets (${{ secrets.FOO }}) are resolved from:");
  console.log("    1. .env.local-ci file in the repo root");
  console.log("    2. Environment variables (shell env acts as fallback)");
  console.log("    3. --github-token automatically provides secrets.GITHUB_TOKEN");
  console.log("");
  console.log("Vars:");
  console.log("  Workflow vars (${{ vars.FOO }}) can be provided via --var FOO=VALUE");
  console.log("  or --var-file <path|-> (JSON object or gh variable list JSON).");
  console.log("  The run fails if any referenced var is missing.");
}

main().catch((err) => {
  console.error("[Local CI] Fatal error:", err);
  process.exit(1);
});
