import assert from "node:assert/strict";
import test from "node:test";
import { LoopEscalation } from "../src/loop_escalation.ts";

const POLICY = { max_injections: 3, decay_after_clean: 2 };

test("levels climb one step per stall", () => {
  const ledger = new LoopEscalation();

  assert.equal(ledger.recordStall("a", POLICY), 1);
  assert.equal(ledger.recordStall("a", POLICY), 2);
  assert.equal(ledger.recordStall("a", POLICY), 3);
});

test("conversations do not share a level", () => {
  const ledger = new LoopEscalation();

  ledger.recordStall("a", POLICY);
  ledger.recordStall("a", POLICY);

  assert.equal(ledger.recordStall("b", POLICY), 1);
});

test("a run of clean requests walks the level back down", () => {
  const ledger = new LoopEscalation();

  ledger.recordStall("a", POLICY);
  ledger.recordStall("a", POLICY);
  ledger.recordClean("a", POLICY);
  ledger.recordClean("a", POLICY);

  assert.equal(ledger.recordStall("a", POLICY), 2);
});

test("one clean request between stalls does not cancel a stall", () => {
  const ledger = new LoopEscalation();

  assert.equal(ledger.recordStall("a", POLICY), 1);
  ledger.recordClean("a", POLICY);
  assert.equal(ledger.recordStall("a", POLICY), 2);
  ledger.recordClean("a", POLICY);
  assert.equal(ledger.recordStall("a", POLICY), 3);
});

test("decay stops at zero and forgets the conversation", () => {
  const ledger = new LoopEscalation();

  ledger.recordStall("a", POLICY);
  for (let index = 0; index < 10; index += 1) {
    ledger.recordClean("a", POLICY);
  }

  assert.equal(ledger.size, 0);
  assert.equal(ledger.recordStall("a", POLICY), 1);
});

test("entries expire on access once they are stale", () => {
  let now = 1_000;
  const ledger = new LoopEscalation(() => now);

  ledger.recordStall("a", POLICY);
  ledger.recordStall("a", POLICY);
  now += 31 * 60 * 1000;

  assert.equal(ledger.recordStall("a", POLICY), 1);
});
