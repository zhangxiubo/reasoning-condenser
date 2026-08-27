import { randomUUID } from "node:crypto";
import type {
  JsonObject,
  JsonValue,
  NormalizedTurn,
  OpenAiChatResponse,
  StopReason,
  ToolCall,
} from "./types.ts";

export class InvalidUpstreamResponse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUpstreamResponse";
  }
}

const stopReasons: Record<string, StopReason> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
};

const splitInlineThinking = (content: string): { reasoning: string; text: string } => {
  const match = content.match(/^\s*<think>\s*([\s\S]*?)\s*<\/think>\s*([\s\S]*)$/);
  return match
    ? { reasoning: match[1] ?? "", text: match[2] ?? "" }
    : { reasoning: "", text: content };
};

const parseToolInput = (arguments_text: string, call_id: string): JsonObject => {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(arguments_text) as JsonValue;
  } catch (error) {
    throw new InvalidUpstreamResponse(`Tool call ${call_id} contained invalid JSON arguments: ${String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidUpstreamResponse(`Tool call ${call_id} arguments must be a JSON object`);
  }
  return parsed;
};

const normalizeToolCall = (call: {
  id: string;
  function: { name: string; arguments: string };
}): ToolCall => ({
  id: call.id,
  name: call.function.name,
  input: parseToolInput(call.function.arguments, call.id),
  arguments_text: call.function.arguments,
});

export const normalizeOpenAiResponse = (
  response: OpenAiChatResponse,
  requested_model: string,
): NormalizedTurn => {
  const choice = response.choices.at(0);
  if (!choice) {
    throw new InvalidUpstreamResponse("OpenAI-compatible response contained no choices");
  }

  const message = choice.message;
  const raw_content = message.content ?? "";
  const inline = splitInlineThinking(raw_content);
  const reasoning = message.reasoning_content ?? message.reasoning ?? message.thinking ?? inline.reasoning;
  const tool_calls = (message.tool_calls ?? []).map(normalizeToolCall);
  const stop_reason = tool_calls.length > 0
    ? "tool_use"
    : stopReasons[choice.finish_reason ?? ""] ?? "end_turn";

  return {
    id: response.id ?? `msg_${randomUUID().replaceAll("-", "")}`,
    model: response.model ?? requested_model,
    reasoning,
    text: inline.reasoning && reasoning === inline.reasoning ? inline.text : raw_content,
    tool_calls,
    stop_reason,
    upstream_usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
  };
};
