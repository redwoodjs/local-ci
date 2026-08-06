import polka from "polka";
import bodyParser from "body-parser";
import { exec } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { state } from "./store.ts";
import { setupDtuLogging, getDtuLogPath } from "./logger.ts";

// Routes
import { registerDtuRoutes } from "./routes/dtu.ts";
import { registerGithubRoutes } from "./routes/github.ts";
import { registerActionRoutes } from "./routes/actions/index.ts";
import { registerCacheRoutes } from "./routes/cache.ts";
import { registerArtifactRoutes } from "./routes/artifacts.ts";

async function terminateOldProcess() {
  // Kill existing process on DTU port
  try {
    await new Promise<void>((resolve) => {
      exec(`lsof -t -i:${config.DTU_PORT} | xargs kill -9`, () => resolve());
    });
  } catch {
    // Ignore error if no process found
  }
}

function getControlToken(req: any): string | undefined {
  const headerToken =
    req.headers?.["x-local-ci-dtu-token"] ?? req.headers?.["x-agent-ci-dtu-token"];
  if (typeof headerToken === "string" && headerToken) {
    return headerToken;
  }

  const authorization = req.headers?.authorization;
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function controlTokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(actualBytes, expectedBytes)
  );
}

function isControlPath(url: string | undefined): boolean {
  // Polka treats a trailing slash as equivalent for these routes, so apply the
  // same canonicalization before deciding whether the request needs a token.
  const path = (url || "").split("?", 1)[0].replace(/\/+$/, "") || "/";
  return path === "/_dtu/seed" || path === "/_dtu/start-runner" || path === "/_dtu/dump";
}

export async function bootstrapAndReturnApp(options?: {
  reset?: boolean;
  controlToken?: string;
  allowedLogRoot?: string;
}) {
  const shouldReset = options?.reset ?? true;
  setupDtuLogging();
  if (shouldReset) {
    state.reset();
    await terminateOldProcess();
  }

  const app = polka();

  // Polka's listen() does: server.on('request', this.handler). So wrapping app.handler
  // is the correct place to normalize double-slashes BEFORE polka parses req.url into req.path.
  // ACTIONS_CACHE_URL ends with '/' and routes start with '/' — producing '//_apis/...' paths.
  const originalHandler = app.handler.bind(app);
  (app as any).handler = (req: any, res: any, info?: any) => {
    if (req.url?.includes("//")) {
      req.url = req.url.replace(/\/{2,}/g, "/");
    }
    originalHandler(req, res, info);
  };

  const controlToken =
    options?.controlToken ||
    process.env.LOCAL_CI_DTU_CONTROL_TOKEN ||
    crypto.randomBytes(32).toString("base64url");
  app.use((req: any, res: any, next: any) => {
    if (!isControlPath(req.url)) {
      next();
      return;
    }
    if (controlTokenMatches(getControlToken(req), controlToken)) {
      next();
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Unauthorized" }));
  });

  // Request timing middleware
  app.use((req: any, res: any, next: any) => {
    const start = Date.now();
    const origEnd = res.end.bind(res);
    res.end = (...args: any[]) => {
      const ms = Date.now() - start;
      const url = req.url || "";
      if (!url.includes("/logs/") && !url.includes("/feed") && !url.includes("/lines")) {
        console.log(`[DTU] ${req.method} ${url} (${ms}ms)`);
      }
      return origEnd(...args);
    };
    next();
  });

  app.use(bodyParser.json({ limit: "50mb" }));
  // Raw parsers for logs and cache uploads
  app.use(bodyParser.text({ type: ["text/plain"], limit: "50mb" }));
  app.use(
    bodyParser.raw({
      type: ["application/octet-stream", "application/zip", "application/xml", "text/xml"],
      limit: "500mb",
    }),
  );

  // Routes
  registerDtuRoutes(app, { allowedLogRoot: options?.allowedLogRoot });
  registerGithubRoutes(app);
  registerCacheRoutes(app);
  registerArtifactRoutes(app);
  registerActionRoutes(app);

  app.post("/_apis/distributedtask/hubs/:hub/plans/:planId/logs/:logId", (req: any, res) => {
    let text = "";
    if (typeof req.body === "string") {
      text = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      text = req.body.toString("utf-8");
    }
    if (text) {
      const planId = req.params.planId;
      const logDir = state.planToLogDir.get(planId);
      if (logDir) {
        let content = "";
        for (const rawLine of text.split("\n")) {
          const line = rawLine.trimEnd();
          if (!line) {
            content += "\n";
            continue;
          }
          const stripped = line
            .replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "")
            .replace(/^\uFEFF/, "");
          if (!stripped || stripped.startsWith("##[") || stripped.startsWith("[command]")) {
            continue;
          }
          content += stripped + "\n";
        }
        if (content) {
          try {
            const stepName =
              state.recordToStepName.get(String(req.params.logId)) || req.params.logId;
            const stepsDir = path.join(logDir, "steps");
            fs.mkdirSync(stepsDir, { recursive: true });
            fs.appendFileSync(path.join(stepsDir, `${stepName}.log`), content);
          } catch {
            /* best-effort */
          }
        }
      }
    }
    const lineCount = text ? text.split("\n").filter((l: string) => l.trim()).length : 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: parseInt(req.params.logId),
        path: `logs/${req.params.logId}`,
        lineCount,
        createdOn: new Date().toISOString(),
      }),
    );
  });

  app.put("/_apis/distributedtask/hubs/:hub/plans/:planId/logs/:logId", (req: any, res) => {
    let text = "";
    if (typeof req.body === "string") {
      text = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      text = req.body.toString("utf-8");
    }
    if (text) {
      const planId = req.params.planId;
      const logDir = state.planToLogDir.get(planId);
      if (logDir) {
        let content = "";
        for (const rawLine of text.split("\n")) {
          const line = rawLine.trimEnd();
          if (!line) {
            content += "\n";
            continue;
          }
          const stripped = line
            .replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "")
            .replace(/^\uFEFF/, "");
          if (!stripped || stripped.startsWith("##[") || stripped.startsWith("[command]")) {
            continue;
          }
          content += stripped + "\n";
        }
        if (content) {
          try {
            const stepName =
              state.recordToStepName.get(String(req.params.logId)) || req.params.logId;
            const stepsDir = path.join(logDir, "steps");
            fs.mkdirSync(stepsDir, { recursive: true });
            fs.appendFileSync(path.join(stepsDir, `${stepName}.log`), content);
          } catch {
            /* best-effort */
          }
        }
      }
    }
    const lineCount = text ? text.split("\n").filter((l: string) => l.trim()).length : 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: parseInt(req.params.logId),
        path: `logs/${req.params.logId}`,
        lineCount,
        createdOn: new Date().toISOString(),
      }),
    );
  });

  // Global OPTIONS (CORS & Discovery)
  app.options("/*", (req, res) => {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH, PUT, DELETE",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-TFS-FedAuthRedirect, X-VSS-E2EID, X-TFS-Session",
      "Content-Type": "application/json",
    });

    const responseValue = [
      {
        id: "A8C47E17-4D56-4A56-92BB-DE7EA7DC65BE",
        area: "distributedtask",
        resourceName: "pools",
        routeTemplate: "_apis/distributedtask/pools/{poolId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "E298EF32-5878-4CAB-993C-043836571F42",
        area: "distributedtask",
        resourceName: "agents",
        routeTemplate: "_apis/distributedtask/pools/{poolId}/agents/{agentId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "C3A054F6-7A8A-49C0-944E-3A8E5D7ADFD7",
        area: "distributedtask",
        resourceName: "messages",
        routeTemplate: "_apis/distributedtask/pools/{poolId}/messages",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "134E239E-2DF3-4794-A6F6-24F1F19EC8DC",
        area: "distributedtask",
        resourceName: "sessions",
        routeTemplate: "_apis/distributedtask/pools/{poolId}/sessions/{sessionId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
      },
      {
        id: "83597576-CC2C-453C-BEA6-2882AE6A1653",
        area: "distributedtask",
        resourceName: "timelines",
        routeTemplate: "_apis/distributedtask/timelines/{timelineId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "27d7f831-88c1-4719-8ca1-6a061dad90eb",
        area: "distributedtask",
        resourceName: "actiondownloadinfo",
        routeTemplate: "_apis/distributedtask/hubs/{hubName}/plans/{planId}/actiondownloadinfo",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "6.0",
        releasedVersion: "6.0",
      },
      {
        id: "858983e4-19bd-4c5e-864c-507b59b58b12",
        area: "distributedtask",
        resourceName: "feed",
        routeTemplate:
          "_apis/distributedtask/hubs/{hubName}/plans/{planId}/timelines/{timelineId}/records/{recordId}/feed",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "46f5667d-263a-4684-91b1-dff7fdcf64e2",
        area: "distributedtask",
        resourceName: "logs",
        routeTemplate: "_apis/distributedtask/hubs/{hubName}/plans/{planId}/logs/{logId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "8893BC5B-35B2-4BE7-83CB-99E683551DB4",
        area: "distributedtask",
        resourceName: "records",
        routeTemplate: "_apis/distributedtask/timelines/{timelineId}/records/{recordId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "FC825784-C92A-4299-9221-998A02D1B54F",
        area: "distributedtask",
        resourceName: "jobrequests",
        routeTemplate: "_apis/distributedtask/jobrequests/{jobId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "0A1EFD25-ABDA-43BD-9629-6C7BDD2E0D60",
        area: "distributedtask",
        resourceName: "jobinstances",
        routeTemplate: "_apis/distributedtask/jobinstances/{jobId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
    ];

    res.end(JSON.stringify({ count: responseValue.length, value: responseValue }));
  });

  // Health and root APIs discovery
  app.get("/_apis", (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ value: [] }));
  });

  app.get("/", (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "online", seededJobs: state.jobs.size }));
  });

  app.head("/", (req, res) => {
    res.writeHead(200);
    res.end();
  });

  // Catch-all 404 with payload dumping
  app.all("/*", (req: any, res) => {
    console.log(`[DTU] 404 Not Found: ${req.method} ${req.url} (Details in 404.log)`);

    let logContent = `\\n--- [${new Date().toISOString()}] 404 Not Found: ${req.method} ${req.url} ---\\n`;
    logContent += `Headers: ${JSON.stringify(req.headers, null, 2)}\\n`;

    if (req.body && Object.keys(req.body).length > 0) {
      logContent += `Body (parsed JSON): ${JSON.stringify(req.body, null, 2)}\\n`;
    } else if (typeof req.body === "string" && req.body.length > 0) {
      logContent += `Body (raw text): ${req.body.substring(0, 500)}${req.body.length > 500 ? "..." : ""}\\n`;
    }

    try {
      const logDir = path.dirname(getDtuLogPath());
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      fs.appendFileSync(path.join(logDir, "404.log"), logContent);
    } catch {
      /* best-effort */
    }

    res.writeHead(404);
    res.end("Not Found (DTU Mock)");
  });

  return app;
}
