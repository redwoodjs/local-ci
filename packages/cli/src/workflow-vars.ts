import fs from "node:fs";

function formatJsonError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueToString(label: string, key: string, value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "";
  }
  throw new Error(
    `[Local CI] Error: ${label} value for variable "${key}" must be a string, number, boolean, or null.`,
  );
}

/**
 * Parse workflow vars from a JSON file/stdin payload.
 *
 * Supported shapes:
 *   - { "NAME": "value" }
 *   - [{ "name": "NAME", "value": "value" }]  (GitHub CLI output)
 */
export function parseVarFileContent(content: string, label = "--var-file"): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`[Local CI] Error: Failed to parse ${label} as JSON: ${formatJsonError(err)}`);
  }

  const vars: Record<string, string> = {};

  if (Array.isArray(parsed)) {
    for (const [idx, item] of parsed.entries()) {
      if (!isRecord(item)) {
        throw new Error(
          `[Local CI] Error: ${label} entry ${idx + 1} must be an object with name and value fields.`,
        );
      }
      const name = item.name;
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error(
          `[Local CI] Error: ${label} entry ${idx + 1} must include a non-empty string name.`,
        );
      }
      if (!("value" in item)) {
        throw new Error(`[Local CI] Error: ${label} entry ${idx + 1} must include a value field.`);
      }
      vars[name] = valueToString(label, name, item.value);
    }
    return vars;
  }

  if (isRecord(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (key.trim() === "") {
        throw new Error(`[Local CI] Error: ${label} contains an empty variable name.`);
      }
      vars[key] = valueToString(label, key, value);
    }
    return vars;
  }

  throw new Error(
    `[Local CI] Error: ${label} must be a JSON object or an array of {"name","value"} objects.`,
  );
}

export function loadVarFiles(varFiles: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  let readStdin = false;

  for (const file of varFiles) {
    let content: string;
    const label = file === "-" ? "stdin" : file;

    try {
      if (file === "-") {
        if (readStdin) {
          throw new Error("stdin can only be used once");
        }
        readStdin = true;
        content = fs.readFileSync(0, "utf-8");
      } else {
        content = fs.readFileSync(file, "utf-8");
      }
    } catch (err) {
      throw new Error(
        `[Local CI] Error: Failed to read --var-file ${label}: ${formatJsonError(err)}`,
      );
    }

    Object.assign(vars, parseVarFileContent(content, label));
  }

  return vars;
}
