import type { AppConfig } from "./config.ts";
import type { TokenEstimator } from "./token_estimator.ts";
import type {
  ChatCompletionClient,
  CondensationOutcome,
  CondensationProfile,
  CondensationStatus,
  NormalizedTurn,
  OpenAiChatRequest,
} from "./types.ts";

interface CondenseDecision {
  action: "condense";
  profile: CondensationProfile;
  replacement_token_budget: number;
  original_tokens: number;
}

interface SkipDecision {
  action: "skip";
  status: Extract<CondensationStatus, "disabled" | "below_threshold">;
  original_tokens: number;
}

type CondensationDecision = CondenseDecision | SkipDecision;

const profileInstructions: Record<CondensationProfile["name"], string> = {
  completed_response:
    "The final response is available to future turns. Remove reasoning already expressed there. Retain only working state likely to matter later.",
  tool_continuation:
    "A tool call follows this reasoning. Preserve the immediate objective, exact identifiers and paths, observations that justify the call, unresolved errors, and the intended use of the result.",
};

export class ReasoningCondensationPolicy {
  readonly config: AppConfig;
  readonly token_estimator: TokenEstimator;

  constructor(
    config: AppConfig,
    token_estimator: TokenEstimator,
  ) {
    this.config = config;
    this.token_estimator = token_estimator;
  }

  select(turn: NormalizedTurn): CondensationDecision {
    const original_tokens = this.token_estimator.estimate(turn.reasoning);
    if (!this.config.condensation_enabled) {
      return { action: "skip", status: "disabled", original_tokens };
    }
    if (original_tokens < this.config.min_reasoning_tokens) {
      return { action: "skip", status: "below_threshold", original_tokens };
    }

    const profile_name = turn.tool_calls.length > 0 ? "tool_continuation" : "completed_response";
    const profile = this.config.profiles[profile_name];
    const proportional_budget = Math.max(1, Math.floor(original_tokens * profile.target_ratio));
    return {
      action: "condense",
      profile,
      replacement_token_budget: Math.min(profile.max_tokens, proportional_budget),
      original_tokens,
    };
  }
}

const systemPrompt = `You compress an exposed model reasoning trace so it can be used as working state in later coding-agent turns.

Return one JSON object with exactly one string property named "reasoning".

Requirements:
- Preserve established facts that are not already clear from the final response.
- Preserve decisions and the reasons that future work may need.
- Preserve exact file paths, identifiers, commands, constraints, errors, and unresolved questions.
- Preserve the immediate next action when the turn invokes a tool.
- Remove exploration, repetition, self-talk, rejected ideas that no longer matter, and facts already represented by the final response.
- Do not introduce any fact, conclusion, action, tool call, identifier, or result.
- Do not modify or reproduce tool-call JSON.
- Keep the reasoning value within replacement_reasoning_token_budget. Prefer one compact sentence when it is sufficient.
- Write compact plain text inside the JSON property. Do not use Markdown fences.`;

const condenserRequest = (
  turn: NormalizedTurn,
  profile: CondensationProfile,
  replacement_token_budget: number,
  max_output_tokens: number,
  model: string,
  reasoning_effort: string,
  enable_thinking: boolean,
): OpenAiChatRequest => ({
  model,
  stream: false,
  max_tokens: max_output_tokens,
  temperature: 0,
  reasoning_effort,
  chat_template_kwargs: { enable_thinking },
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: JSON.stringify({
        policy: profileInstructions[profile.name],
        replacement_reasoning_token_budget: replacement_token_budget,
        original_reasoning: turn.reasoning,
        final_response: turn.text,
        tool_calls: turn.tool_calls.map(({ id, name, input }) => ({ id, name, input })),
      }),
    },
  ],
});

const parseCondensedReasoning = (content: string | null | undefined): string => {
  if (!content) {
    throw new Error("Condenser returned no final content");
  }
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("reasoning" in parsed)) {
    throw new Error("Condenser response did not contain a reasoning property");
  }
  const reasoning = (parsed as { reasoning?: unknown }).reasoning;
  if (typeof reasoning !== "string" || reasoning.trim() === "") {
    throw new Error("Condenser returned empty reasoning");
  }
  return reasoning.trim();
};

const smokeTaggedReasoning = (
  reasoning: string,
  original_tokens: number,
  token_estimator: TokenEstimator,
): string => {
  const resolve = (delivered_tokens: number, attempts_remaining: number): string => {
    const tagged = `[RCR condensed ${original_tokens}→${delivered_tokens}]\n${reasoning}`;
    const estimated_tokens = token_estimator.estimate(tagged);
    return estimated_tokens === delivered_tokens || attempts_remaining === 0
      ? tagged
      : resolve(estimated_tokens, attempts_remaining - 1);
  };
  return resolve(token_estimator.estimate(reasoning), 8);
};

export class ReasoningCondenser {
  readonly config: AppConfig;
  readonly client: ChatCompletionClient;
  readonly policy: ReasoningCondensationPolicy;
  readonly token_estimator: TokenEstimator;

  constructor(
    config: AppConfig,
    client: ChatCompletionClient,
    policy: ReasoningCondensationPolicy,
    token_estimator: TokenEstimator,
  ) {
    this.config = config;
    this.client = client;
    this.policy = policy;
    this.token_estimator = token_estimator;
  }

  async condense(turn: NormalizedTurn, signal?: AbortSignal): Promise<CondensationOutcome> {
    const decision = this.policy.select(turn);
    if (decision.action === "skip") {
      return {
        turn,
        status: decision.status,
        original_reasoning_tokens: decision.original_tokens,
        delivered_reasoning_tokens: decision.original_tokens,
      };
    }

    try {
      const request = condenserRequest(
        turn,
        decision.profile,
        decision.replacement_token_budget,
        this.config.condenser_max_output_tokens,
        this.config.condenser.model,
        this.config.condenser_reasoning_effort,
        this.config.condenser_enable_thinking,
      );
      const response = await this.client.complete(request, signal);
      const condensed_reasoning = parseCondensedReasoning(response.choices.at(0)?.message.content);
      const delivered_reasoning = this.config.condensation_smoke_tag_enabled
        ? smokeTaggedReasoning(condensed_reasoning, decision.original_tokens, this.token_estimator)
        : condensed_reasoning;
      const delivered_tokens = this.token_estimator.estimate(delivered_reasoning);
      if (delivered_tokens >= decision.original_tokens) {
        return {
          turn,
          status: "rejected",
          profile: decision.profile.name,
          original_reasoning_tokens: decision.original_tokens,
          delivered_reasoning_tokens: decision.original_tokens,
          error: "Condensed reasoning was not smaller than the original",
        };
      }
      return {
        turn: { ...turn, reasoning: delivered_reasoning },
        status: "condensed",
        profile: decision.profile.name,
        original_reasoning_tokens: decision.original_tokens,
        delivered_reasoning_tokens: delivered_tokens,
      };
    } catch (error) {
      return {
        turn,
        status: "failed",
        profile: decision.profile.name,
        original_reasoning_tokens: decision.original_tokens,
        delivered_reasoning_tokens: decision.original_tokens,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
