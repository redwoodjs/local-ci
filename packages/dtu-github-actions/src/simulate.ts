import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { config } from "./config.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const event = process.argv[2] || "workflow_job";

  // Events are in ../events relative to src/
  const payloadPath = path.join(__dirname, "..", "events", `${event}.json`);

  if (!fs.existsSync(payloadPath)) {
    const availableEvents = fs
      .readdirSync(path.join(__dirname, "..", "events"))
      .map((f) => f.replace(".json", ""));
    console.error(`Payload not found: ${payloadPath}`);
    console.error(`Available events: ${availableEvents.join(", ")}`);
    process.exit(1);
  }

  const rawPayload = fs.readFileSync(payloadPath, "utf-8");
  const payload = JSON.parse(rawPayload);
  const deliveryId = crypto.randomUUID();

  // 1. Seeding Logic for DTU
  if (event === "workflow_job" && payload.workflow_job) {
    console.log(`[DTU] Seeding mock server at ${config.DTU_URL}...`);
    try {
      const seedHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (process.env.LOCAL_CI_DTU_CONTROL_TOKEN) {
        seedHeaders["X-Agent-CI-DTU-Token"] = process.env.LOCAL_CI_DTU_CONTROL_TOKEN;
      }
      const seedResponse = await fetch(`${config.DTU_URL}/_dtu/seed`, {
        method: "POST",
        headers: seedHeaders,
        body: JSON.stringify(payload.workflow_job),
      });
      if (!seedResponse.ok) {
        console.warn(
          `[DTU] Warning: Failed to seed mock server: ${seedResponse.status} ${seedResponse.statusText}`,
        );
      } else {
        console.log("[DTU] Mock server seeded successfully.");
      }
    } catch {
      console.warn(
        `[DTU] Warning: Could not connect to mock server at ${config.DTU_URL}. Is it running?`,
      );
    }
  }

  console.log(`[DTU] Simulating "${event}" event...`);
  console.log(`[DTU] Delivery ID: ${deliveryId}`);
  console.log(`[DTU] Simulation complete.`);
}

main();
