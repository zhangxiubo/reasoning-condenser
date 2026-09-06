import { LoopEscalation } from "./loop_escalation.ts";
import { detectStall } from "./stall_detector.ts";
import type { NormalizedHistory } from "./normalized_history.ts";
import type { StallReason } from "./stall_detector.ts";
import type { OpenAiChatMessage, OpenAiChatRequest } from "./types.ts";

export interface LoopBreakerConfig {
  enabled: boolean;
  threshold: number;
  /** Level at which the intervention removes tool affordances. */
  max_injections: number;
  /** Consecutive clean requests that reduce the escalation level by one. */
  decay_after_clean: number;
}

export interface LoopBreakerResult {
  request: OpenAiChatRequest;
  injected: boolean;
  /** 0 when nothing was injected, otherwise the escalation level applied. */
  level: number;
  /** True when tool affordances were removed from the request. */
  hard_stop: boolean;
  stall_count: number;
  reason: StallReason | null;
}

/**
 * `tools`, `tool_choice` and `parallel_tool_calls` describe one capability.
 * Removing only `tools` leaves `tool_choice` naming a capability that no longer
 * exists, so they are removed together.
 */
const TOOL_AFFORDANCES = ["tools", "tool_choice", "parallel_tool_calls"];

const withoutToolAffordances = (request: OpenAiChatRequest): OpenAiChatRequest =>
  Object.fromEntries(
    Object.entries(request).filter(([field]) => !TOOL_AFFORDANCES.includes(field)),
  ) as OpenAiChatRequest;

const REPORT_REQUEST =
  "Report to me now: (1) the current status, (2) what you have found so far, " +
  "(3) what is blocking you, (4) your recommended next step.";

/**
 * The sentence describing tool availability is derived from the transform that
 * is actually applied, so a notice cannot claim a restriction that was not
 * imposed.
 */
const toolStateSentence = (strips_tools: boolean): string =>
  strips_tools
    ? "All tools have been removed from this request; you cannot call tools. Respond with plain text only."
    : "Stop calling tools.";

interface Step {
  applies: (level: number, max_injections: number) => boolean;
  strips_tools: boolean;
  lead: (stall_count: number) => string;
}

/** Ordered; the first matching step wins. */
const LADDER: readonly Step[] = [
  {
    applies: (level, max_injections) => level >= max_injections,
    strips_tools: true,
    lead: (stall_count) =>
      `[Operator hard stop] Repeated tool calls with no progress were detected ${stall_count} times and you did not stop.`,
  },
  {
    applies: (level) => level >= 2,
    strips_tools: false,
    lead: (stall_count) =>
      `[Operator warning] You were told to stop, but you have made ${stall_count} more tool calls with no progress.`,
  },
  {
    applies: () => true,
    strips_tools: false,
    lead: (stall_count) =>
      `[Operator notice] You have made ${stall_count} consecutive tool calls with no progress.`,
  },
];

const passthrough = (request: OpenAiChatRequest, stall_count: number): LoopBreakerResult => ({
  request: { ...request },
  injected: false,
  level: 0,
  hard_stop: false,
  stall_count,
  reason: null,
});

/**
 * Composes stall detection, per-conversation escalation and the request
 * transform. Detection reads `NormalizedHistory`, built from the client
 * request, so it never depends on what protocol conversion discarded.
 *
 * The input request is never mutated.
 */
export class LoopBreakerState {
  private readonly escalation: LoopEscalation;

  constructor(escalation: LoopEscalation = new LoopEscalation()) {
    this.escalation = escalation;
  }

  apply(
    request: OpenAiChatRequest,
    history: NormalizedHistory,
    config: LoopBreakerConfig,
  ): LoopBreakerResult {
    if (!config.enabled) {
      return passthrough(request, 0);
    }

    const verdict = history.awaiting_tool_decision
      ? detectStall(history.turns, config.threshold)
      : null;

    if (verdict === null) {
      this.escalation.recordClean(history.conversation_id, config);
      return passthrough(request, 0);
    }

    const level = this.escalation.recordStall(history.conversation_id, config);
    const step = LADDER.find((candidate) => candidate.applies(level, config.max_injections))!;
    const notice: OpenAiChatMessage = {
      role: "user",
      content: `${step.lead(verdict.count)} ${toolStateSentence(step.strips_tools)} ${REPORT_REQUEST}`,
    };
    const appended: OpenAiChatRequest = {
      ...request,
      messages: [...(request.messages ?? []), notice],
    };

    return {
      request: step.strips_tools ? withoutToolAffordances(appended) : appended,
      injected: true,
      level,
      hard_stop: step.strips_tools,
      stall_count: verdict.count,
      reason: verdict.reason,
    };
  }
}
