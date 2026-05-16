export function logIncomingRequest(body) {
  const messages = body?.messages;
  console.log(
    "[Codex Bridge] incoming chat request:",
    JSON.stringify(
      {
        session_id:
          body?.session_id ??
          body?.conversation_id ??
          body?.thread_id ??
          body?.user ??
          null,
        model: body?.model,
        reasoning_effort: body?.reasoning_effort ?? body?.model_reasoning_effort,
        stream: Boolean(body?.stream),
        message_count: Array.isArray(messages) ? messages.length : 0,
        raw: body,
      },
      null,
      2,
    ),
  );
}

export function logRunPayload(label, payload) {
  console.log(`[Codex Bridge] ${label}:`, JSON.stringify(payload, null, 2));
}

export function logChatStart({
  stream,
  threadOptions,
  toolContext,
}) {
  console.log(
    [
      "",
      `CodexBridge · ${threadOptions.model} · ${threadOptions.modelReasoningEffort}${stream ? " · stream" : ""}${toolContext.enabled ? " · tools" : ""}`,
    ].join("\n"),
  );
}

export function logChatComplete({
  durationMs,
  finishReason,
  toolCallCount = 0,
}) {
  const toolText = toolCallCount > 0 ? ` · tool calls: ${toolCallCount}` : "";
  console.log(
    [
      `Done · ${finishReason} · ${durationMs}ms${toolText}`,
    ].join("\n"),
  );
}

export function logChatExchange({
  messages,
  message,
  maxTextChars,
}) {
  const normalized = normalizeAssistantMessageForLog(message, maxTextChars);
  console.log(
    [
      ...messages.flatMap((entry, index) =>
        formatBubble(stripLogPrefixes(formatInputMessage(entry, index, maxTextChars)), "left"),
      ),
      ...formatBubble(stripLogPrefixes(formatAssistantMessage(normalized)), "right"),
    ].join("\n"),
  );
}

export function createChatStreamLogger({ messages, maxTextChars }) {
  const bubbleWidth = 62;
  const terminalWidth = 112;
  const rightMargin = terminalWidth - bubbleWidth - 2;
  const prefix = " ".repeat(Math.max(0, rightMargin));
  const contentWidth = bubbleWidth - 4;
  let open = false;
  let currentLine = "";

  function openBubble() {
    if (open) return;
    const requestLines = messages.flatMap((entry, index) =>
      formatBubble(
        stripLogPrefixes(formatInputMessage(entry, index, maxTextChars)),
        "left",
      ),
    );
    console.log(requestLines.join("\n"));
    console.log(
      [
        "",
        `${prefix}╭─ Response (streaming)${"─".repeat(bubbleWidth - 23)}╮`,
        `${prefix}│ ${padRight("Assistant", contentWidth)} │`,
      ].join("\n"),
    );
    open = true;
  }

  function writeDelta(delta) {
    if (!delta) return;
    openBubble();
    for (const char of String(delta)) {
      if (char === "\n") {
        flushLine();
        continue;
      }
      currentLine += char;
      if (currentLine.length >= contentWidth) {
        flushLine();
      }
    }
  }

  function writeMessage(message) {
    const normalized = normalizeAssistantMessageForLog(message, maxTextChars);
    const lines = stripLogPrefixes(formatAssistantMessage(normalized)).slice(1);
    for (const line of lines) {
      writeLine(line);
    }
  }

  function writeLine(line) {
    openBubble();
    if (currentLine) flushLine();
    const wrapped = wrapLine(line, contentWidth);
    for (const wrappedLine of wrapped) {
      console.log(`${prefix}│ ${padRight(wrappedLine, contentWidth)} │`);
    }
  }

  function flushLine() {
    openBubble();
    console.log(`${prefix}│ ${padRight(currentLine, contentWidth)} │`);
    currentLine = "";
  }

  function close() {
    if (!open) return;
    if (currentLine) flushLine();
    console.log(`${prefix}╰${"─".repeat(bubbleWidth - 2)}╯`);
    open = false;
  }

  return {
    start: openBubble,
    writeDelta,
    writeMessage,
    writeLine,
    close,
  };
}

export function logThinkingItems({
  items,
  maxTextChars,
}) {
  const reasoning = extractReasoningItems(items, maxTextChars);
  if (reasoning.length === 0) return;
  console.log(
    reasoning
      .flatMap((item) => [`│`, "│ Thinking", ...indentMultiline(item.text)])
      .join("\n"),
  );
}

export function logChatError({
  durationMs,
  error,
}) {
  console.error(
    [
      "┌─ Error ────────────────────────────────────────────────",
      `│ ${error?.name ?? "Error"} after ${durationMs}ms`,
      ...indentMultiline(error?.message ?? String(error)),
      "└────────────────────────────────────────────────────────",
    ].join("\n"),
  );
}

export function extractReasoningItems(items, maxTextChars) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item?.type === "reasoning" && typeof item.text === "string")
    .map((item) => ({
      id: item.id,
      text: truncateText(item.text, maxTextChars),
    }));
}

export function normalizeAssistantMessageForLog(message, maxTextChars) {
  if (!message || typeof message !== "object") return null;
  return {
    role: message.role,
    content: truncateText(message.content, maxTextChars),
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => ({
          id: call.id,
          type: call.type,
          function: call.function,
        }))
      : undefined,
    function_call: message.function_call ?? undefined,
  };
}

export function truncateText(value, maxTextChars) {
  if (typeof value !== "string") return value ?? null;
  const limit = Number.isFinite(maxTextChars) && maxTextChars > 0
    ? maxTextChars
    : 4000;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
}

function formatInputMessage(entry, index, maxTextChars) {
  const role = formatRole(entry.role);
  const suffix = [
    entry.name ? `name=${entry.name}` : null,
    entry.toolCallId ? `tool_call_id=${entry.toolCallId}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [`│`, `│ ${role}${suffix ? ` (${suffix})` : ""}`];
  const text = truncateText(entry.text, maxTextChars);
  if (text) lines.push(...formatTextBlock(text));
  const attachmentCount = Array.isArray(entry.attachments)
    ? entry.attachments.length
    : 0;
  if (attachmentCount > 0) lines.push(`│   attachments: ${attachmentCount}`);
  if (Array.isArray(entry.toolCalls) && entry.toolCalls.length > 0) {
    lines.push("│   tool_calls:");
    lines.push(...indentMultiline(JSON.stringify(entry.toolCalls, null, 2), 4));
  }
  if (entry.functionCall) {
    lines.push("│   function_call:");
    lines.push(...indentMultiline(JSON.stringify(entry.functionCall, null, 2), 4));
  }
  return lines;
}

function formatAssistantMessage(message) {
  if (!message) return ["│ -"];
  const lines = ["│", `│ ${formatRole(message.role ?? "assistant")}`];
  if (message.content) {
    lines.push(...formatTextBlock(message.content));
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    lines.push("│   Tool calls:");
    for (const call of message.tool_calls) {
      lines.push(`│   - ${call.function?.name ?? "unknown"}`);
      lines.push("│     arguments:");
      lines.push(...formatJsonString(call.function?.arguments ?? "{}", 6));
    }
  }
  if (message.function_call) {
    lines.push(`│   Function call: ${message.function_call.name ?? "unknown"}`);
    lines.push("│   arguments:");
    lines.push(...formatJsonString(message.function_call.arguments ?? "{}", 4));
  }
  return lines;
}

function formatRole(role) {
  const normalized = String(role ?? "message").toLowerCase();
  const names = {
    system: "System",
    user: "User",
    assistant: "Assistant",
    tool: "Tool",
  };
  return names[normalized] ?? normalized;
}

function indentMultiline(text, spaces = 2) {
  const prefix = `│ ${" ".repeat(spaces)}`;
  return String(text)
    .split("\n")
    .map((line) => `${prefix}${line}`);
}

function formatTextBlock(text, spaces = 2) {
  const lines = String(text).split("\n");
  const hasFence = lines.some((line) => line.trim().startsWith("```"));
  if (hasFence) return formatFencedMarkdown(lines, spaces);
  if (looksLikeCode(lines)) {
    return [
      `│ ${" ".repeat(spaces)}\`\`\``,
      ...indentMultiline(text, spaces + 2),
      `│ ${" ".repeat(spaces)}\`\`\``,
    ];
  }
  return formatMixedTextAndCode(lines, spaces);
}

function formatFencedMarkdown(lines, spaces) {
  const output = [];
  let inCode = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      output.push(`│ ${" ".repeat(spaces)}${line.trim()}`);
      continue;
    }
    output.push(`│ ${" ".repeat(inCode ? spaces + 2 : spaces)}${line}`);
  }
  return output;
}

function looksLikeCode(lines) {
  if (lines.length < 2) return false;
  const nonEmpty = lines.filter((line) => line.trim());
  if (nonEmpty.length < 2) return false;
  const codeSignals = nonEmpty.filter(isCodeLine);
  return codeSignals.length >= Math.min(3, nonEmpty.length);
}

function formatMixedTextAndCode(lines, spaces) {
  const output = [];
  let index = 0;
  while (index < lines.length) {
    if (!isCodeLine(lines[index])) {
      output.push(`│ ${" ".repeat(spaces)}${lines[index]}`);
      index += 1;
      continue;
    }

    const start = index;
    while (index < lines.length && (isCodeLine(lines[index]) || !lines[index].trim())) {
      index += 1;
    }
    const run = lines.slice(start, index);
    const codeLineCount = run.filter(isCodeLine).length;
    if (codeLineCount < 2) {
      output.push(...run.map((line) => `│ ${" ".repeat(spaces)}${line}`));
      continue;
    }
    output.push(`│ ${" ".repeat(spaces)}\`\`\``);
    output.push(...run.map((line) => `│ ${" ".repeat(spaces + 2)}${line}`));
    output.push(`│ ${" ".repeat(spaces)}\`\`\``);
  }
  return output;
}

function isCodeLine(line) {
  return /(^\s*(import|export|const|let|var|function|class|if|for|while|return|def|async|await)\b|[{};]$|^\s*<\/?[a-z][\w-]*(\s|>|$)|=>)/.test(
    line,
  );
}

function formatJsonString(value, spaces) {
  let formatted = value;
  if (typeof value === "string") {
    try {
      formatted = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      formatted = value;
    }
  }
  return formatTextBlock(String(formatted), spaces);
}

function stripLogPrefixes(lines) {
  return lines.map((line) => line.replace(/^│ ?/, ""));
}

function formatBubble(lines, side) {
  const terminalWidth = 112;
  const bubbleWidth = 62;
  const leftMargin = 2;
  const rightMargin = terminalWidth - bubbleWidth - 2;
  const margin = side === "right" ? rightMargin : leftMargin;
  const label = side === "right" ? "Response" : "Request";
  const wrapped = wrapColumn(trimOuterBlankLines(lines), bubbleWidth - 4);
  const prefix = " ".repeat(Math.max(0, margin));
  const top = `${prefix}╭─ ${label}${"─".repeat(Math.max(0, bubbleWidth - label.length - 4))}╮`;
  const body = wrapped.map(
    (line) => `${prefix}│ ${padRight(line, bubbleWidth - 4)} │`,
  );
  const bottom = `${prefix}╰${"─".repeat(bubbleWidth - 2)}╯`;
  return ["", top, ...body, bottom];
}

function wrapColumn(lines, width) {
  return lines.flatMap((line) => wrapLine(line, width));
}

function wrapLine(line, width) {
  if (!line) return [""];
  const chunks = [];
  let rest = line;
  while (rest.length > width) {
    chunks.push(rest.slice(0, width));
    rest = `  ${rest.slice(width)}`;
  }
  chunks.push(rest);
  return chunks;
}

function padRight(value, width) {
  const text = String(value);
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

function trimOuterBlankLines(lines) {
  const trimmed = [...lines];
  while (trimmed.length > 0 && !trimmed[0]) trimmed.shift();
  while (trimmed.length > 0 && !trimmed[trimmed.length - 1]) trimmed.pop();
  return trimmed.length ? trimmed : [""];
}
