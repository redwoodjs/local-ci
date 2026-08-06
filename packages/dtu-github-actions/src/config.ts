import { z } from "zod";

import path from "node:path";
import os from "node:os";

const configSchema = z.object({
  /**
   * The secret used to sign GitHub webhooks.
   * Hardcoded for local-only mock usage.
   */
  GITHUB_WEBHOOK_SECRET: z.string().min(1).default("local-ci-local"),

  /**
   * The internal URL where the DTU Mock Server is reachable.
   * Simulation scripts seed this server.
   */
  DTU_URL: z.string().url().default("http://localhost:8910"),

  /**
   * The port the DTU Mock Server listens on.
   */
  DTU_PORT: z.coerce.number().default(8910),

  /**
   * Directory where cache archives should be stored.
   */
  DTU_CACHE_DIR: z.string().default(() => path.join(os.tmpdir(), "dtu_cache")),
});

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse({
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  DTU_URL: process.env.DTU_URL,
  DTU_PORT: process.env.DTU_PORT,
  DTU_CACHE_DIR: process.env.DTU_CACHE_DIR,
});
