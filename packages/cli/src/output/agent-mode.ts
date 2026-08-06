let quietFlag = false;
let jsonFlag = false;

export function setQuietMode(value: boolean): void {
  quietFlag = value;
}

export function isAgentMode(): boolean {
  return quietFlag || process.env.AI_AGENT === "1";
}

export function setJsonMode(value: boolean): void {
  jsonFlag = value;
}

/**
 * Whether to emit the NDJSON event stream (#289) on stdout. Decoupled from
 * `--quiet` so callers can combine the pretty renderer with a structured
 * side-channel, and so existing `-q` users don't suddenly see JSON on stdout.
 */
export function isJsonMode(): boolean {
  return jsonFlag || process.env.LOCAL_CI_JSON === "1";
}
