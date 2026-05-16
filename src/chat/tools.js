import crypto from "node:crypto";
import { ensureJsonSchemaObject } from "./schema.js";
import { isPlainObject } from "../utils/object.js";

export function resolveToolContext(body) {
  if (!body || typeof body !== "object") {
    return emptyToolContext();
  }

  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  const rawFunctions = Array.isArray(body.functions) ? body.functions : [];
  const tools = [];
  for (const rawTool of rawTools) {
    tools.push(normalizeRequestTool(rawTool));
  }
  for (const rawFunction of rawFunctions) {
    tools.push(normalizeRequestTool({ type: "function", function: rawFunction }));
  }

  const dedupedTools = [];
  const seenNames = new Set();
  for (const tool of tools) {
    const name = tool.function.name;
    if (seenNames.has(name)) {
      throw new Error(`Duplicate tool/function name "${name}".`);
    }
    seenNames.add(name);
    dedupedTools.push(tool);
  }

  const legacy = rawTools.length === 0 && rawFunctions.length > 0;
  const choice = normalizeToolChoice(
    body.tool_choice ?? body.toolChoice,
    body.function_call ?? body.functionCall,
    legacy,
  );
  if (choice.forcedName && !seenNames.has(choice.forcedName)) {
    throw new Error(`tool_choice references unknown function "${choice.forcedName}".`);
  }

  return {
    enabled: dedupedTools.length > 0,
    tools: dedupedTools,
    mode: choice.mode,
    forcedName: choice.forcedName,
    legacy,
  };
}

export function emptyToolContext() {
  return {
    enabled: false,
    tools: [],
    mode: "auto",
    forcedName: null,
    legacy: false,
  };
}

export function normalizeRequestTool(rawTool) {
  if (!rawTool || typeof rawTool !== "object") {
    throw new Error("Each tool must be an object.");
  }
  if (rawTool.type && rawTool.type !== "function") {
    throw new Error(`Unsupported tool type "${rawTool.type}".`);
  }
  const fn = rawTool.function;
  if (!fn || typeof fn !== "object") {
    throw new Error("Each tool must include a function definition.");
  }
  if (typeof fn.name !== "string" || !fn.name.trim()) {
    throw new Error("Each function tool must include a non-empty name.");
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(fn.name)) {
    throw new Error(
      `Function name "${fn.name}" must match /^[a-zA-Z0-9_-]{1,64}$/.`,
    );
  }
  const parameters =
    fn.parameters === undefined
      ? { type: "object", properties: {}, additionalProperties: true }
      : ensureJsonSchemaObject(fn.parameters, `parameters for function "${fn.name}"`);
  return {
    type: "function",
    function: {
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters,
    },
  };
}

export function normalizeToolChoice(toolChoice, functionCall, legacy) {
  const candidate = legacy && functionCall !== undefined ? functionCall : toolChoice;
  if (candidate === undefined || candidate === null) {
    return { mode: "auto", forcedName: null };
  }
  if (typeof candidate === "string") {
    const normalized = candidate.toLowerCase();
    if (["auto", "none", "required"].includes(normalized)) {
      return { mode: normalized, forcedName: null };
    }
    throw new Error(`Unsupported tool_choice "${candidate}".`);
  }
  if (!isPlainObject(candidate)) {
    throw new Error("tool_choice must be a string or object.");
  }
  if (legacy && typeof candidate.name === "string") {
    return { mode: "required", forcedName: candidate.name };
  }
  const forcedName =
    typeof candidate.function?.name === "string"
      ? candidate.function.name
      : typeof candidate.name === "string"
        ? candidate.name
        : null;
  if (forcedName) {
    return { mode: "required", forcedName };
  }
  throw new Error("Unsupported tool_choice object.");
}

export function prependToolInstructions(input, toolContext) {
  const instructions = buildToolInstructions(toolContext);
  if (Array.isArray(input)) {
    return [{ type: "text", text: instructions }, ...input];
  }
  return `${instructions}\n\n${input}`;
}

export function buildToolInstructions(toolContext) {
  const toolSpecs = toolContext.tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
  const choiceText = toolContext.forcedName
    ? `You must request the "${toolContext.forcedName}" tool.`
    : toolContext.mode === "required"
      ? "You must request at least one tool."
      : toolContext.mode === "none"
        ? "You must not request tools; answer directly."
        : "Request tools only when they are needed. Answer directly when no tool is needed.";

  return [
    "You are operating behind an OpenAI Chat Completions tool-calling compatibility layer.",
    "You cannot execute these client tools yourself. If a tool is needed, request it and wait for the client to send role=tool results in a later request.",
    choiceText,
    "Return only JSON matching the provided schema.",
    'For a direct answer, return {"type":"final","content":"...","tool_calls":[]}.',
    'For tool requests, return {"type":"tool_calls","content":"","tool_calls":[{"name":"tool_name","arguments":"{...}"}]}.',
    "Tool arguments must be a JSON string encoding an object that should match the tool's parameters schema.",
    `Available tools: ${JSON.stringify(toolSpecs)}`,
  ].join("\n");
}

export function buildToolDecisionSchema(toolContext) {
  const allowedNames = toolContext.forcedName
    ? [toolContext.forcedName]
    : toolContext.tools.map((tool) => tool.function.name);
  const allowedTypes =
    toolContext.mode === "none"
      ? ["final"]
      : toolContext.mode === "required" || toolContext.forcedName
        ? ["tool_calls"]
        : ["final", "tool_calls"];
  return {
    type: "object",
    properties: {
      type: { type: "string", enum: allowedTypes },
      content: { type: "string" },
      tool_calls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: allowedNames },
            arguments: {
              type: "string",
            },
          },
          required: ["name", "arguments"],
          additionalProperties: false,
        },
      },
    },
    required: ["type", "content", "tool_calls"],
    additionalProperties: false,
  };
}

export function buildToolAwareChoice(turn, toolContext, extractAssistantResponse) {
  const text = extractAssistantResponse(turn);
  const parsed = parseToolDecision(text);
  if (
    parsed?.type === "tool_calls" &&
    Array.isArray(parsed.tool_calls) &&
    parsed.tool_calls.length > 0
  ) {
    const calls = parsed.tool_calls
      .map((call) => formatToolCall(call, toolContext))
      .filter(Boolean);
    if (calls.length > 0) {
      if (toolContext.legacy) {
        return {
          message: {
            role: "assistant",
            content: null,
            function_call: calls[0].function,
          },
          finishReason: "function_call",
        };
      }
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls,
        },
        finishReason: "tool_calls",
      };
    }
  }

  return {
    message: {
      role: "assistant",
      content: typeof parsed?.content === "string" ? parsed.content : text,
    },
    finishReason: "stop",
  };
}

export function parseToolDecision(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export function formatToolCall(call, toolContext) {
  if (!call || typeof call !== "object") return null;
  const name = typeof call.name === "string" ? call.name : null;
  if (!name || !toolContext.tools.some((tool) => tool.function.name === name)) {
    return null;
  }
  const args =
    typeof call.arguments === "string"
      ? normalizeJsonArgumentsString(call.arguments)
      : JSON.stringify(isPlainObject(call.arguments) ? call.arguments : {});
  return {
    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: {
      name,
      arguments: args,
    },
  };
}

export function normalizeJsonArgumentsString(value) {
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(isPlainObject(parsed) ? parsed : {});
  } catch {
    return "{}";
  }
}
