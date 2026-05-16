import crypto from "node:crypto";

export async function normalizeMessages(messages, { resolveImageBlock }) {
  if (!Array.isArray(messages)) return [];
  const normalized = [];
  for (let i = 0; i < messages.length; i += 1) {
    normalized.push(await normalizeMessageEntry(messages[i], i, resolveImageBlock));
  }
  return normalized;
}

export async function normalizeMessageEntry(entry, index, resolveImageBlock) {
  if (!entry || typeof entry !== "object") {
    return { role: null, text: null, attachments: [] };
  }
  const role =
    typeof entry.role === "string" ? entry.role.trim().toLowerCase() : null;
  const text = extractTextContent(entry);
  const attachments = await extractImageAttachments(
    entry,
    index,
    resolveImageBlock,
  );
  const name = typeof entry.name === "string" ? entry.name : null;
  const toolCallId =
    typeof entry.tool_call_id === "string" ? entry.tool_call_id : null;
  const toolCalls = normalizeMessageToolCalls(entry.tool_calls);
  const functionCall = normalizeMessageFunctionCall(entry.function_call);
  return {
    role,
    text,
    attachments,
    name,
    toolCallId,
    toolCalls,
    functionCall,
  };
}

export function extractTextContent(entry) {
  if (typeof entry?.content === "string") return entry.content;
  if (entry?.content === null && entry?.role === "assistant") return null;
  if (!Array.isArray(entry?.content)) return null;
  const textBlocks = entry.content
    .filter((block) => block?.type === "text" && block?.text)
    .map((block) => block.text);
  if (textBlocks.length === 0) return null;
  return textBlocks.join("\n");
}

export function normalizeMessageToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const normalized = [];
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") continue;
    const name =
      typeof call.function?.name === "string" ? call.function.name : null;
    if (!name) continue;
    normalized.push({
      id:
        typeof call.id === "string" && call.id
          ? call.id
          : `call_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "function",
      function: {
        name,
        arguments:
          typeof call.function?.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments ?? {}),
      },
    });
  }
  return normalized;
}

export function normalizeMessageFunctionCall(functionCall) {
  if (!functionCall || typeof functionCall !== "object") return null;
  const name =
    typeof functionCall.name === "string" && functionCall.name
      ? functionCall.name
      : null;
  if (!name) return null;
  return {
    name,
    arguments:
      typeof functionCall.arguments === "string"
        ? functionCall.arguments
        : JSON.stringify(functionCall.arguments ?? {}),
  };
}

export async function extractImageAttachments(entry, index, resolveImageBlock) {
  if (!Array.isArray(entry?.content)) return [];
  const attachments = [];
  for (const block of entry.content) {
    const resolved = await resolveImageBlock(block, index);
    if (resolved) attachments.push(resolved);
  }
  return attachments;
}

export function buildConversationPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const lines = [];
  for (const entry of messages) {
    const text = renderMessagePromptText(entry);
    if (!entry?.role || !text) continue;
    lines.push(`${renderMessageLabel(entry)}\n${text}`.trim());
  }
  return lines.length ? lines.join("\n\n") : null;
}

export function buildConversationInputs(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const inputs = [];
  for (const entry of messages) {
    if (!entry?.role) continue;
    const label = renderMessageLabel(entry);
    let prefixed = false;
    const text = renderMessagePromptText(entry);
    if (text) {
      inputs.push({
        type: "text",
        text: `${label}\n${text}`.trim(),
      });
      prefixed = true;
    }
    if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
      if (!prefixed) {
        inputs.push({ type: "text", text: label });
        prefixed = true;
      }
      for (const attachment of entry.attachments) {
        if (attachment?.path) {
          inputs.push({ type: "local_image", path: attachment.path });
        }
      }
    }
  }
  return inputs.length ? inputs : null;
}

export function renderMessageLabel(entry) {
  const role = entry?.role ? String(entry.role).toUpperCase() : "MESSAGE";
  const attrs = [];
  if (entry?.name) attrs.push(`name=${entry.name}`);
  if (entry?.toolCallId) attrs.push(`tool_call_id=${entry.toolCallId}`);
  return attrs.length ? `[${role} ${attrs.join(" ")}]` : `[${role}]`;
}

export function renderMessagePromptText(entry) {
  if (!entry || typeof entry !== "object") return null;
  const blocks = [];
  if (entry.text) blocks.push(entry.text);
  if (Array.isArray(entry.toolCalls) && entry.toolCalls.length > 0) {
    blocks.push(`tool_calls: ${JSON.stringify(entry.toolCalls)}`);
  }
  if (entry.functionCall) {
    blocks.push(`function_call: ${JSON.stringify(entry.functionCall)}`);
  }
  return blocks.length ? blocks.join("\n") : null;
}

export function isToolProtocolMessage(entry) {
  return (
    entry?.role === "tool" ||
    Boolean(entry?.toolCallId) ||
    Boolean(entry?.functionCall) ||
    (Array.isArray(entry?.toolCalls) && entry.toolCalls.length > 0)
  );
}

export function extractLatestUserContent(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry?.role !== "user") continue;
    if (entry?.text) return entry.text;
  }
  return null;
}

export function extractLatestUserInputs(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry?.role !== "user") continue;
    const inputs = [];
    if (entry?.text) {
      inputs.push({ type: "text", text: entry.text });
    }
    if (Array.isArray(entry?.attachments)) {
      for (const attachment of entry.attachments) {
        if (attachment?.path) {
          inputs.push({ type: "local_image", path: attachment.path });
        }
      }
    }
    return inputs.length ? inputs : null;
  }
  return null;
}

export function buildSystemPrompt(messages) {
  if (!Array.isArray(messages)) return null;
  const blocks = [];
  for (const entry of messages) {
    if (entry?.role !== "system" || !entry?.text) continue;
    blocks.push(`[SYSTEM]\n${entry.text}`.trim());
  }
  return blocks.length ? blocks.join("\n\n") : null;
}

export function mergePrompts(systemPrompt, userPrompt) {
  if (!userPrompt) return null;
  if (!systemPrompt) return userPrompt;
  return `${systemPrompt}\n\n${userPrompt}`;
}

export function mergeStructuredPrompts(systemPrompt, userInputs) {
  const inputs = [];
  if (systemPrompt) {
    inputs.push({ type: "text", text: systemPrompt });
  }
  if (Array.isArray(userInputs) && userInputs.length > 0) {
    inputs.push(...userInputs);
  }
  return inputs.length ? inputs : null;
}
