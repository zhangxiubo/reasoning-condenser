import type { OpenAiChatMessage, OpenAiChatRequest, OpenAiClientChatRequest } from "./types.ts";

export class InvalidOpenAiRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOpenAiRequest";
  }
}

const canonicalReasoning = (message: OpenAiChatMessage): OpenAiChatMessage => {
  if (message.role !== "assistant") {
    return message;
  }
  const { reasoning, reasoning_text, ...canonical } = message;
  const reasoning_content = canonical.reasoning_content ?? reasoning ?? reasoning_text;
  return reasoning_content === undefined ? canonical : { ...canonical, reasoning_content };
};

const chatTemplateKwargs = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export const prepareOpenAiRequest = (
  request: OpenAiClientChatRequest,
  model: string,
  preserve_thinking = true,
): OpenAiChatRequest => {
  if (request.messages.length === 0) {
    throw new InvalidOpenAiRequest("messages must contain at least one message");
  }
  if (typeof request.n === "number" && request.n !== 1) {
    throw new InvalidOpenAiRequest("Only one completion choice is supported");
  }

  const {
    stream: requested_stream,
    stream_options,
    model: requested_model,
    messages,
    chat_template_kwargs: requested_chat_template_kwargs,
    ...forwarded
  } = request;
  void requested_stream;
  void stream_options;
  void requested_model;
  return {
    ...forwarded,
    model,
    messages: messages.map(canonicalReasoning),
    stream: false,
    ...(preserve_thinking || requested_chat_template_kwargs
      ? {
          chat_template_kwargs: {
            ...(preserve_thinking ? { preserve_thinking: true } : {}),
            ...chatTemplateKwargs(requested_chat_template_kwargs),
          },
        }
      : {}),
  } as OpenAiChatRequest;
};
