export function resolveSessionId(req) {
  const body = req?.body ?? {};
  const headers = req?.headers ?? {};
  const readHeader = (key) => {
    const value = headers[String(key).toLowerCase()];
    if (value === undefined || value === null) return null;
    const text = Array.isArray(value) ? value[0] : value;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  };
  return (
    body?.session_id ??
    body?.conversation_id ??
    body?.thread_id ??
    body?.user ??
    readHeader("x-session-id") ??
    readHeader("session-id") ??
    readHeader("x-conversation-id") ??
    readHeader("x-thread-id") ??
    readHeader("x-user-id") ??
    null
  );
}
