import type { AppConfig } from "../src/config.ts";
import type { ChatCompletionClient, OpenAiChatRequest, OpenAiChatResponse } from "../src/types.ts";

export const testConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  host: "127.0.0.1",
  port: 3456,
  primary: {
    base_url: "http://primary.test/v1",
    model: "primary-model",
    timeout_ms: 10_000,
  },
  condenser: {
    base_url: "http://condenser.test/v1",
    model: "condenser-model",
    timeout_ms: 10_000,
  },
  primary_preserve_thinking: true,
  condensation_enabled: true,
  condensation_smoke_tag_enabled: false,
  condenser_enable_thinking: true,
  condenser_reasoning_effort: "low",
  condenser_max_output_tokens: 4_096,
  reasoning_replay_mode: "reasoning_content",
  min_reasoning_tokens: 10,
  profiles: {
    completed_response: { name: "completed_response", max_tokens: 100, target_ratio: 0.25 },
    tool_continuation: { name: "tool_continuation", max_tokens: 200, target_ratio: 0.5 },
  },
  estimated_characters_per_token: 1,
  max_request_bytes: 1_000_000,
  ...overrides,
});

export class FakeChatClient implements ChatCompletionClient {
  readonly requests: OpenAiChatRequest[] = [];
  readonly response: OpenAiChatResponse | Error;

  constructor(response: OpenAiChatResponse | Error) {
    this.response = response;
  }

  async complete(request: OpenAiChatRequest): Promise<OpenAiChatResponse> {
    this.requests.push(request);
    if (this.response instanceof Error) {
      throw this.response;
    }
    return structuredClone(this.response);
  }
}

export const silentLogger = {
  info: (): void => {},
  error: (): void => {},
};
