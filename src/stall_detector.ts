import type { HistoryTurn } from "./normalized_history.ts";

export type StallReason =
  | "unchanged_result"
  | "repeated_call"
  | "variant_thrash"
  | "alternating_calls";

export interface StallVerdict {
  reason: StallReason;
  count: number;
}

type Match = (older: HistoryTurn, newer: HistoryTurn) => boolean;

/** Length of the trailing run over which `match` holds between neighbours. */
const trailingRun = (turns: HistoryTurn[], match: Match): number => {
  if (turns.length === 0) {
    return 0;
  }
  let run = 1;
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    if (!match(turns[index]!, turns[index + 1]!)) {
      break;
    }
    run += 1;
  }
  return run;
};

const identical: Match = (older, newer) =>
  older.call_sig === newer.call_sig && older.result_sig === newer.result_sig;

/**
 * Length of a trailing period-2 alternation (A-B-A-B). Neighbours must differ,
 * otherwise the run is plain repetition and a different signal describes it.
 */
const alternationRun = (turns: HistoryTurn[]): number => {
  const count = turns.length;
  if (count < 4 || identical(turns[count - 2]!, turns[count - 1]!)) {
    return 0;
  }
  let run = 2;
  for (let index = count - 3; index >= 0; index -= 1) {
    if (!identical(turns[index]!, turns[index + 2]!)) {
      break;
    }
    run += 1;
  }
  return run >= 4 ? run : 0;
};

interface Signal {
  reason: StallReason;
  minimum: (threshold: number) => number;
  run: (turns: HistoryTurn[]) => number;
}

/**
 * Ordered most specific first, so the most informative reason is reported.
 * `unchanged_result` is a strict subset of `repeated_call`.
 *
 * `variant_thrash` covers the same tool meeting the same wall with differing
 * arguments. It needs a longer run because a search sweep looks the same until
 * it goes on too long.
 */
const SIGNALS: readonly Signal[] = [
  {
    reason: "unchanged_result",
    minimum: (threshold) => threshold,
    run: (turns) => trailingRun(turns, identical),
  },
  {
    reason: "repeated_call",
    minimum: (threshold) => threshold,
    run: (turns) => trailingRun(turns, (older, newer) => older.call_sig === newer.call_sig),
  },
  {
    reason: "variant_thrash",
    minimum: (threshold) => threshold + 2,
    run: (turns) =>
      trailingRun(
        turns,
        (older, newer) =>
          older.tool_sig === newer.tool_sig &&
          older.result_sig === newer.result_sig &&
          older.call_sig !== newer.call_sig,
      ),
  },
  {
    reason: "alternating_calls",
    minimum: (threshold) => threshold,
    run: alternationRun,
  },
];

/** Longest run any signal can consult, plus one turn to prove the run ended. */
export const historyTurnLimit = (threshold: number): number => Math.max(threshold + 2, 4) + 1;

export const detectStall = (turns: HistoryTurn[], threshold: number): StallVerdict | null => {
  const hit = SIGNALS.map((signal) => ({ signal, run: signal.run(turns) })).find(
    ({ signal, run }) => run >= signal.minimum(threshold) && run > 1,
  );
  return hit === undefined ? null : { reason: hit.signal.reason, count: hit.run };
};
