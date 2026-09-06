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

const identical: Match = (older, newer) =>
  older.call_sig === newer.call_sig && older.result_sig === newer.result_sig;

/**
 * Length of the trailing run in which `match` holds between a turn and the
 * turn `period` steps ahead of it, walking backwards. `period` 1 is
 * adjacent-turn repetition; `period` 2 is a two-state alternation.
 *
 * Periodicity at period 1 implies periodicity at period 2, so a run of
 * plain repetition genuinely is a period-2 run too. Which signal reports it
 * is decided by table order and minimum run, not by anything special-cased
 * here.
 */
const periodicRun = (turns: HistoryTurn[], period: number, match: Match): number => {
  const count = turns.length;
  if (count < period) {
    return 0;
  }
  let run = period;
  for (let index = count - period - 1; index >= 0; index -= 1) {
    if (!match(turns[index]!, turns[index + period]!)) {
      break;
    }
    run += 1;
  }
  return run;
};

interface Signal {
  reason: StallReason;
  /** Turns between the two ends of one comparison: 1 for repetition, 2 for alternation. */
  period: number;
  match: Match;
  minimum: (threshold: number) => number;
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
    period: 1,
    match: identical,
    minimum: (threshold) => threshold,
  },
  {
    reason: "repeated_call",
    period: 1,
    match: (older, newer) => older.call_sig === newer.call_sig,
    minimum: (threshold) => threshold,
  },
  {
    reason: "variant_thrash",
    period: 1,
    match: (older, newer) =>
      older.tool_sig === newer.tool_sig &&
      older.result_sig === newer.result_sig &&
      older.call_sig !== newer.call_sig,
    minimum: (threshold) => threshold + 2,
  },
  {
    reason: "alternating_calls",
    period: 2,
    match: identical,
    minimum: (threshold) => threshold,
  },
];

/**
 * A run must be at least twice its period to demonstrate a repeat at all: a
 * period-2 cycle cannot be shown in fewer than two full cycles, and a
 * period-1 repeat needs at least one comparison to have been made. This floor
 * combines with each signal's own threshold-derived minimum.
 */
const effectiveMinimum = (signal: Signal, threshold: number): number =>
  Math.max(signal.minimum(threshold), 2 * signal.period);

/** Longest run any signal can consult, plus one turn to prove the run ended. */
export const historyTurnLimit = (threshold: number): number => Math.max(threshold + 2, 4) + 1;

export const detectStall = (turns: HistoryTurn[], threshold: number): StallVerdict | null => {
  const hit = SIGNALS.map((signal) => ({
    signal,
    run: periodicRun(turns, signal.period, signal.match),
  })).find(({ signal, run }) => run >= effectiveMinimum(signal, threshold));
  return hit === undefined ? null : { reason: hit.signal.reason, count: hit.run };
};
