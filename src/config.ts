import type { CondensationProfile } from "./types.ts";
import type { ReasoningReplayMode } from "./reasoning_replay.ts";

export interface EndpointConfig {
  base_url: string;
  model: string;
  api_key?: string;
  timeout_ms: number;
}

export interface AppConfig {
  host: string;
  port: number;
  primary: EndpointConfig;
  condenser: EndpointConfig;
  primary_preserve_thinking: boolean;
  condensation_enabled: boolean;
  condensation_smoke_tag_enabled: boolean;
  condenser_enable_thinking: boolean;
  condenser_reasoning_effort: string;
  condenser_max_output_tokens: number;
  reasoning_replay_mode: ReasoningReplayMode;
  min_reasoning_tokens: number;
  profiles: Record<"completed_response" | "tool_continuation", CondensationProfile>;
  archive_path?: string;
  proxy_api_key?: string;
  estimated_characters_per_token: number;
  max_request_bytes: number;
}

const optional = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const numberValue = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
};

const booleanValue = (value: string | undefined, fallback: boolean): boolean => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined) {
    return fallback;
  }
  const values: Record<string, boolean> = {
    "1": true,
    true: true,
    yes: true,
    on: true,
    "0": false,
    false: false,
    no: false,
    off: false,
  };
  const parsed = values[normalized];
  if (parsed === undefined) {
    throw new Error(`Expected a boolean value, received ${value}`);
  }
  return parsed;
};

const ratioValue = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = numberValue(value, fallback, name);
  if (parsed > 1) {
    throw new Error(`${name} must not exceed 1`);
  }
  return parsed;
};

const baseUrl = (value: string): string => value.replace(/\/$/, "");

const reasoningReplayMode = (value: string | undefined): ReasoningReplayMode => {
  const normalized = value?.trim().toLowerCase() ?? "reasoning_content";
  const modes: Record<string, ReasoningReplayMode> = {
    reasoning_content: "reasoning_content",
    assistant_content: "assistant_content",
  };
  const mode = modes[normalized];
  if (mode === undefined) {
    throw new Error(`UPSTREAM_REASONING_REPLAY_MODE must be reasoning_content or assistant_content`);
  }
  return mode;
};

const endpointConfig = (
  base_url_value: string,
  model: string,
  api_key_value: string | undefined,
  timeout_ms: number,
): EndpointConfig => {
  const api_key = optional(api_key_value);
  return {
    base_url: baseUrl(base_url_value),
    model,
    timeout_ms,
    ...(api_key ? { api_key } : {}),
  };
};

export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => {
  const archive_path = optional(environment.ARCHIVE_PATH);
  const proxy_api_key = optional(environment.PROXY_API_KEY);
  return {
    host: environment.HOST ?? "127.0.0.1",
    port: numberValue(environment.PORT, 3456, "PORT"),
    primary: endpointConfig(
      environment.PRIMARY_BASE_URL ?? "http://127.0.0.1:8080/v1",
      environment.PRIMARY_MODEL ?? "reasoning-model",
      environment.PRIMARY_API_KEY,
      numberValue(environment.PRIMARY_TIMEOUT_MS, 900_000, "PRIMARY_TIMEOUT_MS"),
    ),
    condenser: endpointConfig(
      environment.CONDENSER_BASE_URL ?? "http://127.0.0.1:8081/v1",
      environment.CONDENSER_MODEL ?? "condensation-model",
      environment.CONDENSER_API_KEY,
      numberValue(environment.CONDENSER_TIMEOUT_MS, 180_000, "CONDENSER_TIMEOUT_MS"),
    ),
    primary_preserve_thinking: booleanValue(environment.PRIMARY_PRESERVE_THINKING, true),
    condensation_enabled: booleanValue(environment.CONDENSATION_ENABLED, true),
    condensation_smoke_tag_enabled: booleanValue(environment.CONDENSATION_SMOKE_TAG_ENABLED, false),
    condenser_enable_thinking: booleanValue(environment.CONDENSER_ENABLE_THINKING, true),
    condenser_reasoning_effort: environment.CONDENSER_REASONING_EFFORT ?? "low",
    condenser_max_output_tokens: numberValue(
      environment.CONDENSER_MAX_OUTPUT_TOKENS,
      4_096,
      "CONDENSER_MAX_OUTPUT_TOKENS",
    ),
    reasoning_replay_mode: reasoningReplayMode(environment.UPSTREAM_REASONING_REPLAY_MODE),
    min_reasoning_tokens: numberValue(
      environment.CONDENSE_MIN_REASONING_TOKENS,
      512,
      "CONDENSE_MIN_REASONING_TOKENS",
    ),
    profiles: {
      completed_response: {
        name: "completed_response",
        max_tokens: numberValue(
          environment.CONDENSE_COMPLETED_MAX_TOKENS,
          768,
          "CONDENSE_COMPLETED_MAX_TOKENS",
        ),
        target_ratio: ratioValue(environment.CONDENSE_COMPLETED_RATIO, 0.15, "CONDENSE_COMPLETED_RATIO"),
      },
      tool_continuation: {
        name: "tool_continuation",
        max_tokens: numberValue(environment.CONDENSE_TOOL_MAX_TOKENS, 1_200, "CONDENSE_TOOL_MAX_TOKENS"),
        target_ratio: ratioValue(environment.CONDENSE_TOOL_RATIO, 0.35, "CONDENSE_TOOL_RATIO"),
      },
    },
    ...(archive_path ? { archive_path } : {}),
    ...(proxy_api_key ? { proxy_api_key } : {}),
    estimated_characters_per_token: numberValue(
      environment.ESTIMATED_CHARACTERS_PER_TOKEN,
      3.5,
      "ESTIMATED_CHARACTERS_PER_TOKEN",
    ),
    max_request_bytes: numberValue(environment.MAX_REQUEST_BYTES, 10_485_760, "MAX_REQUEST_BYTES"),
  };
};
