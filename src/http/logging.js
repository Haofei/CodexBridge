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
