import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadVarFiles, parseVarFileContent } from "./workflow-vars.ts";

describe("parseVarFileContent", () => {
  it("parses a JSON object of workflow vars", () => {
    expect(
      parseVarFileContent(
        JSON.stringify({ API_URL: "https://api.example.com", DEPLOY_ENV: "staging" }),
        "vars.json",
      ),
    ).toEqual({ API_URL: "https://api.example.com", DEPLOY_ENV: "staging" });
  });

  it("parses GitHub CLI variable list JSON", () => {
    expect(
      parseVarFileContent(
        JSON.stringify([
          { name: "API_URL", value: "https://api.example.com" },
          { name: "DEPLOY_ENV", value: "staging" },
        ]),
        "stdin",
      ),
    ).toEqual({ API_URL: "https://api.example.com", DEPLOY_ENV: "staging" });
  });

  it("coerces primitive values to strings", () => {
    expect(parseVarFileContent(JSON.stringify({ NUMBER: 123, BOOL: true, EMPTY: null }))).toEqual({
      NUMBER: "123",
      BOOL: "true",
      EMPTY: "",
    });
  });

  it("throws a helpful error for invalid JSON", () => {
    expect(() => parseVarFileContent("not json", "vars.json")).toThrow(
      /Failed to parse vars\.json as JSON/,
    );
  });

  it("throws a helpful error for unsupported shapes", () => {
    expect(() => parseVarFileContent(JSON.stringify(["API_URL"]), "vars.json")).toThrow(
      /entry 1 must be an object/,
    );
  });
});

describe("loadVarFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-vars-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads and merges var files in order", () => {
    const first = path.join(tmpDir, "first.json");
    const second = path.join(tmpDir, "second.json");
    fs.writeFileSync(first, JSON.stringify({ API_URL: "https://api.example.com", SHARED: "one" }));
    fs.writeFileSync(second, JSON.stringify({ DEPLOY_ENV: "staging", SHARED: "two" }));

    expect(loadVarFiles([first, second])).toEqual({
      API_URL: "https://api.example.com",
      DEPLOY_ENV: "staging",
      SHARED: "two",
    });
  });

  it("wraps file read errors with the flag name", () => {
    expect(() => loadVarFiles([path.join(tmpDir, "missing.json")])).toThrow(/--var-file/);
  });
});
