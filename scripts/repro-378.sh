#!/usr/bin/env bash
# Regression for issue #378: parallel npm jobs must not mutate the same
# node_modules. A package lifecycle script records each node_modules mount
# identity and fails deterministically if two installs share one writable tree.
#
# The script:
#   1. Seeds the package-manager cache with explicit prewarming and --jobs 1.
#   2. Creates a legacy partial warm cache containing .package-lock.json.
#   3. Runs two independent npm ci jobs with --jobs 2.
#
# The fixed behavior ignores the legacy cache, gives each job private
# node_modules, and lets both jobs pass. Set EXPECT_BUG=1 when running against
# a vulnerable checkout to assert the old shared-mount failure instead.
#
# Requires Docker and Node.js/npm. Run from anywhere:
#
#   ./scripts/repro-378.sh
#
# If Docker does not expose /var/run/docker.sock, pass the active context:
#
#   LOCAL_CI_DOCKER_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}')" \
#     ./scripts/repro-378.sh
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_CI="$REPO_ROOT/scripts/local-ci-dev.sh"

if [ -f /.dockerenv ]; then
  # Nested Docker runners cannot bind-mount the outer container's /tmp into
  # sibling containers. Keep the fixture under the bind-mounted source repo.
  TMP="$(mktemp -d "$REPO_ROOT/.repro-378.XXXXXX")"
else
  TMP="$(mktemp -d)"
fi
PROJECT="$TMP/project"
WORK_DIR="$TMP/local-ci-work"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$PROJECT/.github/workflows" "$PROJECT/slow-dependency"

cat > "$PROJECT/slow-dependency/package.json" <<'JSON'
{
  "name": "repro-378-slow-dependency",
  "version": "1.0.0",
  "scripts": {
    "postinstall": "node postinstall.cjs"
  },
  "files": [
    "postinstall.cjs"
  ]
}
JSON

cat > "$PROJECT/slow-dependency/postinstall.cjs" <<'JS'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const toolCache = process.env.RUNNER_TOOL_CACHE;
if (!toolCache) {
  console.error("REPRO_378_ERROR: RUNNER_TOOL_CACHE is unavailable");
  process.exit(40);
}

const nodeModules = path.resolve(process.cwd(), "..");
const projectRoot = path.resolve(nodeModules, "..");
const mode = fs.readFileSync(path.join(projectRoot, "repro-mode.txt"), "utf8").trim();
const nodeModulesStat = fs.statSync(nodeModules, { bigint: true });
const mountIdentity = `${nodeModulesStat.dev}-${nodeModulesStat.ino}`;
const activeDir = path.join(toolCache, `repro-378-install-active-${mountIdentity}`);
const overlapFile = path.join(activeDir, "overlap-observed");
const identitiesDir = path.join(toolCache, "repro-378-identities");
let ownsActiveDir = false;

function cleanup() {
  if (ownsActiveDir) {
    fs.rmSync(activeDir, { recursive: true, force: true });
    ownsActiveDir = false;
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

if (mode === "warmup") {
  console.log("REPRO_378_WARMUP: lifecycle completed serially");
  process.exit(0);
}

fs.mkdirSync(identitiesDir, { recursive: true });
// Separate containers often assign the same process ID to their lifecycle
// scripts. Use a random report name so one job cannot overwrite another's
// mount identity in the shared tool cache.
fs.writeFileSync(path.join(identitiesDir, crypto.randomUUID()), `${mountIdentity}\n`);

try {
  fs.mkdirSync(activeDir);
  ownsActiveDir = true;
  fs.writeFileSync(path.join(activeDir, "owner"), `${process.pid}\n`);
} catch (error) {
  if (error && error.code === "EEXIST") {
    fs.writeFileSync(overlapFile, `${process.pid}\n`);
    console.error(
      `REPRO_378_OVERLAP: two npm ci lifecycle scripts share node_modules ${mountIdentity}`,
    );
    process.exit(42);
  }
  throw error;
}

// Keep the first install active long enough for the second runner to reach its
// lifecycle script. With isolated node_modules, each job has a different
// mountIdentity and both scripts complete normally after this wait.
const deadline = Date.now() + 15_000;
while (!fs.existsSync(overlapFile) && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}

if (fs.existsSync(overlapFile)) {
  console.log("REPRO_378_OVERLAP_CONFIRMED: concurrent npm ci reached shared node_modules");
} else {
  console.log(`REPRO_378_NO_OVERLAP: no other npm ci used node_modules ${mountIdentity}`);
}
JS

(
  cd "$PROJECT/slow-dependency"
  npm pack --silent >/dev/null
)
mv "$PROJECT/slow-dependency/repro-378-slow-dependency-1.0.0.tgz" "$PROJECT/"
rm -rf "$PROJECT/slow-dependency"

cat > "$PROJECT/package.json" <<'JSON'
{
  "name": "repro-378",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "repro-378-slow-dependency": "file:repro-378-slow-dependency-1.0.0.tgz"
  }
}
JSON

cat > "$PROJECT/.github/workflows/repro.yml" <<'YAML'
name: Reproduce shared npm warm-cache race
on: push
jobs:
  install-a:
    runs-on: ubuntu-latest
    steps:
      - id: install
        run: npm ci --foreground-scripts --no-audit --no-fund
  install-b:
    runs-on: ubuntu-latest
    steps:
      - id: install
        run: npm ci --foreground-scripts --no-audit --no-fund
YAML

printf 'warmup\n' > "$PROJECT/repro-mode.txt"
(
  cd "$PROJECT"
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null
  git init -q
  git config user.email repro@378.invalid
  git config user.name repro-378
  git remote add origin https://github.com/repro/issue-378.git
  git add .
  git commit -q -m init
)

export GITHUB_REPO="repro/issue-378"
export LOCAL_CI_WORKING_DIR="$WORK_DIR"

run_local_ci() {
  local jobs="$1" output="$2"
  local prewarm_args=()
  if [ "${EXPECT_BUG:-0}" != "1" ]; then
    prewarm_args=(
      --prewarm-through
      "$PROJECT/.github/workflows/repro.yml:install-a:install"
    )
  fi
  # Start the dev wrapper from its own repo so Corepack selects Local CI's
  # pinned pnpm version. The absolute workflow path still selects the fixture
  # as the repository under test.
  (
    cd "$REPO_ROOT"
    "$LOCAL_CI" run \
      --quiet \
      --jobs "$jobs" \
      --workflow "$PROJECT/.github/workflows/repro.yml" \
      "${prewarm_args[@]}"
  ) 2>&1 | tee "$output"
  return "${PIPESTATUS[0]}"
}

echo "▶ Seeding a valid warm cache with serial jobs..."
set +e
run_local_ci 1 "$TMP/warmup.log"
WARMUP_STATUS=$?
set -e
if [ "$WARMUP_STATUS" -ne 0 ]; then
  echo "✗ SETUP FAILED: serial warm-up exited $WARMUP_STATUS"
  exit 1
fi

LOCK_HASH="$(shasum -a 256 "$PROJECT/package-lock.json" | awk '{ print substr($1, 1, 16) }')"
LEGACY_WARM_MODULES="$WORK_DIR/cache/warm-modules/repro-issue-378/$LOCK_HASH"
mkdir -p "$LEGACY_WARM_MODULES/incomplete-package"
printf '{}\n' > "$LEGACY_WARM_MODULES/.package-lock.json"
printf 'race\n' > "$PROJECT/repro-mode.txt"

echo
echo "▶ Legacy partial cache prepared:"
echo "  sentinel: $LEGACY_WARM_MODULES/.package-lock.json"
echo "  incomplete package: $LEGACY_WARM_MODULES/incomplete-package"
echo "▶ Running two independent npm ci jobs in parallel..."

set +e
run_local_ci 2 "$TMP/race.log"
RACE_STATUS=$?
set -e

echo
echo "▶ parallel run exit code: $RACE_STATUS"
if [ "${EXPECT_BUG:-0}" = "1" ]; then
  if grep -q "REPRO_378_OVERLAP" "$TMP/race.log"; then
    echo "✓ REPRODUCED: Local CI accepted the partial cache and shared node_modules."
    exit 0
  fi
  echo "✗ BUG NOT REPRODUCED"
  exit 1
fi

if [ "$RACE_STATUS" -ne 0 ]; then
  echo "✗ REGRESSION: a parallel job failed."
  tail -40 "$TMP/race.log"
  exit 1
fi
if grep -q "REPRO_378_OVERLAP" "$TMP/race.log"; then
  echo "✗ REGRESSION: concurrent npm installs shared node_modules."
  exit 1
fi

IDENTITY_COUNT="$(find "$WORK_DIR/cache/toolcache/repro-378-identities" -type f -exec cat {} + | sort -u | wc -l | tr -d ' ')"
if [ "$IDENTITY_COUNT" -ne 2 ]; then
  echo "✗ REGRESSION: expected two private node_modules identities, found $IDENTITY_COUNT."
  exit 1
fi

echo "✓ PASS: both npm ci jobs used private node_modules and ignored the partial legacy cache."
