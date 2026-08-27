import type { EndpointConfig } from "./config.ts";
import type { ChatCompletionClient, OpenAiChatRequest, OpenAiChatResponse } from "./types.ts";

export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly response_body: string;

  constructor(
    message: string,
    status: number,
    response_body: string,
  ) {
    super(message);
    this.name = "UpstreamHttpError";
    this.status = status;
    this.response_body = response_body;
  }
}

export type FetchImplementation = typeof fetch;

export class OpenAiClient implements ChatCompletionClient {
  readonly endpoint: EndpointConfig;
  readonly fetch_implementation: FetchImplementation;

  constructor(
    endpoint: EndpointConfig,
    fetch_implementation: FetchImplementation = fetch,
  ) {
    this.endpoint = endpoint;
    this.fetch_implementation = fetch_implementation;
  }

  async complete(request: OpenAiChatRequest, signal?: AbortSignal): Promise<OpenAiChatResponse> {
    const request_signal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.endpoint.timeout_ms)])
      : AbortSignal.timeout(this.endpoint.timeout_ms);
    const authorization = this.endpoint.api_key ? { authorization: `Bearer ${this.endpoint.api_key}` } : {};
    const response = await this.fetch_implementation(`${this.endpoint.base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authorization,
      },
      body: JSON.stringify(request),
      signal: request_signal,
    });

    if (!response.ok) {
      const response_body = (await response.text()).slice(0, 16_384);
      throw new UpstreamHttpError(
        `OpenAI-compatible endpoint returned HTTP ${response.status}`,
        response.status,
        response_body,
      );
    }

    return (await response.json()) as OpenAiChatResponse;
  }
}
