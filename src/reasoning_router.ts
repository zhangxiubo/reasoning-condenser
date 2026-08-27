import type { AppConfig } from "./config.ts";
import { toOpenAiRequest } from "./anthropic_request.ts";
import { toAnthropicResponse } from "./anthropic_response.ts";
import { normalizeOpenAiResponse } from "./normalized_turn.ts";
import { prepareOpenAiRequest } from "./openai_request.ts";
import { toOpenAiResponse } from "./openai_response.ts";
import { applyReasoningReplay } from "./reasoning_replay.ts";
import type { TurnArchive } from "./archive.ts";
import type { Logger } from "./logger.ts";
import type { ReasoningCondenser } from "./condensation.ts";
import type { TokenEstimator } from "./token_estimator.ts";
import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicTokenCountRequest,
  ChatCompletionClient,
  CondensationOutcome,
  NormalizedTurn,
  OpenAiChatRequest,
  OpenAiClientChatRequest,
  OpenAiPublicChatResponse,
} from "./types.ts";

export interface ReasoningRouterResult {
  response: AnthropicMessagesResponse;
  condensation: CondensationOutcome;
}

export interface OpenAiReasoningRouterResult {
  response: OpenAiPublicChatResponse;
  condensation: CondensationOutcome;
}

interface ProcessedTurn {
  original_turn: NormalizedTurn;
  condensation: CondensationOutcome;
}

export class ReasoningRouter {
  readonly config: AppConfig;
  readonly primary_client: ChatCompletionClient;
  readonly condenser: ReasoningCondenser;
  readonly archive: TurnArchive;
  readonly token_estimator: TokenEstimator;
  readonly logger: Logger;

  constructor(
    config: AppConfig,
    primary_client: ChatCompletionClient,
    condenser: ReasoningCondenser,
    archive: TurnArchive,
    token_estimator: TokenEstimator,
    logger: Logger,
  ) {
    this.config = config;
    this.primary_client = primary_client;
    this.condenser = condenser;
    this.archive = archive;
    this.token_estimator = token_estimator;
    this.logger = logger;
  }

  async route(request: AnthropicMessagesRequest, signal?: AbortSignal): Promise<ReasoningRouterResult> {
    const primary_request = toOpenAiRequest(
      request,
      this.config.primary.model,
      this.config.primary_preserve_thinking,
    );
    const { original_turn, condensation } = await this.processTurn(primary_request, request.model, signal);
    const initial_response = toAnthropicResponse(condensation.turn, request.model, {
      input_tokens: original_turn.upstream_usage.input_tokens,
      output_tokens: 0,
    });
    const visible_output_tokens = this.token_estimator.estimateResponse(initial_response);
    const response = {
      ...initial_response,
      usage: {
        input_tokens: original_turn.upstream_usage.input_tokens,
        output_tokens: visible_output_tokens,
      },
    };

    this.logCompletedTurn(response.id, request.model, original_turn, condensation, visible_output_tokens);

    return { response, condensation };
  }

  async routeOpenAi(
    request: OpenAiClientChatRequest,
    signal?: AbortSignal,
  ): Promise<OpenAiReasoningRouterResult> {
    const primary_request = prepareOpenAiRequest(
      request,
      this.config.primary.model,
      this.config.primary_preserve_thinking,
    );
    const { original_turn, condensation } = await this.processTurn(primary_request, request.model, signal);
    const initial_response = toOpenAiResponse(condensation.turn, request.model, {
      input_tokens: original_turn.upstream_usage.input_tokens,
      output_tokens: 0,
    });
    const visible_output_tokens = this.token_estimator.estimate(
      JSON.stringify(initial_response.choices[0]?.message ?? {}),
    );
    const response = toOpenAiResponse(condensation.turn, request.model, {
      input_tokens: original_turn.upstream_usage.input_tokens,
      output_tokens: visible_output_tokens,
    });
    this.logCompletedTurn(response.id, request.model, original_turn, condensation, visible_output_tokens);
    return { response, condensation };
  }

  countInputTokens(request: AnthropicTokenCountRequest): number {
    const converted = toOpenAiRequest(
      { ...request, max_tokens: request.max_tokens ?? 1 },
      this.config.primary.model,
      this.config.primary_preserve_thinking,
    );
    const replayed = applyReasoningReplay(converted, this.config.reasoning_replay_mode);
    return Math.max(
      1,
      this.token_estimator.estimate(
        JSON.stringify({ messages: replayed.messages, tools: replayed.tools ?? [] }),
      ),
    );
  }

  private async processTurn(
    primary_request: OpenAiChatRequest,
    public_model: string,
    signal?: AbortSignal,
  ): Promise<ProcessedTurn> {
    const replayed_request = applyReasoningReplay(primary_request, this.config.reasoning_replay_mode);
    const primary_response = await this.primary_client.complete(replayed_request, signal);
    const original_turn = normalizeOpenAiResponse(primary_response, this.config.primary.model);
    try {
      await this.archive.append({
        recorded_at: new Date().toISOString(),
        public_model,
        turn: original_turn,
      });
    } catch (error) {
      this.logger.error("archive_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    const condensation = await this.condenser.condense(original_turn, signal);
    return { original_turn, condensation };
  }

  private logCompletedTurn(
    message_id: string,
    requested_model: string,
    original_turn: NormalizedTurn,
    condensation: CondensationOutcome,
    visible_output_tokens: number,
  ): void {
    this.logger.info("turn_completed", {
      message_id,
      requested_model,
      upstream_model: original_turn.model,
      condensation_status: condensation.status,
      condensation_profile: condensation.profile,
      original_reasoning_tokens: condensation.original_reasoning_tokens,
      delivered_reasoning_tokens: condensation.delivered_reasoning_tokens,
      upstream_input_tokens: original_turn.upstream_usage.input_tokens,
      upstream_output_tokens: original_turn.upstream_usage.output_tokens,
      visible_output_tokens,
      condensation_error: condensation.error,
    });
  }
}
