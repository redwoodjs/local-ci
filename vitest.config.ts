import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["_/**", ".local-ci/**", "**/node_modules/**", "**/dist/**"],
  },
});
