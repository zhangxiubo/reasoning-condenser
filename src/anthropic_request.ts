import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  JsonValue,
  OpenAiChatMessage,
  OpenAiChatRequest,
  OpenAiToolCall,
} from "./types.ts";

const blockText = (block: AnthropicContentBlock): string => {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "thinking":
      return "";
    case "image": {
      const media_type = typeof block.source === "object" && block.source ? block.source.media_type : undefined;
      return `[image omitted by text-only route${media_type ? `: ${media_type}` : ""}]`;
    }
    case "tool_use":
    case "tool_result":
      return "";
    default:
      return "";
  }
};

const renderContent = (content: string | AnthropicContentBlock[] | undefined): string => {
  if (typeof content === "string") {
    return content;
  }
  return (content ?? []).map(blockText).filter(Boolean).join("\n");
};

const toolResultMessage = (block: AnthropicToolResultBlock): OpenAiChatMessage => {
  const rendered = renderContent(block.content);
  return {
    role: "tool",
    tool_call_id: block.tool_use_id,
    content: block.is_error ? `[tool_error]\n${rendered}` : rendered,
  };
};

const userBlockMessage = (block: AnthropicContentBlock): OpenAiChatMessage => ({
  role: "user",
  content: blockText(block),
});

const coalesceUserMessages = (messages: OpenAiChatMessage[]): OpenAiChatMessage[] =>
  messages.reduce<OpenAiChatMessage[]>((collected, message) => {
    const previous = collected.at(-1);
    const can_merge = previous?.role === "user" && message.role === "user";
    if (!can_merge) {
      return [...collected, message];
    }
    const merged: OpenAiChatMessage = {
      role: "user",
      content: [previous.content, message.content].filter(Boolean).join("\n"),
    };
    return [...collected.slice(0, -1), merged];
  }, []);

const userMessage = (message: AnthropicMessage): OpenAiChatMessage[] => {
  if (typeof message.content === "string") {
    return [{ role: "user", content: message.content }];
  }
  const fragments = message.content.map((block) =>
    block.type === "tool_result"
      ? toolResultMessage(block as AnthropicToolResultBlock)
      : userBlockMessage(block),
  );
  return coalesceUserMessages(fragments).filter((fragment) => fragment.role === "tool" || fragment.content !== "");
};

const assistantMessage = (message: AnthropicMessage): OpenAiChatMessage => {
  if (typeof message.content === "string") {
    return { role: "assistant", content: message.content };
  }

  const reasoning_content = message.content
    .filter((block): block is AnthropicThinkingBlock => block.type === "thinking")
    .map((block) => String(block.thinking))
    .join("\n");
  const content = message.content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => String(block.text))
    .join("\n");
  const tool_calls = message.content
    .filter((block): block is AnthropicToolUseBlock => block.type === "tool_use")
    .map<OpenAiToolCall>((block) => ({
      id: String(block.id),
      type: "function",
      function: {
        name: String(block.name),
        arguments: JSON.stringify(block.input ?? {}),
      },
    }));

  return {
    role: "assistant",
    content: content || null,
    ...(reasoning_content ? { reasoning_content } : {}),
    ...(tool_calls.length > 0 ? { tool_calls } : {}),
  };
};

const messageConversion = (message: AnthropicMessage): OpenAiChatMessage[] =>
  message.role === "assistant" ? [assistantMessage(message)] : userMessage(message);

const systemMessage = (request: AnthropicMessagesRequest): OpenAiChatMessage[] => {
  const content = renderContent(request.system);
  return content ? [{ role: "system", content }] : [];
};

const toolChoice = (request: AnthropicMessagesRequest): JsonValue | undefined => {
  switch (request.tool_choice?.type) {
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return {
        type: "function",
        function: { name: request.tool_choice.name },
      };
    case "auto":
      return "auto";
    default:
      return undefined;
  }
};

export const toOpenAiRequest = (
  request: AnthropicMessagesRequest,
  model: string,
  preserve_thinking = true,
): OpenAiChatRequest => {
  const tools = request.tools?.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema,
    },
  }));
  const tool_choice = toolChoice(request);
  const disable_parallel_tool_use = request.tool_choice?.disable_parallel_tool_use;

  return {
    model,
    messages: [...systemMessage(request), ...request.messages.flatMap(messageConversion)],
    stream: false,
    ...(preserve_thinking ? { chat_template_kwargs: { preserve_thinking: true } } : {}),
    max_tokens: request.max_tokens,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { top_p: request.top_p }),
    ...(request.stop_sequences ? { stop: request.stop_sequences } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(tool_choice === undefined ? {} : { tool_choice }),
    ...(disable_parallel_tool_use === undefined ? {} : { parallel_tool_calls: !disable_parallel_tool_use }),
  };
};
