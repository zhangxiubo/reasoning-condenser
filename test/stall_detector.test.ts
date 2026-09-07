import assert from "node:assert/strict";
import test from "node:test";
import { detectStall, historyTurnLimit } from "../src/stall_detector.ts";
import type { HistoryTurn } from "../src/normalized_history.ts";

const turn = (tool: string, args: string, result: string): HistoryTurn => ({
  tool_sig: JSON.stringify([tool]),
  call_sig: JSON.stringify([[tool, args]]),
  result_sig: JSON.stringify([result]),
});

const repeat = (n: number, make: (index: number) => HistoryTurn): HistoryTurn[] =>
  [...Array(n).keys()].map(make);

test("identical calls with identical results report unchanged_result", () => {
  const verdict = detectStall(repeat(3, () => turn("bash", "tail", "same")), 3);

  assert.equal(verdict?.reason, "unchanged_result");
  assert.equal(verdict?.count, 3);
});

test("identical calls with changing results report repeated_call", () => {
  const verdict = detectStall(repeat(3, (index) => turn("bash", "tail", `line ${index}`)), 3);

  assert.equal(verdict?.reason, "repeated_call");
  assert.equal(verdict?.count, 3);
});

test("a sweep of different searches returning nothing is not a stall", () => {
  const verdict = detectStall(repeat(3, (index) => turn("grep", `file${index}`, "")), 3);

  assert.equal(verdict, null);
});

test("the same tool hitting the same wall reports variant_thrash above a higher run", () => {
  assert.equal(detectStall(repeat(4, (index) => turn("cat", `path${index}`, "not found")), 3), null);

  const verdict = detectStall(repeat(5, (index) => turn("cat", `path${index}`, "not found")), 3);

  assert.equal(verdict?.reason, "variant_thrash");
  assert.equal(verdict?.count, 5);
});

// variant_thrash means one tool hitting one wall. Five different tools that
// happen to come back empty are five separate probes, which is what a search
// sweep looks like, so requiring an equal tool_sig is the whole point of the
// signal. Without that requirement this run is long enough to be reported.
test("different tools returning the same empty result are not variant_thrash", () => {
  assert.equal(detectStall(repeat(5, (index) => turn(`probe${index}`, "arg", "")), 3), null);
});

test("a two-call ping-pong reports alternating_calls and counts every turn", () => {
  const alternating = (n: number): HistoryTurn[] =>
    repeat(n, (index) => (index % 2 === 0 ? turn("bash", "A", "ra") : turn("bash", "B", "rb")));

  assert.equal(detectStall(alternating(3), 3), null);
  assert.equal(detectStall(alternating(4), 3)?.count, 4);
  assert.equal(detectStall(alternating(5), 3)?.count, 5);
  assert.equal(detectStall(alternating(6), 3)?.count, 6);
  assert.equal(detectStall(alternating(5), 3)?.reason, "alternating_calls");
});

// The read↔test doom loop: the calls ping-pong (read, pytest, read, pytest)
// but the pytest result varies run-to-run on its duration line ("452 passed in
// 12.34s" vs "12.60s"). Matching on call_sig only — not result_sig — is what
// lets the period-2 run reach the threshold despite the varying results.
test("a two-call ping-pong with varying results still reports alternating_calls", () => {
  const pingPong = (n: number): HistoryTurn[] =>
    repeat(n, (index) =>
      index % 2 === 0
        ? turn("read", "llm_invoker.py:255", "file content")
        : turn("bash", "pytest", `452 passed in 12.${index}s`),
    );

  assert.equal(detectStall(pingPong(3), 3), null);
  const verdict = detectStall(pingPong(4), 3);
  assert.equal(verdict?.reason, "alternating_calls");
  assert.equal(verdict?.count, 4);
  assert.equal(detectStall(pingPong(6), 3)?.count, 6);
});

// The commit→stage→test doom loop: the calls cycle with period 3 (git commit,
// git add, pytest, repeat) and each result varies run-to-run (a new commit
// hash, a re-staged file list, a test duration line). No period-1 or period-2
// signal covers a 3-step cycle, so this is what cyclic_calls is for. Matching
// on call_sig only lets the period-3 run reach its minimum (two full cycles =
// 6 turns) despite the varying results.
test("a three-call cycle reports cyclic_calls and counts every turn", () => {
  const cycle = (n: number): HistoryTurn[] =>
    repeat(n, (index) => {
      switch (index % 3) {
        case 0:
          return turn("bash", "git commit", `commit ${index}`);
        case 1:
          return turn("bash", "git add", `staged ${index}`);
        default:
          return turn("bash", "pytest", `452 passed in 12.${index}s`);
      }
    });

  // Fewer than two full cycles is not yet a demonstrated cycle.
  assert.equal(detectStall(cycle(3), 3), null);
  assert.equal(detectStall(cycle(4), 3), null);
  assert.equal(detectStall(cycle(5), 3), null);
  const verdict = detectStall(cycle(6), 3);
  assert.equal(verdict?.reason, "cyclic_calls");
  assert.equal(verdict?.count, 6);
  assert.equal(detectStall(cycle(8), 3)?.count, 8);
});

test("a four-call cycle reports cyclic_calls", () => {
  const cycle = (n: number): HistoryTurn[] =>
    repeat(n, (index) => turn("bash", `step${index % 4}`, `result ${index}`));

  // A period-4 cycle needs two full cycles (8 turns) to be demonstrated.
  assert.equal(detectStall(cycle(7), 3), null);
  const verdict = detectStall(cycle(8), 3);
  assert.equal(verdict?.reason, "cyclic_calls");
  assert.equal(verdict?.count, 8);
});

test("below the threshold nothing is reported", () => {
  assert.equal(detectStall(repeat(2, () => turn("bash", "tail", "same")), 3), null);
  assert.equal(detectStall([], 3), null);
});

// Six identical turns clear alternating_calls's own minimum run too (it
// needs 4, this run is 6), so what actually keeps this from being reported
// as alternating_calls is that unchanged_result is listed first in the
// signal table and wins the tie. This pins that ordering — not a guard
// inside the run counter, there isn't one — so a future reorder that put
// alternating_calls ahead of unchanged_result would be caught here.
test("plain repetition reports unchanged_result, not alternating_calls — pins signal table order", () => {
  const verdict = detectStall(repeat(6, () => turn("bash", "tail", "same")), 3);

  assert.equal(verdict?.reason, "unchanged_result");
  assert.equal(verdict?.count, 6);
});

test("a single turn is never a stall, even at the lowest threshold", () => {
  assert.equal(detectStall(repeat(1, () => turn("bash", "tail", "same")), 1), null);
});

test("the reported count belongs to the signal that actually fired", () => {
  const results = ["r1", "r1", "r2", "r2", "r2"];
  const verdict = detectStall(
    repeat(5, (index) => turn("bash", "tail", results[index]!)),
    3,
  );

  assert.equal(verdict?.reason, "unchanged_result");
  assert.equal(verdict?.count, 3);
});

test("the turn limit covers the longest run any signal consults", () => {
  // The floor is 2 * MAX_CYCLIC_PERIOD (10) so a period-5 cycle can be
  // demonstrated; +1 proves the run ended. This dominates the threshold term
  // for any realistic threshold.
  assert.equal(historyTurnLimit(3), 11);
  assert.equal(historyTurnLimit(1), 11);
  assert.equal(historyTurnLimit(8), 11);
});
