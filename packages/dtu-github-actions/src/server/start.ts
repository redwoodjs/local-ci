import { config } from "../config.ts";
import { bootstrapAndReturnApp } from "./index.ts";
import { getDtuLogPath, setWorkingDirectory, DTU_ROOT } from "./logger.ts";
import crypto from "node:crypto";
import path from "node:path";

let workingDir = process.env.LOCAL_CI_WORKING_DIR;
if (workingDir) {
  if (!path.isAbsolute(workingDir)) {
    workingDir = path.resolve(DTU_ROOT, workingDir);
  }
  setWorkingDirectory(workingDir);
}

const configuredControlToken = process.env.LOCAL_CI_DTU_CONTROL_TOKEN;
const controlToken = configuredControlToken || crypto.randomBytes(32).toString("base64url");

bootstrapAndReturnApp({ controlToken })
  .then((app) => {
    app.listen(config.DTU_PORT, "0.0.0.0", () => {
      console.log(
        `[DTU] OA-RUN-1 Mock GitHub API server running at http://0.0.0.0:${config.DTU_PORT}`,
      );
      console.log(`[DTU] Logging to ${getDtuLogPath()}`);
      if (!configuredControlToken) {
        console.log(
          "[DTU] Generated an in-process control token for /_dtu/* endpoints. Set LOCAL_CI_DTU_CONTROL_TOKEN before starting the server to let external clients call them.",
        );
      }
    });
  })
  .catch((err: any) => {
    console.error("[DTU] Failed to start:", err);
    process.exit(1);
  });
