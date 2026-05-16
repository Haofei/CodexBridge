export function formatUsage(raw) {
  if (!raw) return undefined;
  const prompt = raw.input_tokens ?? 0;
  const completion = raw.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

export function extractAssistantResponse(turn) {
  if (turn?.finalResponse) return turn.finalResponse;
  if (turn?.text) return turn.text;
  const agentMessage = turn?.items?.find(
    (item) => item?.type === "agent_message" && item?.text,
  );
  return agentMessage?.text ?? "";
}

export function extractAgentMessageText(event) {
  const item = event?.item;
  if (!item) return null;
  if (item.type === "agent_message" && typeof item.text === "string") {
    return item.text;
  }
  return null;
}
