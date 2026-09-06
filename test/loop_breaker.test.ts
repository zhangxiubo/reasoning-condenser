import assert from "node:assert/strict";
import test from "node:test";
import { LoopBreakerState } from "../src/loop_breaker.ts";
import type { NormalizedHistory } from "../src/normalized_history.ts";
import type { OpenAiChatRequest } from "../src/types.ts";

const CONFIG = { enabled: true, threshold: 3, max_injections: 3, decay_after_clean: 2 };
const TOOLS = [{ type: "function" as const, function: { name: "bash", parameters: {} } }];

const stalledHistory = (conversation_id = "conv"): NormalizedHistory => ({
  conversation_id,
  awaiting_tool_decision: true,
  turns: Array.from({ length: 3 }, () => ({
    tool_sig: '["bash"]',
    call_sig: '[["bash","tail"]]',
    result_sig: '["same"]',
  })),
});

const cleanHistory = (conversation_id = "conv"): NormalizedHistory => ({
  conversation_id,
  awaiting_tool_decision: true,
  turns: [{ tool_sig: '["bash"]', call_sig: '[["bash","one"]]', result_sig: '["a"]' }],
});

const request = (extra: Partial<OpenAiChatRequest> = {}): OpenAiChatRequest => ({
  model: "m",
  stream: false,
  messages: [
    { role: "user", content: "Monitor the job." },
    { role: "tool", tool_call_id: "c1", content: "step 5/50 done" },
  ],
  ...extra,
});

test("a stalled history appends exactly one notice", () => {
  const result = new LoopBreakerState().apply(request(), stalledHistory(), CONFIG);

  assert.equal(result.injected, true);
  assert.equal(result.level, 1);
  assert.equal(result.hard_stop, false);
  assert.equal(result.stall_count, 3);
  assert.equal(result.reason, "unchanged_result");
  assert.equal(result.request.messages.length, 3);
  assert.match(String(result.request.messages.at(-1)?.content), /Operator notice/);
  assert.match(String(result.request.messages.at(-1)?.content), /your recommended next step/);
});

test("a clean history injects nothing", () => {
  const result = new LoopBreakerState().apply(request(), cleanHistory(), CONFIG);

  assert.equal(result.injected, false);
  assert.equal(result.level, 0);
  assert.equal(result.hard_stop, false);
  assert.equal(result.reason, null);
  assert.equal(result.request.messages.length, 2);
});

test("nothing is injected when the model is not awaiting a tool decision", () => {
  const history = { ...stalledHistory(), awaiting_tool_decision: false };
  const result = new LoopBreakerState().apply(request(), history, CONFIG);

  assert.equal(result.injected, false);
});

test("nothing is injected when the breaker is disabled", () => {
  const result = new LoopBreakerState().apply(request(), stalledHistory(), {
    ...CONFIG,
    enabled: false,
  });

  assert.equal(result.injected, false);
});

test("the input request is never mutated, including on the hard-stop path", () => {
  const breaker = new LoopBreakerState();
  const original = request({ tools: TOOLS });
  const snapshot = structuredClone(original);

  breaker.apply(original, stalledHistory(), CONFIG);
  breaker.apply(original, stalledHistory(), CONFIG);
  const third = breaker.apply(original, stalledHistory(), CONFIG);

  assert.equal(third.hard_stop, true);
  assert.deepEqual(original, snapshot);
});

test("escalation runs notice, warning, then hard stop", () => {
  const breaker = new LoopBreakerState();

  const first = breaker.apply(request({ tools: TOOLS }), stalledHistory(), CONFIG);
  const second = breaker.apply(request({ tools: TOOLS }), stalledHistory(), CONFIG);
  const third = breaker.apply(request({ tools: TOOLS }), stalledHistory(), CONFIG);

  assert.match(String(first.request.messages.at(-1)?.content), /Operator notice/);
  assert.match(String(second.request.messages.at(-1)?.content), /Operator warning/);
  assert.match(String(third.request.messages.at(-1)?.content), /Operator hard stop/);
  assert.equal(third.hard_stop, true);
});

test("the hard stop removes every tool affordance together", () => {
  const breaker = new LoopBreakerState();
  const withTools = () =>
    request({ tools: TOOLS, tool_choice: "required", parallel_tool_calls: true });

  breaker.apply(withTools(), stalledHistory(), CONFIG);
  breaker.apply(withTools(), stalledHistory(), CONFIG);
  const third = breaker.apply(withTools(), stalledHistory(), CONFIG);

  assert.equal(third.hard_stop, true);
  assert.equal("tools" in third.request, false);
  assert.equal("tool_choice" in third.request, false);
  assert.equal("parallel_tool_calls" in third.request, false);
  assert.equal(third.request.model, "m");
});

test("a notice never claims tools were removed while they are still present", () => {
  const breaker = new LoopBreakerState();

  const first = breaker.apply(request({ tools: TOOLS }), stalledHistory(), CONFIG);
  const second = breaker.apply(request({ tools: TOOLS }), stalledHistory(), CONFIG);

  for (const result of [first, second]) {
    assert.equal(result.hard_stop, false);
    assert.equal(result.request.tools, TOOLS);
    assert.doesNotMatch(String(result.request.messages.at(-1)?.content), /removed|cannot call tools/);
  }
});

test("escalation is per conversation", () => {
  const breaker = new LoopBreakerState();

  breaker.apply(request(), stalledHistory("a"), CONFIG);
  breaker.apply(request(), stalledHistory("a"), CONFIG);

  assert.equal(breaker.apply(request(), stalledHistory("b"), CONFIG).level, 1);
});

test("recovery walks the level back down", () => {
  const breaker = new LoopBreakerState();

  breaker.apply(request(), stalledHistory(), CONFIG);
  breaker.apply(request(), stalledHistory(), CONFIG);
  breaker.apply(request(), cleanHistory(), CONFIG);
  breaker.apply(request(), cleanHistory(), CONFIG);

  assert.equal(breaker.apply(request(), stalledHistory(), CONFIG).level, 2);
});

test("a max_injections of one removes tool affordances immediately", () => {
  const result = new LoopBreakerState().apply(request({ tools: TOOLS }), stalledHistory(), {
    ...CONFIG,
    max_injections: 1,
  });

  assert.equal(result.hard_stop, true);
  assert.equal("tools" in result.request, false);
  assert.match(String(result.request.messages.at(-1)?.content), /Operator hard stop/);
  assert.match(String(result.request.messages.at(-1)?.content), /cannot call tools/);
});

test("hard stop with no tools field on the request: still injected, no crash", () => {
  const breaker = new LoopBreakerState();

  breaker.apply(request(), stalledHistory(), CONFIG);
  breaker.apply(request(), stalledHistory(), CONFIG);
  const third = breaker.apply(request(), stalledHistory(), CONFIG);

  assert.equal(third.injected, true);
  assert.equal(third.hard_stop, true);
  assert.equal("tools" in third.request, false);
});
