import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createConfig,
  normalizeApprovalPolicy,
  normalizeSandboxMode,
  readBooleanEnv,
} from "../src/config.js";
import {
  resolveImagePath,
  inferExtensionFromMime,
} from "../src/chat/attachments.js";
import {
  buildConversationPrompt,
  buildSystemPrompt,
  extractLatestUserContent,
  mergePrompts,
  normalizeMessages,
} from "../src/chat/messages.js";
import { resolveOutputSchemaFromBody } from "../src/chat/schema.js";
import {
  buildToolAwareChoice,
  buildToolDecisionSchema,
  normalizeToolChoice,
  resolveToolContext,
} from "../src/chat/tools.js";
import {
  listModels,
  resolveModelAndReasoning,
} from "../src/models.js";

test("config normalizes boolean and enum environment values", () => {
  assert.equal(readBooleanEnv("yes", false), true);
  assert.equal(readBooleanEnv("off", true), false);
  assert.equal(readBooleanEnv("wat", true), true);
  assert.equal(normalizeSandboxMode("workspace-write"), "workspace-write");
  assert.equal(normalizeSandboxMode("invalid"), null);
  assert.equal(normalizeApprovalPolicy("on-request"), "on-request");
  assert.equal(normalizeApprovalPolicy("bad"), null);
});

test("createConfig resolves paths from the repository root", () => {
  const rootDir = "/tmp/codexbridge";
  const config = createConfig({
    rootDir,
    env: {
      CODEX_WORKDIR: "workspace",
      CODEX_STATE_DIR: "/tmp/codex-state",
      CODEX_SANDBOX_MODE: "read-only",
    },
  });

  assert.equal(config.workingDirectory, path.join(rootDir, "workspace"));
  assert.equal(config.stateFile, path.join(rootDir, ".codex_threads.json"));
  assert.equal(config.codexAuthFile, "/tmp/codex-state/auth.json");
  assert.equal(config.sandboxMode, "read-only");
});

test("models endpoint flattens model presets and resolves reasoning", () => {
  const models = listModels("gpt-5.5", "medium");
  assert.equal(models.object, "list");
  assert.ok(models.data.some((entry) => entry.id === "gpt-5.5:high"));

  assert.deepEqual(
    resolveModelAndReasoning({
      model: "gpt-5.5:high",
      defaultModel: "gpt-5.5",
      defaultReasoning: "medium",
    }),
    { resolvedModel: "gpt-5.5", resolvedReasoning: "high" },
  );
  assert.deepEqual(
    resolveModelAndReasoning({
      model: "unknown-model:xhigh",
      defaultModel: "gpt-5.5",
      defaultReasoning: "medium",
    }),
    { resolvedModel: "unknown-model", resolvedReasoning: "xhigh" },
  );
});

test("response_format schemas match OpenAI-compatible inputs", () => {
  assert.deepEqual(resolveOutputSchemaFromBody({ response_format: "json_object" }), {
    type: "object",
  });
  assert.deepEqual(
    resolveOutputSchemaFromBody({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: { type: "object", properties: {} },
        },
      },
    }),
    { type: "object", properties: {} },
  );
  assert.throws(
    () => resolveOutputSchemaFromBody({ response_format: "json_schema" }),
    /requires an accompanying schema/,
  );
});

test("tool context supports modern and legacy function calling", () => {
  const context = resolveToolContext({
    tools: [
      {
        type: "function",
        function: { name: "lookup", parameters: { type: "object" } },
      },
    ],
    tool_choice: { type: "function", function: { name: "lookup" } },
  });

  assert.equal(context.enabled, true);
  assert.equal(context.forcedName, "lookup");
  assert.deepEqual(normalizeToolChoice("none"), {
    mode: "none",
    forcedName: null,
  });
  assert.deepEqual(buildToolDecisionSchema(context).properties.type.enum, [
    "tool_calls",
  ]);
});

test("tool-aware choices format tool calls and final answers", () => {
  const context = resolveToolContext({
    tools: [
      {
        type: "function",
        function: { name: "lookup", parameters: { type: "object" } },
      },
    ],
  });
  const toolChoice = buildToolAwareChoice(
    {
      text: JSON.stringify({
        type: "tool_calls",
        content: "",
        tool_calls: [{ name: "lookup", arguments: "{\"q\":\"x\"}" }],
      }),
    },
    context,
    (turn) => turn.text,
  );

  assert.equal(toolChoice.finishReason, "tool_calls");
  assert.equal(toolChoice.message.tool_calls[0].function.name, "lookup");
  assert.equal(toolChoice.message.tool_calls[0].function.arguments, "{\"q\":\"x\"}");

  const finalChoice = buildToolAwareChoice(
    { text: '{"type":"final","content":"done","tool_calls":[]}' },
    context,
    (turn) => turn.text,
  );
  assert.equal(finalChoice.message.content, "done");
});

test("message normalization and prompt builders preserve role context", async () => {
  const normalized = await normalizeMessages(
    [
      { role: "system", content: "Be brief." },
      {
        role: "user",
        name: "alice",
        content: [
          { type: "text", text: "hello" },
          { type: "local_image", path: "img.png" },
        ],
      },
    ],
    {
      resolveImageBlock: async (block) =>
        block.type === "local_image" ? { path: `/tmp/${block.path}` } : null,
    },
  );

  assert.equal(buildSystemPrompt(normalized), "[SYSTEM]\nBe brief.");
  assert.equal(extractLatestUserContent(normalized), "hello");
  assert.equal(
    buildConversationPrompt(normalized),
    "[SYSTEM]\nBe brief.\n\n[USER name=alice]\nhello",
  );
  assert.equal(mergePrompts("system", "user"), "system\n\nuser");
  assert.equal(normalized[1].attachments[0].path, "/tmp/img.png");
});

test("attachment helpers resolve supported image references", () => {
  assert.equal(inferExtensionFromMime("image/webp"), ".webp");
  assert.equal(
    resolveImagePath("relative.png", { workingDirectory: "/tmp/work" }),
    "/tmp/work/relative.png",
  );
  assert.throws(
    () => resolveImagePath("ftp://example.com/a.png"),
    /Only file:\/\/ URLs/,
  );
});
