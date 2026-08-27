import type { JsonValue, OpenAiChatMessage, OpenAiChatRequest } from "./types.ts";

export type ReasoningReplayMode = "reasoning_content" | "assistant_content";

type ReplayPolicy = (message: OpenAiChatMessage) => OpenAiChatMessage;

const contentWithReasoning = (
  content: string | JsonValue[] | null,
  reasoning: string,
): string | JsonValue[] => {
  const thinking_block = `<think>\n${reasoning}\n</think>`;
  if (Array.isArray(content)) {
    return [{ type: "text", text: thinking_block }, ...content];
  }
  return [thinking_block, content].filter((fragment) => fragment !== null && fragment !== "").join("\n\n");
};

const replayAsAssistantContent: ReplayPolicy = (message) => {
  const { reasoning_content, reasoning, reasoning_text, ...visible_message } = message;
  const historical_reasoning = reasoning_content ?? reasoning ?? reasoning_text;
  if (message.role !== "assistant" || !historical_reasoning) {
    return message;
  }
  return {
    ...visible_message,
    content: contentWithReasoning(message.content, historical_reasoning),
  };
};

const replayPolicies: Record<ReasoningReplayMode, ReplayPolicy> = {
  reasoning_content: (message) => message,
  assistant_content: replayAsAssistantContent,
};

export const applyReasoningReplay = (
  request: OpenAiChatRequest,
  mode: ReasoningReplayMode,
): OpenAiChatRequest => ({
  ...request,
  messages: request.messages.map(replayPolicies[mode]),
});
