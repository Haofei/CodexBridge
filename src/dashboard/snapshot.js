import { readAccountMetadata } from "./account.js";

export async function buildDashboardSnapshot({
  authFile,
  config,
  startedAt,
  requestCounter,
  threadStore,
}) {
  const account = await readAccountMetadata(authFile);
  return {
    generatedAt: new Date().toISOString(),
    account,
    stats: {
      totalRequests: requestCounter.get(),
      activeSessions: threadStore.getPersistedSessionCount(),
      cachedThreads: threadStore.getCachedThreadCount(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      sandboxMode: config.sandboxMode ?? "default",
      approvalPolicy: config.approvalPolicy ?? "never",
      networkAccess: Boolean(config.networkAccess),
      webSearch: Boolean(config.webSearch),
      version: config.appVersion,
    },
    tokens: Array.isArray(account?.tokens) ? account.tokens : [],
  };
}
