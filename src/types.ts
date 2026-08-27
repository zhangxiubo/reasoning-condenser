export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: JsonObject;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: string;
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface AnthropicUnknownBlock {
  type: string;
  [key: string]: unknown;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: JsonObject;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicTool[];
  tool_choice?:
    | { type: "auto" | "any" | "none"; disable_parallel_tool_use?: boolean }
    | { type: "tool"; name: string; disable_parallel_tool_use?: boolean };
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  metadata?: JsonObject;
  thinking?: JsonObject;
}

export type AnthropicTokenCountRequest = Omit<AnthropicMessagesRequest, "max_tokens" | "stream"> & {
  max_tokens?: number;
};

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAiChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | JsonValue[] | null;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_text?: string;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface OpenAiChatRequest {
  model: string;
  messages: OpenAiChatMessage[];
  stream: false;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: JsonObject;
    };
  }>;
  tool_choice?: JsonValue;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  response_format?: JsonValue;
  chat_template_kwargs?: JsonObject;
  seed?: number;
  top_k?: number;
  [key: string]: unknown;
}

export interface OpenAiClientChatRequest {
  model: string;
  messages: OpenAiChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface OpenAiChatResponse {
  id?: string;
  model?: string;
  choices: Array<{
    index?: number;
    message: {
      role?: "assistant";
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      thinking?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface OpenAiPublicChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string;
      reasoning_content?: string;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason: "stop" | "length" | "tool_calls";
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: JsonObject;
  arguments_text?: string;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";

export interface NormalizedTurn {
  id: string;
  model: string;
  reasoning: string;
  text: string;
  tool_calls: ToolCall[];
  stop_reason: StopReason;
  upstream_usage: TokenUsage;
}

export type CondensationProfileName = "completed_response" | "tool_continuation";

export interface CondensationProfile {
  name: CondensationProfileName;
  max_tokens: number;
  target_ratio: number;
}

export type CondensationStatus = "condensed" | "disabled" | "below_threshold" | "failed" | "rejected";

export interface CondensationOutcome {
  turn: NormalizedTurn;
  status: CondensationStatus;
  profile?: CondensationProfileName;
  original_reasoning_tokens: number;
  delivered_reasoning_tokens: number;
  error?: string;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<AnthropicThinkingBlock | AnthropicTextBlock | AnthropicToolUseBlock>;
  model: string;
  stop_reason: StopReason;
  stop_sequence: string | null;
  usage: TokenUsage;
}

export interface ChatCompletionClient {
  complete(request: OpenAiChatRequest, signal?: AbortSignal): Promise<OpenAiChatResponse>;
}
