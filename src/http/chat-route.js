import crypto from "node:crypto";
import express from "express";
import {
  cleanupAttachmentFiles,
  collectAttachmentCleanups,
} from "../chat/attachments.js";
import {
  buildConversationInputs,
  buildConversationPrompt,
  buildSystemPrompt,
  extractLatestUserContent,
  extractLatestUserInputs,
  isToolProtocolMessage,
  mergePrompts,
  mergeStructuredPrompts,
  normalizeMessages,
} from "../chat/messages.js";
import {
  extractAssistantResponse,
  formatUsage,
} from "../chat/response.js";
import { resolveOutputSchemaFromBody } from "../chat/schema.js";
import {
  buildToolAwareChoice,
  buildToolDecisionSchema,
  prependToolInstructions,
  resolveToolContext,
} from "../chat/tools.js";
import { resolveModelAndReasoning } from "../models.js";
import {
  createChatStreamLogger,
  logChatComplete,
  logChatError,
  logChatExchange,
  logChatStart,
  logThinkingItems,
  logIncomingRequest,
  logRunPayload,
} from "./logging.js";
import { resolveSessionId } from "./session.js";
import { handleStreamResponse } from "./stream.js";

export function createChatRouter({
  config,
  attachmentResolver,
  threadStore,
}) {
  const router = express.Router();

  router.post("/v1/chat/completions", async (req, res) => {
    const { messages, model, reasoning_effort, stream } = req.body ?? {};
    const requestId = `chatreq_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

    if (config.logRequests) {
      logIncomingRequest(req.body);
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "Request body must include a non-empty messages array.",
          type: "invalid_request_error",
        },
      });
    }

    let sessionId = resolveSessionId(req);
    const sessionProvided = Boolean(sessionId);
    if (!sessionProvided && config.requireSessionId) {
      return res.status(400).json({
        error: {
          message:
            "session_id (or conversation_id / thread_id / user) is required in this deployment.",
          type: "missing_session_id",
        },
      });
    }
    if (!sessionProvided) {
      sessionId = `ephemeral-${crypto.randomUUID()}`;
    }

    let normalizedMessages;
    try {
      normalizedMessages = await normalizeMessages(messages, attachmentResolver);
    } catch (error) {
      return res.status(400).json({
        error: {
          message: error?.message ?? "Invalid message attachments.",
          type: "invalid_request_error",
        },
      });
    }

    let outputSchema = null;
    try {
      outputSchema = resolveOutputSchemaFromBody(req.body);
    } catch (error) {
      return res.status(400).json({
        error: {
          message: error?.message ?? "Invalid response_format schema.",
          type: "invalid_request_error",
        },
      });
    }

    let toolContext;
    try {
      toolContext = resolveToolContext(req.body);
    } catch (error) {
      return res.status(400).json({
        error: {
          message: error?.message ?? "Invalid tools definition.",
          type: "invalid_request_error",
        },
      });
    }

    const hasToolProtocolMessages = normalizedMessages.some((entry) =>
      isToolProtocolMessage(entry),
    );
    const usesToolProtocol = toolContext.enabled || hasToolProtocolMessages;
    const latestUserPrompt = extractLatestUserContent(normalizedMessages);
    const latestUserInputs = extractLatestUserInputs(normalizedMessages);
    const conversationPrompt = buildConversationPrompt(normalizedMessages);
    const conversationInputs = buildConversationInputs(normalizedMessages);
    const systemPrompt = buildSystemPrompt(normalizedMessages);
    const finalPrompt = usesToolProtocol
      ? conversationPrompt
      : sessionProvided
        ? mergePrompts(systemPrompt, latestUserPrompt)
        : conversationPrompt;
    const finalStructuredPrompt = usesToolProtocol
      ? conversationInputs
      : sessionProvided
        ? mergeStructuredPrompts(systemPrompt, latestUserInputs)
        : conversationInputs;

    if (
      !finalPrompt &&
      (!finalStructuredPrompt || finalStructuredPrompt.length === 0)
    ) {
      return res.status(400).json({
        error: {
          message: "Messages must include at least one user entry.",
          type: "invalid_request_error",
        },
      });
    }

    const baseCodexInput = finalStructuredPrompt ?? finalPrompt;
    const codexInput = toolContext.enabled
      ? prependToolInstructions(baseCodexInput, toolContext)
      : baseCodexInput;
    const turnOptions = {};
    if (toolContext.enabled) {
      turnOptions.outputSchema = buildToolDecisionSchema(toolContext);
    } else if (outputSchema) {
      turnOptions.outputSchema = outputSchema;
    }

    const attachmentCleanups = collectAttachmentCleanups(normalizedMessages);
    const { resolvedModel, resolvedReasoning } = resolveModelAndReasoning({
      model: model ?? config.defaultModel,
      reasoning: reasoning_effort ?? req.body?.model_reasoning_effort,
      defaultModel: config.defaultModel,
      defaultReasoning: config.defaultReasoning,
    });
    const threadOptions = {
      skipGitRepoCheck: config.shouldSkipGit,
      model: resolvedModel,
      modelReasoningEffort: resolvedReasoning,
    };
    if (config.sandboxMode) threadOptions.sandboxMode = config.sandboxMode;
    if (config.workingDirectory) {
      threadOptions.workingDirectory = config.workingDirectory;
    }
    if (config.networkAccess !== null) {
      threadOptions.networkAccessEnabled = config.networkAccess;
    }
    if (config.webSearch !== null) threadOptions.webSearchEnabled = config.webSearch;
    if (config.approvalPolicy) threadOptions.approvalPolicy = config.approvalPolicy;

    const threadRecord = await threadStore.getOrCreateThread(
      sessionId,
      threadOptions,
    );
    const { thread } = threadRecord;
    const requestStartedAt = Date.now();

    logChatStart({
      requestId,
      sessionId,
      sessionProvided,
      stream,
      messageCount: messages.length,
      threadOptions,
      toolContext,
      outputSchema,
    });

    if (stream) {
      const streamLogger = createChatStreamLogger({
        messages: normalizedMessages,
        maxTextChars: config.logMaxTextChars,
      });
      streamLogger.start();
      if (config.logRequests) {
        logRunPayload(
          "runStreamed payload",
          buildRunLogPayload({
            sessionId,
            threadOptions,
            codexInput,
            toolContext,
            outputSchema,
            turnOptions,
            sessionProvided,
          }),
        );
      }
      await handleStreamResponse({
        res,
        thread,
        threadOptions,
        sessionId,
        prompt: codexInput,
        shouldPersist: sessionProvided,
        turnOptions,
        cleanupTasks: attachmentCleanups,
        toolContext,
        persistThreadIdIfNeeded: threadStore.persistThreadIdIfNeeded,
        extractAssistantResponse,
        onTextDelta: (delta) => {
          streamLogger.writeDelta(delta);
        },
        onComplete: (result) => {
          if (toolContext.enabled) {
            streamLogger.writeMessage(result.message);
          }
          streamLogger.close();
          logChatComplete({
            requestId,
            sessionId,
            durationMs: Date.now() - requestStartedAt,
            ...result,
          });
        },
        onError: (error) => {
          streamLogger.close();
          logChatError({
            requestId,
            sessionId,
            durationMs: Date.now() - requestStartedAt,
            error,
          });
        },
        onThinking: (items) => {
          logThinkingItems({
            requestId,
            sessionId,
            items,
            maxTextChars: config.logMaxTextChars,
          });
        },
      });
      return;
    }

    try {
      if (config.logRequests) {
        logRunPayload(
          "run payload",
          buildRunLogPayload({
            sessionId,
            threadOptions,
            codexInput,
            toolContext,
            outputSchema,
            turnOptions,
            sessionProvided,
          }),
        );
      }
      const turn = await thread.run(codexInput, turnOptions);
      if (sessionProvided) {
        await threadStore.persistThreadIdIfNeeded(sessionId, thread);
      }

      const usage = formatUsage(turn?.usage);
      const assistantChoice = toolContext.enabled
        ? buildToolAwareChoice(turn, toolContext, extractAssistantResponse)
        : {
            message: {
              role: "assistant",
              content: extractAssistantResponse(turn),
            },
            finishReason: "stop",
          };
      logThinkingItems({
        requestId,
        sessionId,
        items: turn?.items,
        maxTextChars: config.logMaxTextChars,
      });
      logChatExchange({
        messages: normalizedMessages,
        message: assistantChoice.message,
        maxTextChars: config.logMaxTextChars,
      });
      logChatComplete({
        requestId,
        sessionId,
        durationMs: Date.now() - requestStartedAt,
        finishReason: assistantChoice.finishReason,
        toolCallCount: Array.isArray(assistantChoice.message.tool_calls)
          ? assistantChoice.message.tool_calls.length
          : assistantChoice.message.function_call
            ? 1
            : 0,
        usage,
      });

      return res.json({
        id: `chatcmpl-${thread.id ?? crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: threadOptions.model,
        choices: [
          {
            index: 0,
            message: assistantChoice.message,
            finish_reason: assistantChoice.finishReason,
          },
        ],
        usage,
      });
    } catch (error) {
      console.error("Codex run failed:", error);
      logChatError({
        requestId,
        sessionId,
        durationMs: Date.now() - requestStartedAt,
        error,
      });
      return res.status(500).json({
        error: {
          message: error?.message ?? "Codex execution failed.",
          type: "codex_execution_error",
        },
      });
    } finally {
      await cleanupAttachmentFiles(attachmentCleanups);
    }
  });

  return router;
}

function buildRunLogPayload({
  sessionId,
  threadOptions,
  codexInput,
  toolContext,
  outputSchema,
  turnOptions,
  sessionProvided,
}) {
  return {
    session_id: sessionId,
    model: threadOptions.model,
    reasoning: threadOptions.modelReasoningEffort,
    sandboxMode: threadOptions.sandboxMode,
    workingDirectory: threadOptions.workingDirectory,
    networkAccessEnabled: threadOptions.networkAccessEnabled,
    webSearchEnabled: threadOptions.webSearchEnabled,
    approvalPolicy: threadOptions.approvalPolicy,
    prompt: codexInput,
    response_format: toolContext.enabled
      ? "tool_calling"
      : outputSchema
        ? "json_schema"
        : "text",
    output_schema: turnOptions.outputSchema,
    ephemeral: !sessionProvided,
  };
}
