import assert from "node:assert/strict";
import test from "node:test";
import { LoopEscalation } from "../src/loop_escalation.ts";

const POLICY = { max_injections: 3, decay_after_clean: 2 };

test("levels climb one step per stall", () => {
  const ledger = new LoopEscalation();

  assert.equal(ledger.recordStall("a", POLICY), 1);
  assert.equal(ledger.recordStall("a", POLICY), 2);
  assert.equal(ledger.recordStall("a", POLICY), 3);
  assert.equal(ledger.recordStall("a", POLICY), 3);
});

test("the level is capped at max_injections even when the cap is one", () => {
  const ledger = new LoopEscalation();
  const policy = { max_injections: 1, decay_after_clean: 2 };

  assert.equal(ledger.recordStall("a", policy), 1);
  assert.equal(ledger.recordStall("a", policy), 1);
  assert.equal(ledger.recordStall("a", policy), 1);
});

test("the returned level is floored at one even when max_injections is misconfigured to zero", () => {
  const ledger = new LoopEscalation();
  const policy = { max_injections: 0, decay_after_clean: 2 };

  assert.equal(ledger.recordStall("a", policy), 1);
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

test("recordClean also treats a stale entry as absent, not just recordStall", () => {
  let now = 1_000;
  const ledger = new LoopEscalation(() => now);

  ledger.recordStall("a", POLICY);
  now += 31 * 60 * 1000;
  ledger.recordClean("a", POLICY);

  assert.equal(ledger.size, 0);
});

test("stored escalation is clamped to the cap, so a full run of decay always reaches zero", () => {
  const ledger = new LoopEscalation();

  for (let index = 0; index < 6; index += 1) {
    ledger.recordStall("a", POLICY);
  }
  for (let index = 0; index < 6; index += 1) {
    ledger.recordClean("a", POLICY);
  }

  assert.equal(ledger.size, 0);
});

test("the eviction limit bounds memory while keeping the most recently used entry", () => {
  let now = 0;
  const ledger = new LoopEscalation(() => now);

  for (let index = 0; index <= 5000; index += 1) {
    now += 1;
    ledger.recordStall(`conversation-${index}`, POLICY);
  }

  assert.ok(ledger.size <= 2500);
  assert.equal(ledger.recordStall("conversation-5000", POLICY), 2);
});
