#!/usr/bin/env node
import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";
import { createAttachmentResolver } from "./src/chat/attachments.js";
import { createConfig } from "./src/config.js";
import { buildDashboardSnapshot } from "./src/dashboard/snapshot.js";
import { createApiKeyMiddleware } from "./src/http/auth.js";
import { createChatRouter } from "./src/http/chat-route.js";
import { listModels } from "./src/models.js";
import { createThreadStore } from "./src/store/thread-store.js";
import { fileExists } from "./src/utils/file.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const startedAt = Date.now();
const config = createConfig({ rootDir: __dirname });
const requestCounter = createRequestCounter();

const codex = new Codex(
  config.codexPathOverride
    ? { codexPathOverride: config.codexPathOverride }
    : {},
);
const threadStore = await createThreadStore({
  stateFile: config.stateFile,
  codex,
});
const attachmentResolver = createAttachmentResolver({
  workingDirectory: config.workingDirectory,
});

const app = express();
app.use(express.json({ limit: config.jsonLimit }));
app.use((req, _res, next) => {
  if (!req.path.startsWith("/public")) {
    requestCounter.increment();
  }
  next();
});

if (await fileExists(config.dashboardHtml)) {
  app.use("/public", express.static(config.publicDir));
  app.get("/dashboard", (_req, res) => {
    res.sendFile(config.dashboardHtml);
  });
  app.get("/api/dashboard", async (_req, res) => {
    try {
      const snapshot = await buildDashboardSnapshot({
        authFile: config.codexAuthFile,
        config,
        startedAt,
        requestCounter,
        threadStore,
      });
      res.json(snapshot);
    } catch (error) {
      console.error("Failed to build dashboard snapshot:", error);
      res.status(500).json({
        error: {
          message: "Failed to load Codex dashboard data.",
        },
      });
    }
  });
}

app.use(createApiKeyMiddleware(config.apiKey));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/v1/models", (_req, res) => {
  res.json(listModels(config.defaultModel, config.defaultReasoning));
});

app.use(
  createChatRouter({
    config,
    attachmentResolver,
    threadStore,
  }),
);

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: {
      message: err?.message ?? "Unexpected server error.",
      type: "internal_server_error",
    },
  });
});

await new Promise((resolve) => {
  app.listen(config.port, () => {
    console.log(
      `Codex OpenAI-compatible bridge listening on http://localhost:${config.port}`,
    );
    resolve();
  });
});

function createRequestCounter() {
  let count = 0;
  return {
    increment() {
      count += 1;
    },
    get() {
      return count;
    },
  };
}
