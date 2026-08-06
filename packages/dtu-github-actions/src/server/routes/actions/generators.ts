import crypto from "node:crypto";

/** Build a minimal JWT whose `scp` claim satisfies @actions/artifact v2. */
function createMockJwt(planId: string, jobId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      orchid: "123",
      scp: `Actions.Results:${planId}:${jobId}`,
    }),
  ).toString("base64url");
  return `${header}.${payload}.mock-signature`;
}
import type {
  MessageResponse,
  JobStep,
  JobVariable,
  ContextData,
  PipelineAgentJobRequest,
} from "../../../types.ts";

// Helper to convert JS objects to ContextData
function toContextData(obj: any): any {
  if (typeof obj === "string") {
    return { t: 0, s: obj };
  }
  if (typeof obj === "boolean") {
    return { t: 3, b: obj };
  }
  if (typeof obj === "number") {
    return { t: 4, n: obj };
  }

  if (Array.isArray(obj)) {
    return {
      t: 1,
      a: obj.map(toContextData),
    };
  }

  if (typeof obj === "object" && obj !== null) {
    return {
      t: 2,
      d: Object.entries(obj).map(([k, v]) => ({ k, v: toContextData(v) })),
    };
  }

  // Handle null or undefined
  return { t: 0, s: "" };
}

// Build a TemplateToken MappingToken in the format ActionStep.Inputs expects.
// TemplateTokenJsonConverter uses "type" key (integer) NOT the contextData "t" key.
// TokenType.Mapping = 2. Items are serialized as {Key: scalarToken, Value: templateToken}.
// Strings without file/line/col are serialized as bare string values.
/**
 * Convert a string value to the appropriate TemplateToken.
 * If the value is a pure `${{ expr }}` expression, encode it as a
 * BasicExpressionToken (type 6) so the runner evaluates it at execution time.
 * Otherwise, return a bare string (StringToken).
 */
function toTemplateTokenValue(v: string): any {
  const exprMatch = v.match(/^\$\{\{\s*([\s\S]+?)\s*\}\}$/);
  if (exprMatch) {
    return { type: 3, expr: exprMatch[1] };
  }
  return v;
}

function toTemplateTokenMapping(obj: { [key: string]: string }): object {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return { type: 2 };
  }
  return {
    type: 2,
    map: entries.map(([k, v]) => ({ Key: k, Value: toTemplateTokenValue(v) })),
  };
}

export function createJobResponse(
  jobId: string,
  payload: any,
  baseUrl: string,
  planId: string,
): MessageResponse {
  const mappedSteps: JobStep[] = (payload.steps || []).map((step: any, index: number) => {
    const inputsObj: { [key: string]: string } =
      step.Inputs || (step.run ? { script: step.run } : {});

    const s: any = {
      id: step.Id || step.id || crypto.randomUUID(),
      name: step.Name || step.name || `step-${index}`,
      displayName: step.DisplayName || step.Name || step.name || `step-${index}`,
      contextName: step.ContextName || step.contextName || undefined,
      type: (step.Type || "Action").toLowerCase(),
      reference: (() => {
        const refTypeSource = step.Reference?.Type || "Script";
        const refTypeString = refTypeSource.toLowerCase();
        let typeInt = 3;
        if (refTypeString === "repository") {
          typeInt = 1;
        } else if (refTypeString === "container") {
          typeInt = 2;
        }

        const reference: any = { type: typeInt };
        if (typeInt === 1 && step.Reference) {
          reference.name = step.Reference.Name;
          reference.ref = step.Reference.Ref;
          reference.repositoryType = step.Reference.RepositoryType || "GitHub";
          reference.path = step.Reference.Path || "";
        }
        return reference;
      })(),
      // inputs is TemplateToken (MappingToken). Must use {"type": 2, "map": [...]} format.
      inputs: toTemplateTokenMapping(inputsObj),
      contextData: step.ContextData || toContextData({}),
      // condition must be explicit — null Condition causes NullReferenceException in EvaluateStepIf
      condition: step.condition || "success()",
    };

    // Attach step-level env as the step's own `environment` so it applies
    // only to this step. Without this, step envs aggregate into the global
    // `EnvironmentVariables` map (last-wins), leaking a later step's env
    // backwards into earlier steps. step.Env is the already-merged view
    // (workflow → job → step); applying it per-step makes each step see
    // the correct effective env regardless of siblings.
    if (step.Env && typeof step.Env === "object" && Object.keys(step.Env).length > 0) {
      s.environment = toTemplateTokenMapping(step.Env);
    }

    return s;
  });

  const repoFullName = payload.repository?.full_name || payload.githubRepo || "";
  const ownerName = payload.repository?.owner?.login || "redwoodjs";
  const repoName = payload.repository?.name || repoFullName.split("/")[1] || "";

  // Runner OS layout — defaults to Linux for the docker runner path. The macOS
  // VM runner path (packages/cli/src/runner/macos-vm) seeds `runnerOs: "macOS"`
  // so workspace + RUNNER_* env match what the macOS actions-runner expects.
  const runnerOs: "Linux" | "macOS" | "Windows" = payload.runnerOs || "Linux";
  const runnerArch: "X64" | "ARM64" =
    payload.runnerArch || (runnerOs === "macOS" ? "ARM64" : "X64");
  // The actions-runner creates `_work/` as a sibling of `run.sh`. The Linux
  // docker image installs the runner at /home/runner/, so _work is at a fixed
  // path. The macOS path rsyncs the runner into a caller-chosen directory and
  // passes it in via payload.runnerWorkDir so GITHUB_WORKSPACE matches where
  // the runner actually operates.
  const workspaceRoot =
    payload.runnerWorkDir ||
    (runnerOs === "macOS" ? "/Users/admin/local-ci-runner/_work" : "/home/runner/_work");
  const runnerTemp = runnerOs === "macOS" ? `${workspaceRoot}/_temp` : "/tmp/runner";
  const runnerToolCache =
    runnerOs === "macOS" ? "/Users/admin/hostedtoolcache" : "/opt/hostedtoolcache";
  const workspacePath = `${workspaceRoot}/${repoName}/${repoName}`;

  const realHeadSha = payload.realHeadSha;

  const Variables: { [key: string]: JobVariable } = {
    // Standard GitHub Actions environment variables — always set by real runners.
    // CI=true is required by many scripts that branch on CI vs local (e.g. default DB_HOST).
    CI: { Value: "true", IsSecret: false },
    GITHUB_CI: { Value: "true", IsSecret: false },
    GITHUB_ACTIONS: { Value: "true", IsSecret: false },
    // Runner metadata
    RUNNER_OS: { Value: runnerOs, IsSecret: false },
    RUNNER_ARCH: { Value: runnerArch, IsSecret: false },
    RUNNER_NAME: { Value: "oa-local-runner", IsSecret: false },
    RUNNER_TEMP: { Value: runnerTemp, IsSecret: false },
    RUNNER_TOOL_CACHE: { Value: runnerToolCache, IsSecret: false },
    // Workflow / run metadata
    GITHUB_RUN_ID: { Value: "1", IsSecret: false },
    GITHUB_RUN_NUMBER: { Value: "1", IsSecret: false },
    GITHUB_JOB: { Value: payload.name || "local-job", IsSecret: false },
    GITHUB_EVENT_NAME: { Value: "push", IsSecret: false },
    GITHUB_API_URL: { Value: baseUrl, IsSecret: false },
    GITHUB_SERVER_URL: { Value: "https://github.com", IsSecret: false },
    GITHUB_REF_NAME: { Value: "main", IsSecret: false },
    GITHUB_WORKFLOW: { Value: payload.workflowName || "local-workflow", IsSecret: false },
    GITHUB_WORKSPACE: { Value: workspacePath, IsSecret: false },
    // Repository / identity
    "system.github.token": { Value: "fake-token", IsSecret: true },
    "system.github.job": { Value: "local-job", IsSecret: false },
    "system.github.repository": { Value: repoFullName, IsSecret: false },
    "github.repository": { Value: repoFullName, IsSecret: false },
    "github.actor": { Value: ownerName, IsSecret: false },
    "github.sha": { Value: realHeadSha, IsSecret: false },
    "github.ref": { Value: "refs/heads/main", IsSecret: false },
    repository: { Value: repoFullName, IsSecret: false },
    GITHUB_REPOSITORY: { Value: repoFullName, IsSecret: false },
    GITHUB_ACTOR: { Value: ownerName, IsSecret: false },
    GITHUB_SHA: { Value: realHeadSha, IsSecret: false },
    "build.repository.name": { Value: repoFullName, IsSecret: false },
    "build.repository.uri": { Value: `https://github.com/${repoFullName}`, IsSecret: false },
  };

  // Merge job-level env: into Variables first, then step-level env: (step wins on conflict).
  // The runner exports every Variable as a process env var for all steps, so this is the
  // reliable mechanism to get LOCAL_CI_LOCAL, DB_HOST, DB_PORT etc. into the step subprocess
  // and into the runner's expression engine (${{ env.LOCAL_CI_LOCAL }}).
  if (payload.env && typeof payload.env === "object") {
    for (const [key, val] of Object.entries(payload.env)) {
      Variables[key] = { Value: String(val), IsSecret: false };
    }
  }
  for (const step of payload.steps || []) {
    if (step.Env && typeof step.Env === "object") {
      for (const [key, val] of Object.entries(step.Env)) {
        Variables[key] = { Value: String(val), IsSecret: false };
      }
    }
  }

  const githubContext: any = {
    repository: repoFullName,
    actor: ownerName,
    sha: realHeadSha,
    ref: "refs/heads/main",
    event_name: "push",
    server_url: "https://github.com",
    api_url: `${baseUrl}`,
    graphql_url: `${baseUrl}/_graphql`,
    workspace: workspacePath,
    action: "__run",
    token: "fake-token",
    job: "local-job",
  };

  if (payload.pull_request) {
    githubContext.event = {
      pull_request: payload.pull_request,
    };
  } else {
    githubContext.event = {
      repository: {
        full_name: repoFullName,
        name: repoName,
        owner: { login: ownerName },
        default_branch: payload.repository?.default_branch,
      },
      before: payload.baseSha || "0000000000000000000000000000000000000000",
      after: realHeadSha,
    };
  }

  // Collect env vars from job-level and all steps (seen by the runner's expression engine).
  // Job-level env is applied first, then step-level env wins on conflict.
  const mergedEnv: Record<string, string> = {};
  if (payload.env && typeof payload.env === "object") {
    Object.assign(mergedEnv, payload.env);
  }
  for (const step of payload.steps || []) {
    if (step.Env) {
      Object.assign(mergedEnv, step.Env);
    }
  }

  const ContextData: ContextData = {
    github: toContextData(githubContext),
    steps: { t: 2, d: [] }, // Empty steps context (required by EvaluateStepIf)
    needs: { t: 2, d: [] }, // Empty needs context
    strategy: { t: 2, d: [] }, // Empty strategy context
    matrix: { t: 2, d: [] }, // Empty matrix context
    // env context: merged from job-level + step-level env: blocks so the runner's expression
    // engine can substitute ${{ env.LOCAL_CI_LOCAL }}, ${{ env.DB_HOST }} etc.
    ...(Object.keys(mergedEnv).length > 0 ? { env: toContextData(mergedEnv) } : {}),
  };

  const generatedJobId = crypto.randomUUID();
  const mockToken = createMockJwt(planId, generatedJobId);

  const jobRequest: PipelineAgentJobRequest = {
    MessageType: "PipelineAgentJobRequest",
    Plan: {
      PlanId: planId,
      PlanType: "Action",
      ScopeId: crypto.randomUUID(),
    },
    Timeline: {
      Id: crypto.randomUUID(),
      ChangeId: 1,
    },
    JobId: generatedJobId,
    RequestId: parseInt(jobId) || 1,
    JobDisplayName: payload.name || "local-job",
    JobName: payload.name || "local-job",
    Steps: mappedSteps,
    Variables: Variables,
    ContextData: ContextData,
    Resources: {
      Repositories: [
        {
          Alias: "self",
          Id: "repo-1",
          Type: "git",
          Version: payload.headSha || "HEAD",
          Url: `https://github.com/${repoFullName}`,
          Properties: {
            id: "repo-1",
            name: repoName,
            fullName: repoFullName, // Required by types
            repoFullName: repoFullName, // camelCase
            owner: ownerName,
            defaultBranch: payload.repository?.default_branch || "main",
            cloneUrl: `https://github.com/${repoFullName}.git`,
          },
        },
      ],
      Endpoints: [
        {
          Name: "SystemVssConnection",
          Url: baseUrl,
          Authorization: {
            Parameters: {
              AccessToken: mockToken,
            },
            Scheme: "OAuth",
          },
        },
      ],
    },
    Workspace: {
      Path: workspacePath,
    },
    SystemVssConnection: {
      Url: baseUrl,
      Authorization: {
        Parameters: {
          AccessToken: mockToken,
        },
        Scheme: "OAuth",
      },
    },
    Actions: [],
    MaskHints: [],
    // EnvironmentVariables is IList<TemplateToken> in the runner — each element is a MappingToken.
    // The runner evaluates each MappingToken and merges into Global.EnvironmentVariables (last wins),
    // which then populates ExpressionValues["env"] → subprocess env vars.
    EnvironmentVariables:
      Object.keys(mergedEnv).length > 0 ? [toTemplateTokenMapping(mergedEnv)] : [],
  };

  return {
    MessageId: 1,
    MessageType: "PipelineAgentJobRequest",
    Body: JSON.stringify(jobRequest),
  };
}
