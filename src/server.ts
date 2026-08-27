import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { encodeAnthropicStream } from "./anthropic_response.ts";
import { InvalidOpenAiRequest } from "./openai_request.ts";
import { encodeOpenAiStream } from "./openai_response.ts";
import { InvalidUpstreamResponse } from "./normalized_turn.ts";
import { UpstreamHttpError } from "./openai_client.ts";
import type { AppConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type {
  OpenAiReasoningRouterResult,
  ReasoningRouter,
  ReasoningRouterResult,
} from "./reasoning_router.ts";
import type { AnthropicMessagesRequest } from "./types.ts";
import type { AnthropicTokenCountRequest } from "./types.ts";
import type { CondensationOutcome, OpenAiClientChatRequest } from "./types.ts";

class HttpRequestError extends Error {
  readonly status: number;

  constructor(
    message: string,
    status: number,
  ) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
  }
}

const jsonResponse = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

const errorResponse = (response: ServerResponse, status: number, type: string, message: string): void =>
  jsonResponse(response, status, { type: "error", error: { type, message } });

const openAiErrorResponse = (response: ServerResponse, status: number, type: string, message: string): void =>
  jsonResponse(response, status, { error: { message, type, param: null, code: null } });

const readBody = async (request: IncomingMessage, max_bytes: number): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > max_bytes) {
      throw new HttpRequestError(`Request exceeds ${max_bytes} bytes`, 413);
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new HttpRequestError(`Request body is not valid JSON: ${String(error)}`, 400);
  }
};

const isMessagesRequest = (value: unknown): value is AnthropicMessagesRequest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<AnthropicMessagesRequest>;
  return (
    typeof candidate.model === "string" &&
    typeof candidate.max_tokens === "number" &&
    Array.isArray(candidate.messages)
  );
};

const isTokenCountRequest = (value: unknown): value is AnthropicTokenCountRequest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<AnthropicTokenCountRequest>;
  return typeof candidate.model === "string" && Array.isArray(candidate.messages);
};

const isOpenAiChatRequest = (value: unknown): value is OpenAiClientChatRequest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<OpenAiClientChatRequest>;
  return typeof candidate.model === "string" && Array.isArray(candidate.messages);
};

const secureEqual = (left: string, right: string): boolean => {
  const left_buffer = Buffer.from(left);
  const right_buffer = Buffer.from(right);
  return left_buffer.length === right_buffer.length && timingSafeEqual(left_buffer, right_buffer);
};

const suppliedApiKey = (request: IncomingMessage): string | undefined => {
  const explicit = request.headers["x-api-key"];
  if (typeof explicit === "string") {
    return explicit;
  }
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
};

const authorized = (request: IncomingMessage, expected: string | undefined): boolean =>
  expected === undefined || secureEqual(suppliedApiKey(request) ?? "", expected);

const metricHeaders = (
  condensation: CondensationOutcome,
  visible_output_tokens: number,
): Record<string, string> => ({
  "x-rcr-condensation-status": condensation.status,
  "x-rcr-reasoning-original-tokens": String(condensation.original_reasoning_tokens),
  "x-rcr-reasoning-delivered-tokens": String(condensation.delivered_reasoning_tokens),
  "x-rcr-upstream-input-tokens": String(condensation.turn.upstream_usage.input_tokens),
  "x-rcr-upstream-output-tokens": String(condensation.turn.upstream_usage.output_tokens),
  "x-rcr-visible-output-tokens": String(visible_output_tokens),
});

const sendMessagesResponse = (
  response: ServerResponse,
  request: AnthropicMessagesRequest,
  result: ReasoningRouterResult,
): void => {
  const metrics = metricHeaders(result.condensation, result.response.usage.output_tokens);
  if (!request.stream) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", ...metrics });
    response.end(JSON.stringify(result.response));
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...metrics,
  });
  response.end(encodeAnthropicStream(result.response));
};

const sendOpenAiResponse = (
  response: ServerResponse,
  request: OpenAiClientChatRequest,
  result: OpenAiReasoningRouterResult,
): void => {
  const metrics = metricHeaders(result.condensation, result.response.usage.completion_tokens);
  if (!request.stream) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", ...metrics });
    response.end(JSON.stringify(result.response));
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...metrics,
  });
  response.end(encodeOpenAiStream(result.response));
};

const routeError = (error: unknown): { status: number; type: string; message: string } => {
  if (error instanceof HttpRequestError) {
    return { status: error.status, type: "invalid_request_error", message: error.message };
  }
  if (error instanceof UpstreamHttpError) {
    return { status: 502, type: "api_error", message: error.message };
  }
  if (error instanceof InvalidUpstreamResponse) {
    return { status: 502, type: "api_error", message: error.message };
  }
  if (error instanceof InvalidOpenAiRequest) {
    return { status: 400, type: "invalid_request_error", message: error.message };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { status: 499, type: "request_aborted", message: "Request was aborted" };
  }
  return {
    status: 500,
    type: "api_error",
    message: error instanceof Error ? error.message : String(error),
  };
};

export const createAppServer = (config: AppConfig, router: ReasoningRouter, logger: Logger): Server =>
  createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (method === "GET" && url.pathname === "/health") {
      jsonResponse(response, 200, {
        status: "ok",
        primary_model: config.primary.model,
        condenser_model: config.condenser.model,
        condensation_enabled: config.condensation_enabled,
        condensation_smoke_tag_enabled: config.condensation_smoke_tag_enabled,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/v1/models") {
      jsonResponse(response, 200, {
        object: "list",
        data: [
          {
            id: config.primary.model,
            object: "model",
            created: 0,
            owned_by: "reasoning-condenser",
          },
        ],
      });
      return;
    }

    const is_messages_path = url.pathname === "/v1/messages";
    const is_token_count_path = url.pathname === "/v1/messages/count_tokens";
    const is_openai_chat_path = url.pathname === "/v1/chat/completions";
    if (method !== "POST" || (!is_messages_path && !is_token_count_path && !is_openai_chat_path)) {
      errorResponse(response, 404, "not_found_error", "Route not found");
      return;
    }

    if (!authorized(request, config.proxy_api_key)) {
      const send_error = is_openai_chat_path ? openAiErrorResponse : errorResponse;
      send_error(response, 401, "authentication_error", "Invalid API key");
      return;
    }

    const cancellation = new AbortController();
    request.once("aborted", () => cancellation.abort());
    response.once("close", () => {
      if (!response.writableEnded) {
        cancellation.abort();
      }
    });

    try {
      const body = await readBody(request, config.max_request_bytes);
      if (is_token_count_path) {
        if (!isTokenCountRequest(body)) {
          throw new HttpRequestError("Expected model and messages", 400);
        }
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "x-rcr-token-count-estimated": "true",
        });
        response.end(JSON.stringify({ input_tokens: router.countInputTokens(body) }));
        return;
      }
      if (is_openai_chat_path) {
        if (!isOpenAiChatRequest(body)) {
          throw new HttpRequestError("Expected model and messages", 400);
        }
        const result = await router.routeOpenAi(body, cancellation.signal);
        sendOpenAiResponse(response, body, result);
        return;
      }
      if (!isMessagesRequest(body)) {
        throw new HttpRequestError("Expected model, max_tokens, and messages", 400);
      }
      const result = await router.route(body, cancellation.signal);
      sendMessagesResponse(response, body, result);
    } catch (error) {
      const routed = routeError(error);
      logger.error("request_failed", {
        method,
        path: url.pathname,
        status: routed.status,
        error: routed.message,
        upstream_body: error instanceof UpstreamHttpError ? error.response_body : undefined,
      });
      if (!response.headersSent) {
        const send_error = is_openai_chat_path ? openAiErrorResponse : errorResponse;
        send_error(response, routed.status, routed.type, routed.message);
      } else {
        response.destroy();
      }
    }
  });
