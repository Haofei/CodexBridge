import os from "node:os";
import path from "node:path";

export function readBooleanEnv(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

export function normalizeSandboxMode(value) {
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  const allowed = ["read-only", "workspace-write", "danger-full-access"];
  return allowed.includes(normalized) ? normalized : null;
}

export function normalizeApprovalPolicy(value) {
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  const allowed = ["never", "on-request", "on-failure", "untrusted"];
  return allowed.includes(normalized) ? normalized : null;
}

export function resolveWorkingDirectory(value, rootDir) {
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  return path.resolve(rootDir, value);
}

export function createConfig({ env = process.env, rootDir }) {
  const defaultCodexDir =
    env.CODEX_STATE_DIR ?? path.join(os.homedir(), ".codex");
  const codexStateDir =
    env.CODEX_STATE_DIR ?? env.CODEX_DIR ?? defaultCodexDir;

  return {
    rootDir,
    defaultModel: env.CODEX_MODEL ?? "gpt-5.5",
    defaultReasoning:
      env.CODEX_REASONING ?? env.CODEX_MODEL_REASONING ?? "medium",
    port: Number(env.PORT ?? 8080),
    stateFile: path.join(rootDir, ".codex_threads.json"),
    publicDir: path.join(rootDir, "public"),
    dashboardHtml: path.join(rootDir, "public", "dashboard.html"),
    shouldSkipGit: env.CODEX_SKIP_GIT_CHECK === "false" ? false : true,
    apiKey: env.CODEX_BRIDGE_API_KEY ?? "123321",
    sandboxMode: normalizeSandboxMode(
      env.CODEX_SANDBOX_MODE ?? "read-only",
    ),
    workingDirectory: resolveWorkingDirectory(env.CODEX_WORKDIR, rootDir),
    networkAccess: readBooleanEnv(env.CODEX_NETWORK_ACCESS, false),
    webSearch: readBooleanEnv(env.CODEX_WEB_SEARCH, false),
    approvalPolicy: normalizeApprovalPolicy(
      env.CODEX_APPROVAL_POLICY ?? "never",
    ),
    logRequests: readBooleanEnv(env.CODEX_LOG_REQUESTS, false),
    requireSessionId: readBooleanEnv(env.CODEX_REQUIRE_SESSION_ID, false),
    jsonLimit: env.CODEX_JSON_LIMIT ?? "10mb",
    codexStateDir,
    codexAuthFile:
      env.CODEX_AUTH_FILE ?? path.join(codexStateDir, "auth.json"),
    appVersion: env.npm_package_version ?? "dev",
    codexPathOverride: env.CODEX_PATH ?? env.CODEX_PATH_OVERRIDE ?? null,
  };
}
