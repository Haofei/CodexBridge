import crypto from "node:crypto";
import { cleanupAttachmentFiles } from "../chat/attachments.js";
import {
  extractAgentMessageText,
  formatUsage,
} from "../chat/response.js";
import { buildToolAwareChoice } from "../chat/tools.js";

export async function handleStreamResponse({
  res,
  thread,
  threadOptions,
  sessionId,
  prompt,
  shouldPersist = true,
  turnOptions = {},
  cleanupTasks = [],
  toolContext = { enabled: false },
  persistThreadIdIfNeeded,
  extractAssistantResponse,
  onComplete,
  onError,
  onThinking,
  onTextDelta,
}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const created = Math.floor(Date.now() / 1000);
  const chunkId = `chatcmpl-${thread.id ?? crypto.randomUUID()}`;
  const chunkBase = {
    id: chunkId,
    object: "chat.completion.chunk",
    created,
    model: threadOptions.model,
  };
  const sendChunk = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const sendDone = () => {
    res.write("data: [DONE]\n\n");
  };

  const sendDelta = (delta, finishReason = null, usage = null, extra = {}) => {
    const chunk = {
      ...chunkBase,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
      ...extra,
    };
    if (usage) chunk.usage = usage;
    sendChunk(chunk);
  };

  try {
    if (toolContext.enabled) {
      const turn = await thread.run(prompt, turnOptions);
      if (shouldPersist) {
        await persistThreadIdIfNeeded(sessionId, thread);
      }
      const usage = formatUsage(turn?.usage);
      const choice = buildToolAwareChoice(
        turn,
        toolContext,
        extractAssistantResponse,
      );
      if (typeof onThinking === "function") {
        onThinking(turn?.items);
      }
      sendDelta({ role: "assistant" });
      if (Array.isArray(choice.message.tool_calls)) {
        sendDelta({
          tool_calls: choice.message.tool_calls.map((call, index) => ({
            index,
            id: call.id,
            type: call.type,
            function: call.function,
          })),
        });
      } else if (choice.message.function_call) {
        sendDelta({ function_call: choice.message.function_call });
      } else if (choice.message.content) {
        sendDelta({ content: choice.message.content });
      }
      sendDelta({}, choice.finishReason, usage);
      if (typeof onComplete === "function") {
        onComplete({
          finishReason: choice.finishReason,
          toolCallCount: Array.isArray(choice.message.tool_calls)
            ? choice.message.tool_calls.length
            : choice.message.function_call
              ? 1
              : 0,
          usage,
          message: choice.message,
        });
      }
      sendDone();
      res.end();
      return;
    }

    const streamed = await thread.runStreamed(prompt, turnOptions);
    let bufferedText = "";
    let roleSent = false;
    let usage = undefined;

    for await (const event of streamed.events) {
      if (event?.type === "turn.completed") {
        usage = formatUsage(event?.usage);
        continue;
      }
      if (event?.type === "turn.failed") {
        throw new Error(event?.error?.message ?? "Codex turn failed.");
      }
      if (
        event?.type === "item.completed" &&
        event?.item?.type === "reasoning" &&
        typeof onThinking === "function"
      ) {
        onThinking([event.item]);
      }

      const text = extractAgentMessageText(event);
      if (typeof text === "string") {
        if (!roleSent) {
          sendDelta({ role: "assistant" });
          roleSent = true;
        }
        if (text.length > bufferedText.length) {
          const deltaContent = text.slice(bufferedText.length);
          bufferedText = text;
          if (typeof onTextDelta === "function") {
            onTextDelta(deltaContent);
          }
          sendDelta({ content: deltaContent });
        }
      }
    }

    if (shouldPersist) {
      await persistThreadIdIfNeeded(sessionId, thread);
    }
    sendDelta({}, "stop", usage);
    if (typeof onComplete === "function") {
      onComplete({
        finishReason: "stop",
        toolCallCount: 0,
        usage,
        message: {
          role: "assistant",
          content: bufferedText,
        },
      });
    }
    sendDone();
    res.end();
  } catch (error) {
    console.error("Codex stream failed:", error);
    if (typeof onError === "function") {
      onError(error);
    }
    sendChunk({
      ...chunkBase,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "error",
        },
      ],
      error: {
        message: error?.message ?? "Codex streaming failed.",
        type: "codex_stream_error",
      },
    });
    sendDone();
    res.end();
  } finally {
    await cleanupAttachmentFiles(cleanupTasks);
  }
}
