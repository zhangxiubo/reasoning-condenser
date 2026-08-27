import { createHash } from "node:crypto";
import type {
  AnthropicContentBlock,
  AnthropicMessagesResponse,
  NormalizedTurn,
  TokenUsage,
} from "./types.ts";

export interface AnthropicStreamEvent {
  event: string;
  data: Record<string, unknown>;
}

const localSignature = (reasoning: string): string => {
  const digest = createHash("sha256").update(reasoning).digest("base64url");
  return `local-rcr:${digest}`;
};

export const toAnthropicResponse = (
  turn: NormalizedTurn,
  public_model: string,
  visible_usage: TokenUsage,
): AnthropicMessagesResponse => {
  const reasoning_blocks: AnthropicContentBlock[] = turn.reasoning
    ? [{ type: "thinking", thinking: turn.reasoning, signature: localSignature(turn.reasoning) }]
    : [];
  const text_blocks: AnthropicContentBlock[] = turn.text ? [{ type: "text", text: turn.text }] : [];
  const tool_blocks: AnthropicContentBlock[] = turn.tool_calls.map((call) => ({
    type: "tool_use",
    id: call.id,
    name: call.name,
    input: call.input,
  }));

  return {
    id: turn.id.startsWith("msg_") ? turn.id : `msg_${turn.id}`,
    type: "message",
    role: "assistant",
    content: [...reasoning_blocks, ...text_blocks, ...tool_blocks],
    model: public_model,
    stop_reason: turn.stop_reason,
    stop_sequence: null,
    usage: visible_usage,
  } as AnthropicMessagesResponse;
};

const blockEvents = (block: AnthropicContentBlock, index: number): AnthropicStreamEvent[] => {
  switch (block.type) {
    case "thinking":
      return [
        {
          event: "content_block_start",
          data: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: block.thinking },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: { type: "signature_delta", signature: block.signature ?? "" },
          },
        },
        { event: "content_block_stop", data: { type: "content_block_stop", index } },
      ];
    case "text":
      return [
        {
          event: "content_block_start",
          data: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        },
        {
          event: "content_block_delta",
          data: { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
        },
        { event: "content_block_stop", data: { type: "content_block_stop", index } },
      ];
    case "tool_use":
      return [
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
          },
        },
        { event: "content_block_stop", data: { type: "content_block_stop", index } },
      ];
    default:
      return [];
  }
};

export const anthropicStreamEvents = (response: AnthropicMessagesResponse): AnthropicStreamEvent[] => [
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: response.id,
        type: "message",
        role: "assistant",
        content: [],
        model: response.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: response.usage.input_tokens, output_tokens: 0 },
      },
    },
  },
  ...response.content.flatMap(blockEvents),
  {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: response.stop_reason, stop_sequence: response.stop_sequence },
      usage: { output_tokens: response.usage.output_tokens },
    },
  },
  { event: "message_stop", data: { type: "message_stop" } },
];

export const encodeAnthropicStream = (response: AnthropicMessagesResponse): string =>
  anthropicStreamEvents(response)
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
