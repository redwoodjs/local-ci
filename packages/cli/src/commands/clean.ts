import { pruneLogs } from "../log-prune.ts";

export default function clean(): never {
  const result = pruneLogs({ force: true });
  if (result.skipped) {
    console.log(`[Local CI] Nothing to clean (${result.reason ?? "unknown"}).`);
  } else {
    console.log(`[Local CI] Removed ${result.removed.length} old run dir(s); kept ${result.kept}.`);
    for (const name of result.removed) {
      console.log(`  - ${name}`);
    }
  }
  process.exit(0);
}
