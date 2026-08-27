import type {
  NormalizedTurn,
  OpenAiPublicChatResponse,
  OpenAiToolCall,
  TokenUsage,
} from "./types.ts";

const finishReason = (turn: NormalizedTurn): "stop" | "length" | "tool_calls" => {
  const reasons = {
    end_turn: "stop",
    stop_sequence: "stop",
    max_tokens: "length",
    tool_use: "tool_calls",
  } as const;
  return reasons[turn.stop_reason];
};

const publicId = (id: string): string =>
  id.startsWith("chatcmpl-") ? id : `chatcmpl-${id.replace(/^msg_/, "")}`;

const toolCall = (call: NormalizedTurn["tool_calls"][number]): OpenAiToolCall => ({
  id: call.id,
  type: "function",
  function: {
    name: call.name,
    arguments: call.arguments_text ?? JSON.stringify(call.input),
  },
});

export const toOpenAiResponse = (
  turn: NormalizedTurn,
  public_model: string,
  visible_usage: TokenUsage,
): OpenAiPublicChatResponse => ({
  id: publicId(turn.id),
  object: "chat.completion",
  created: Math.floor(Date.now() / 1_000),
  model: public_model,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: turn.text,
        ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
        ...(turn.tool_calls.length > 0 ? { tool_calls: turn.tool_calls.map(toolCall) } : {}),
      },
      finish_reason: finishReason(turn),
    },
  ],
  usage: {
    prompt_tokens: visible_usage.input_tokens,
    completion_tokens: visible_usage.output_tokens,
    total_tokens: visible_usage.input_tokens + visible_usage.output_tokens,
  },
});

const chunk = (
  response: OpenAiPublicChatResponse,
  choices: unknown[],
  usage: OpenAiPublicChatResponse["usage"] | null = null,
): string =>
  `data: ${JSON.stringify({
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model,
    choices,
    usage,
  })}\n\n`;

export const encodeOpenAiStream = (response: OpenAiPublicChatResponse): string => {
  const choice = response.choices[0];
  if (!choice) {
    throw new Error("OpenAI response contained no choice");
  }
  const message = choice.message;
  const role = chunk(response, [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]);
  const reasoning = message.reasoning_content
    ? chunk(response, [{ index: 0, delta: { reasoning_content: message.reasoning_content }, finish_reason: null }])
    : "";
  const content = message.content
    ? chunk(response, [{ index: 0, delta: { content: message.content }, finish_reason: null }])
    : "";
  const tools = (message.tool_calls ?? [])
    .map((call, index) =>
      chunk(response, [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: call.type,
                function: call.function,
              },
            ],
          },
          finish_reason: null,
        },
      ]),
    )
    .join("");
  const finished = chunk(response, [{ index: 0, delta: {}, finish_reason: choice.finish_reason }]);
  const usage = chunk(response, [], response.usage);
  return `${role}${reasoning}${content}${tools}${finished}${usage}data: [DONE]\n\n`;
};
