import { createHash } from "node:crypto";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  OpenAiChatMessage,
  OpenAiClientChatRequest,
} from "./types.ts";

/** One assistant tool-call message plus the tool results that answered it. */
export interface HistoryTurn {
  /** Tool names only. */
  tool_sig: string;
  /** Tool names with their arguments. */
  call_sig: string;
  /** Tool result contents. */
  result_sig: string;
}

export interface NormalizedHistory {
  /** Stable identity used to accumulate escalation state. */
  conversation_id: string;
  /** Trailing turns, oldest first, bounded by the requested limit. */
  turns: HistoryTurn[];
  /** True when the history ends on tool results, so the model is choosing its next action. */
  awaiting_tool_decision: boolean;
}

/**
 * How one client message counts when locating a trailing run.
 *
 *   calls     an assistant message requesting tools
 *   results   the tool results answering the preceding calls
 *   boundary  a human turn or a plain assistant answer; the run stops here
 *   metadata  session or client bookkeeping; skipped without ending the run
 */
type Classified =
  | { kind: "calls"; names: string[]; parts: Array<[string, string]> }
  | { kind: "results"; contents: unknown[] }
  | { kind: "boundary" }
  | { kind: "metadata" };

const METADATA: Classified = { kind: "metadata" };
const BOUNDARY: Classified = { kind: "boundary" };

const blocksOf = (content: AnthropicMessage["content"]): AnthropicContentBlock[] =>
  Array.isArray(content) ? content : [];

const classifyAnthropic = (message: AnthropicMessage): Classified => {
  if (message.role === "system") {
    return METADATA;
  }
  const blocks = blocksOf(message.content);
  if (message.role === "assistant") {
    const uses = blocks.filter((block): block is AnthropicToolUseBlock => block.type === "tool_use");
    return uses.length === 0
      ? BOUNDARY
      : {
          kind: "calls",
          names: uses.map((use) => String(use.name)),
          parts: uses.map((use) => [String(use.name), JSON.stringify(use.input ?? {})]),
        };
  }
  const results = blocks.filter(
    (block): block is AnthropicToolResultBlock => block.type === "tool_result",
  );
  return results.length === 0
    ? BOUNDARY
    : { kind: "results", contents: results.map((result) => result.content) };
};

const classifyOpenAi = (message: OpenAiChatMessage): Classified => {
  if (message.role === "system" || message.role === "developer") {
    return METADATA;
  }
  if (message.role === "tool") {
    return { kind: "results", contents: [message.content] };
  }
  if (message.role !== "assistant") {
    return BOUNDARY;
  }
  const calls = message.tool_calls ?? [];
  return calls.length === 0
    ? BOUNDARY
    : {
        kind: "calls",
        names: calls.map((call) => call?.function?.name ?? ""),
        parts: calls.map((call) => [call?.function?.name ?? "", call?.function?.arguments ?? ""]),
      };
};

/**
 * Walks backwards from the end so cost depends on the turn limit rather than
 * on how much history has accumulated. Metadata is stepped over; a boundary
 * stops the walk.
 */
const trailingTurns = <T>(
  messages: T[],
  classify: (message: T) => Classified,
  turn_limit: number,
): { turns: HistoryTurn[]; awaiting_tool_decision: boolean } => {
  const turns: HistoryTurn[] = [];
  let pending: unknown[] = [];
  let awaiting_tool_decision = false;
  let seen_conversation_message = false;

  for (let index = messages.length - 1; index >= 0 && turns.length < turn_limit; index -= 1) {
    const item = classify(messages[index]!);
    if (item.kind === "metadata") {
      continue;
    }
    if (!seen_conversation_message) {
      awaiting_tool_decision = item.kind === "results";
      seen_conversation_message = true;
    }
    if (item.kind === "boundary") {
      break;
    }
    if (item.kind === "results") {
      pending = [...item.contents, ...pending];
      continue;
    }
    turns.unshift({
      tool_sig: JSON.stringify(item.names),
      call_sig: JSON.stringify(item.parts),
      result_sig: JSON.stringify(pending),
    });
    pending = [];
  }

  return { turns, awaiting_tool_decision };
};

const digest = (parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/**
 * Claude Code sends `metadata.user_id` as a JSON string carrying `session_id`
 * alongside device and account identifiers. Only the session id is read, and
 * it is hashed before it leaves this function.
 */
const anthropicSessionId = (request: AnthropicMessagesRequest): string | undefined => {
  const raw = request.metadata?.user_id;
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const session_id =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).session_id
        : undefined;
    return typeof session_id === "string" && session_id !== "" ? session_id : undefined;
  } catch {
    return undefined;
  }
};

export const fromAnthropicRequest = (
  request: AnthropicMessagesRequest,
  turn_limit: number,
): NormalizedHistory => {
  const messages = request.messages ?? [];
  const session_id = anthropicSessionId(request);
  const first_human = messages.find((message) => classifyAnthropic(message).kind === "boundary");
  return {
    conversation_id:
      session_id === undefined
        ? digest(["anthropic", request.system ?? null, first_human?.content ?? null])
        : digest(["session", session_id]),
    ...trailingTurns(messages, classifyAnthropic, turn_limit),
  };
};

export const fromOpenAiRequest = (
  request: OpenAiClientChatRequest,
  turn_limit: number,
): NormalizedHistory => {
  const messages = request.messages ?? [];
  const system = messages.find((message) => message.role === "system");
  const first_human = messages.find((message) => message.role === "user");
  return {
    conversation_id: digest(["openai", system?.content ?? null, first_human?.content ?? null]),
    ...trailingTurns(messages, classifyOpenAi, turn_limit),
  };
};
