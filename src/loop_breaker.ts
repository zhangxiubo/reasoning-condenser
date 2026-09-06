import { createHash } from "node:crypto";
import type { OpenAiChatMessage, OpenAiChatRequest, OpenAiToolCall } from "./types.ts";

export interface LoopBreakerConfig {
  enabled: boolean;
  threshold: number;
  /** Maximum notice injections per conversation before the hard stop (tools stripped). */
  max_injections: number;
}

export type LoopBreakerReason = "repeated_call" | "unchanged_result" | "alternating_calls";

export interface LoopBreakerResult {
  request: OpenAiChatRequest;
  injected: boolean;
  /** 1 = notice, 2 = warning, >= max_injections = hard stop (tools stripped). */
  level: number;
  /** True when the hard stop stripped `tools` from the request. */
  hardStop: boolean;
  stallCount: number;
  reason: LoopBreakerReason | null;
}

/**
 * A "stall turn" is one assistant tool-call message plus the consecutive tool
 * result messages that follow it. Each turn is reduced to two stable
 * signatures so consecutive turns can be compared for no-progress.
 */
interface StallTurn {
  callSig: string;
  resultSig: string;
}

const callSignature = (toolCalls: OpenAiToolCall[] | undefined): string => {
  const parts = (toolCalls ?? []).map((toolCall) => [
    toolCall?.function?.name ?? "",
    toolCall?.function?.arguments ?? "",
  ]);
  return JSON.stringify(parts);
};

const resultSignature = (contents: unknown[]): string => JSON.stringify(contents);

const parseStallTurns = (messages: OpenAiChatMessage[]): StallTurn[] => {
  const turns: StallTurn[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    const toolCalls = message?.tool_calls;
    if (message?.role === "assistant" && Array.isArray(toolCalls) && toolCalls.length > 0) {
      const resultContents: unknown[] = [];
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor]?.role === "tool") {
        resultContents.push(messages[cursor]?.content);
        cursor += 1;
      }
      turns.push({
        callSig: callSignature(toolCalls),
        resultSig: resultSignature(resultContents),
      });
      index = cursor;
    } else {
      index += 1;
    }
  }
  return turns;
};

/**
 * Length of the trailing run of turns whose signature (for the given field) is
 * identical to the next-newer turn's signature. A run of N means the last N
 * turns all share the same signature.
 */
const trailingRun = (turns: StallTurn[], field: "callSig" | "resultSig"): number => {
  if (turns.length === 0) {
    return 0;
  }
  let run = 1;
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    const current = turns[index];
    const next = turns[index + 1];
    if (current !== undefined && next !== undefined && current[field] === next[field]) {
      run += 1;
    } else {
      break;
    }
  }
  return run;
};

/**
 * Length of a trailing period-2 alternation (A-B-A-B-...). Returns the number
 * of turns in the trailing alternating run (>= 4 when it exists), else 0.
 * Catches doom loops that ping-pong between two calls/results and therefore
 * never produce a same-signature run.
 */
const trailingAlternationRun = (turns: StallTurn[]): number => {
  if (turns.length < 4) {
    return 0;
  }
  const samePair = (a: StallTurn, b: StallTurn): boolean =>
    a.callSig === b.callSig && a.resultSig === b.resultSig;
  if (!samePair(turns[turns.length - 1]!, turns[turns.length - 3]!)) {
    return 0;
  }
  if (!samePair(turns[turns.length - 2]!, turns[turns.length - 4]!)) {
    return 0;
  }
  let run = 4;
  for (let index = turns.length - 5; index >= 1; index -= 2) {
    if (samePair(turns[index]!, turns[index + 2]!)) {
      run += 2;
    } else {
      break;
    }
  }
  return run;
};

const buildNotice = (stallCount: number): string =>
  "[Operator notice] You have made " +
  stallCount +
  " consecutive tool calls with no progress (repeated call or unchanged results). Stop calling tools. " +
  "Report to me now: (1) the current status, (2) what you have found so far, (3) what is blocking you, " +
  "(4) your recommended next step.";

const buildWarning = (stallCount: number): string =>
  "[Operator warning] You were told to stop, but you have made " +
  stallCount +
  " more tool calls with no progress. Your tool calls are being suppressed. " +
  "You MUST respond with plain text only. Report: (1) the current status, (2) what you have found so far, " +
  "(3) what is blocking you, (4) your recommended next step.";

const buildHardStop = (stallCount: number): string =>
  "[Operator hard stop] Repeated tool calls with no progress were detected " +
  stallCount +
  " times and you did not stop. All tools have been removed from this request; you cannot call tools. " +
  "Respond with plain text only: (1) the current status, (2) what you have found so far, (3) what is " +
  "blocking you, (4) your recommended next step.";

/**
 * Stable per-conversation key: hash of the system prompt plus the first
 * user message. A conversation's loop state is tracked under this key so the
 * breaker can escalate across requests instead of re-sending the same notice
 * forever (the model may ignore it; the escalation eventually strips tools).
 */
const conversationKey = (messages: OpenAiChatMessage[]): string => {
  const system = (messages.find((m) => m.role === "system")?.content ?? "").toString();
  const firstUser = (messages.find((m) => m.role === "user")?.content ?? "").toString();
  return createHash("sha256").update(system + "\u0000" + firstUser).digest("hex");
};

interface Entry {
  injections: number;
  lastSeenAt: number;
}

const ENTRY_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 5000;

/**
 * Stateful doom-loop breaker. Stateless detection (identical trailing call or
 * result runs, plus period-2 alternation) is combined with per-conversation
 * escalation:
 *
 *   level 1            -> append a notice asking the model to stop and report
 *   level 2            -> append a stronger warning
 *   level >= max_inj   -> HARD STOP: append a final notice AND strip `tools`
 *                         from the request so the model physically cannot call
 *                         tools and must answer in text.
 *
 * The input request is never mutated. When injecting, a new request object
 * with a new messages array (and, on hard stop, without `tools`) is returned;
 * otherwise a new (unmodified) request object is returned.
 */
export class LoopBreakerState {
  private readonly entries = new Map<string, Entry>();

  apply(request: OpenAiChatRequest, config: LoopBreakerConfig): LoopBreakerResult {
    const messages = request.messages ?? [];
    const turns = parseStallTurns(messages);
    const sameCallRun = trailingRun(turns, "callSig");
    const sameResultRun = trailingRun(turns, "resultSig");
    const alternationRun = trailingAlternationRun(turns);
    const stallCount = Math.max(sameCallRun, sameResultRun, alternationRun);

    // Only break a loop while the model is about to choose its next action, i.e.
    // the history ends on a tool result. If it ends on an assistant text, user,
    // or system message the model is not mid-tool-loop, so never inject.
    const lastMessage = messages[messages.length - 1];
    const awaitingToolDecision = lastMessage?.role === "tool";

    const shouldInject =
      config.enabled && awaitingToolDecision && turns.length > 0 && stallCount >= config.threshold;

    if (!shouldInject) {
      return { request: { ...request }, injected: false, level: 0, hardStop: false, stallCount, reason: null };
    }

    // Escalate this conversation's injection count (and refresh its TTL).
    const key = conversationKey(messages);
    const entry = this.entries.get(key) ?? { injections: 0, lastSeenAt: 0 };
    entry.injections += 1;
    entry.lastSeenAt = Date.now();
    this.entries.set(key, entry);
    if (this.entries.size > MAX_ENTRIES) {
      this.evict();
    }

    const reason: LoopBreakerReason =
      sameCallRun >= config.threshold
        ? "repeated_call"
        : sameResultRun >= config.threshold
          ? "unchanged_result"
          : "alternating_calls";

    const level = Math.min(entry.injections, config.max_injections);
    const hardStop = entry.injections >= config.max_injections;
    const notice =
      level >= config.max_injections
        ? buildHardStop(stallCount)
        : level === 2
          ? buildWarning(stallCount)
          : buildNotice(stallCount);

    const noticeMessage: OpenAiChatMessage = { role: "user", content: notice };
    const base: OpenAiChatRequest = {
      ...request,
      messages: [...messages, noticeMessage],
    };
    // Hard stop: strip tools so the model cannot call them. (The client sees a
    // text response instead of a tool call — the intended ejection.)
    if (hardStop && base.tools) {
      const { tools: _tools, ...rest } = base;
      return { request: rest, injected: true, level, hardStop, stallCount, reason };
    }
    return { request: base, injected: true, level, hardStop, stallCount, reason };
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenAt > ENTRY_TTL_MS) {
        this.entries.delete(key);
      }
    }
    if (this.entries.size <= MAX_ENTRIES) {
      return;
    }
    // Still over the cap: drop the oldest entries.
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    for (const [key] of oldest) {
      this.entries.delete(key);
      if (this.entries.size <= MAX_ENTRIES / 2) {
        break;
      }
    }
  }
}

/**
 * Stateless one-shot variant (kept for compatibility and tests): detects a
 * doom loop and appends a single notice. Use `LoopBreakerState` for the
 * escalating, per-conversation behavior.
 */
export const applyLoopBreaker = (
  request: OpenAiChatRequest,
  config: LoopBreakerConfig,
): LoopBreakerResult => new LoopBreakerState().apply(request, config);
