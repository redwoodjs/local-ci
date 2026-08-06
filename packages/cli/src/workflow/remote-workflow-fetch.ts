import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface RemoteWorkflowRef {
  owner: string;
  repo: string;
  path: string;
  ref: string;
  raw: string;
}

/**
 * Parse a remote reusable workflow ref string.
 * Format: owner/repo/path/to/file.yml@ref
 */
export function parseRemoteRef(uses: string): RemoteWorkflowRef | null {
  const atIdx = uses.lastIndexOf("@");
  if (atIdx < 0) {
    return null;
  }

  const pathPart = uses.slice(0, atIdx);
  const ref = uses.slice(atIdx + 1);
  if (!ref) {
    return null;
  }

  const segments = pathPart.split("/");
  if (segments.length < 3) {
    return null;
  }

  return {
    owner: segments[0],
    repo: segments[1],
    path: segments.slice(2).join("/"),
    ref,
    raw: uses,
  };
}

/** Returns true for 40-character hex SHA refs (immutable, safe to cache forever). */
export function isShaRef(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/** Build the local cache path for a remote workflow file. */
export function remoteCachePath(cacheDir: string, ref: RemoteWorkflowRef): string {
  const sanitizedRef = ref.ref.replace(/[^a-zA-Z0-9._-]/g, "-");
  return path.join(cacheDir, `${ref.owner}__${ref.repo}@${sanitizedRef}`, ref.path);
}

const AUTH_INSTRUCTIONS = [
  "  To authenticate, either:",
  "    - Install and log in with the GitHub CLI, then run:",
  "        gh auth login",
  "        local-ci run --github-token",
  "    - Or pass a token value directly:",
  "        local-ci run --github-token <token>",
  "    - Or export it:",
  "        export LOCAL_CI_GITHUB_TOKEN=<token>",
].join("\n");

const INSUFFICIENT_TOKEN_HINT =
  "  If a token is already provided, it may lack the 'repo' scope (classic PAT) or 'contents: read' permission (fine-grained PAT), or the organization may require SSO authorization for the token.";

/**
 * Build a human-readable hint for a failed remote-workflow fetch, based on the
 * HTTP status and whether a token was supplied. 404 is included because GitHub
 * returns 404 (not 401/403) for private repos when auth is missing or
 * insufficient, to avoid leaking repo existence.
 */
export function buildAuthHint(status: number, hasToken: boolean): string {
  if (status === 404) {
    const lines = [
      "",
      "  The repository or ref was not found. If this is a private repository, GitHub returns 404 when authentication is missing or insufficient.",
      "",
    ];
    lines.push(hasToken ? INSUFFICIENT_TOKEN_HINT : AUTH_INSTRUCTIONS);
    return lines.join("\n");
  }
  if (status === 401 || status === 403) {
    if (hasToken) {
      return `\n${INSUFFICIENT_TOKEN_HINT}`;
    }
    return `\n${AUTH_INSTRUCTIONS}`;
  }
  return "";
}

/**
 * Scan a workflow YAML and prefetch all remote reusable workflow refs.
 * Downloaded files are written to cacheDir.
 *
 * - SHA refs: cached forever (immutable)
 * - Tag/branch refs: always re-fetched (mutable)
 *
 * Authentication is opt-in via the `githubToken` parameter.
 * Public repos may work without auth (within rate limits).
 * On 401/403/404 responses, throws with instructions for how to authenticate —
 * 404 is included because GitHub returns it for private repos when auth is
 * missing or insufficient, to avoid leaking repo existence.
 */
export async function prefetchRemoteWorkflows(
  workflowPath: string,
  cacheDir: string,
  githubToken?: string,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();

  const raw = parseYaml(fs.readFileSync(workflowPath, "utf-8"));
  const jobs = raw?.jobs ?? {};

  const remoteRefs: RemoteWorkflowRef[] = [];
  for (const [, jobDef] of Object.entries<any>(jobs)) {
    const uses = jobDef?.uses;
    if (typeof uses === "string" && !uses.startsWith("./")) {
      const ref = parseRemoteRef(uses);
      if (ref) {
        remoteRefs.push(ref);
      }
    }
  }

  if (remoteRefs.length === 0) {
    return resolved;
  }

  const errors: string[] = [];

  await Promise.all(
    remoteRefs.map(async (ref) => {
      const dest = remoteCachePath(cacheDir, ref);

      // Cache hit for SHA refs (immutable — safe to skip)
      if (isShaRef(ref.ref) && fs.existsSync(dest)) {
        resolved.set(ref.raw, dest);
        return;
      }

      try {
        const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/${ref.path}?ref=${ref.ref}`;
        const headers: Record<string, string> = {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "local-ci/1.0",
        };
        if (githubToken) {
          headers["Authorization"] = `token ${githubToken}`;
        }

        const response = await fetch(url, { headers });
        if (!response.ok) {
          const hint = buildAuthHint(response.status, Boolean(githubToken));
          errors.push(
            `Failed to fetch remote workflow ${ref.raw} (HTTP ${response.status}).${hint}`,
          );
          return;
        }

        const data = (await response.json()) as { content?: string; encoding?: string };
        if (!data.content || data.encoding !== "base64") {
          errors.push(`Unexpected response format for remote workflow ${ref.raw}`);
          return;
        }

        const content = Buffer.from(data.content, "base64").toString("utf-8");
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content, "utf-8");
        resolved.set(ref.raw, dest);
      } catch (err: any) {
        errors.push(`Error fetching remote workflow ${ref.raw}: ${err.message}`);
      }
    }),
  );

  if (errors.length > 0) {
    throw new Error(`[Local CI] Remote workflow fetch failed:\n  ${errors.join("\n  ")}`);
  }

  return resolved;
}
