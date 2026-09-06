import assert from "node:assert/strict";
import test from "node:test";
import { applyLoopBreaker, LoopBreakerState } from "../src/loop_breaker.ts";
import type { OpenAiChatMessage, OpenAiChatRequest, OpenAiToolCall } from "../src/types.ts";

const STATIC_LOG = "step 3/50 done\nstep 4/50 done\nstep 5/50 done\n";
const CFG = { enabled: true, threshold: 3, max_injections: 3, decay_after_clean: 2 };
const TOOLS = [{ type: "function" as const, function: { name: "bash", parameters: {} } }];

const toolCall = (id: string, name: string, args: string): OpenAiToolCall[] => [
  { id, type: "function", function: { name, arguments: args } },
];

// N poll turns with the SAME call and the SAME static result, ending on a tool result.
const identicalPolls = (n: number, args = `{"command":"tail -5 /tmp/job.log"}`): OpenAiChatMessage[] => {
  const messages: OpenAiChatMessage[] = [];
  for (let i = 1; i <= n; i += 1) {
    messages.push({ role: "assistant", content: "", tool_calls: toolCall(`c${i}`, "bash", args) });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: STATIC_LOG });
  }
  return messages;
};

const request = (messages: OpenAiChatMessage[]): OpenAiChatRequest => ({
  model: "test-model",
  stream: false,
  max_tokens: 1024,
  messages,
});

test("1. non-stalled history (distinct calls AND distinct results) -> no injection, length unchanged", () => {
  const messages: OpenAiChatMessage[] = [
    { role: "system", content: "You are a coding assistant with a bash tool." },
    { role: "user", content: "Check the job." },
    { role: "assistant", content: "", tool_calls: toolCall("a", "bash", `{"command":"tail -1 /tmp/job.log"}`) },
    { role: "tool", tool_call_id: "a", content: "line1" },
    { role: "assistant", content: "", tool_calls: toolCall("b", "bash", `{"command":"tail -2 /tmp/job.log"}`) },
    { role: "tool", tool_call_id: "b", content: "line2" },
    { role: "assistant", content: "", tool_calls: toolCall("c", "bash", `{"command":"tail -3 /tmp/job.log"}`) },
    { role: "tool", tool_call_id: "c", content: "line3" },
  ];
  const result = applyLoopBreaker(request(messages), CFG);
  assert.equal(result.injected, false);
  assert.equal(result.stallCount, 1);
  assert.equal(result.request.messages.length, messages.length);
});

test("2. 3 identical tool calls -> injected, exactly one notice, stallCount=3, repeated_call", () => {
  const messages = identicalPolls(3);
  const result = applyLoopBreaker(request(messages), CFG);
  assert.equal(result.injected, true);
  assert.equal(result.stallCount, 3);
  assert.equal(result.reason, "repeated_call");
  assert.equal(result.request.messages.length, messages.length + 1);
  const notices = result.request.messages.filter(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Operator notice"),
  );
  assert.equal(notices.length, 1);
  const last = result.request.messages[result.request.messages.length - 1]!;
  assert.equal(last.role, "user");
  assert.match(String(last.content), /3 consecutive tool calls/);
});

test("3. 3 identical RESULTS with DIFFERENT calls -> injected, unchanged_result", () => {
  const messages: OpenAiChatMessage[] = [];
  for (let i = 1; i <= 3; i += 1) {
    messages.push({ role: "assistant", content: "", tool_calls: toolCall(`d${i}`, "bash", `{"command":"cmd${i}"}`) });
    messages.push({ role: "tool", tool_call_id: `d${i}`, content: STATIC_LOG });
  }
  const result = applyLoopBreaker(request(messages), CFG);
  assert.equal(result.injected, true);
  assert.equal(result.stallCount, 3);
  assert.equal(result.reason, "unchanged_result");
});

test("4. only 2 identical calls (below threshold) -> no injection", () => {
  const result = applyLoopBreaker(request(identicalPolls(2)), CFG);
  assert.equal(result.injected, false);
  assert.equal(result.stallCount, 2);
});

test("5. enabled=false on a stalled history -> no injection", () => {
  const result = applyLoopBreaker(request(identicalPolls(3)), {
    enabled: false,
    threshold: 3,
    max_injections: 3,
    decay_after_clean: 2,
  });
  assert.equal(result.injected, false);
  assert.equal(result.request.messages.length, 6);
});

test("6. history ending in an assistant text message -> no crash, no injection", () => {
  const messages: OpenAiChatMessage[] = [...identicalPolls(3), { role: "assistant", content: "Let me report the status." }];
  const result = applyLoopBreaker(request(messages), CFG);
  assert.equal(result.injected, false);
  assert.equal(result.request.messages.length, messages.length);
});

test("7. parallel tool_calls (2 per turn, repeated 3x) -> handled, injected", () => {
  const twoCalls = (prefix: string): OpenAiToolCall[] => [
    { id: `${prefix}_1`, type: "function", function: { name: "bash", arguments: `{"command":"cat a"}` } },
    { id: `${prefix}_2`, type: "function", function: { name: "bash", arguments: `{"command":"cat b"}` } },
  ];
  const messages: OpenAiChatMessage[] = [];
  for (let i = 1; i <= 3; i += 1) {
    messages.push({ role: "assistant", content: "", tool_calls: twoCalls(`p${i}`) });
    messages.push({ role: "tool", tool_call_id: `p${i}_1`, content: "A" });
    messages.push({ role: "tool", tool_call_id: `p${i}_2`, content: "B" });
  }
  const result = applyLoopBreaker(request(messages), CFG);
  assert.equal(result.injected, true);
  assert.equal(result.stallCount, 3);
  assert.equal(result.request.messages.length, messages.length + 1);
});

test("8. input request is NOT mutated (deep-compare before/after)", () => {
  const messages = identicalPolls(3);
  const req = request(messages);
  const before = structuredClone(req);
  const result = applyLoopBreaker(req, CFG);
  assert.equal(result.injected, true);
  assert.deepEqual(req, before);
  assert.notEqual(result.request, req);
  assert.notEqual(result.request.messages, req.messages);
  assert.equal(req.messages.length, 6);
});

test("9. A-B-A-B alternation (period-2 loop) -> injected, alternating_calls", () => {
  const messages: OpenAiChatMessage[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const name = i % 2 === 1 ? "cmdA" : "cmdB";
    const result = i % 2 === 1 ? "resultA" : "resultB";
    messages.push({ role: "assistant", content: "", tool_calls: toolCall(`e${i}`, "bash", `{"command":"${name}"}`) });
    messages.push({ role: "tool", tool_call_id: `e${i}`, content: result });
  }
  const result = applyLoopBreaker(request(messages), CFG);
  assert.equal(result.injected, true);
  assert.equal(result.reason, "alternating_calls");
  assert.equal(result.stallCount, 4);
});

test("10. escalation: notice -> warning -> hard stop (tools stripped)", () => {
  const breaker = new LoopBreakerState();
  const messages = identicalPolls(3);

  const first = breaker.apply({ ...request(messages), tools: TOOLS }, CFG);
  assert.equal(first.injected, true);
  assert.equal(first.level, 1);
  assert.equal(first.hardStop, false);
  assert.match(String(first.request.messages.at(-1)!.content), /Operator notice/);
  assert.equal(first.request.tools, TOOLS);

  const second = breaker.apply({ ...request(messages), tools: TOOLS }, CFG);
  assert.equal(second.injected, true);
  assert.equal(second.level, 2);
  assert.equal(second.hardStop, false);
  assert.match(String(second.request.messages.at(-1)!.content), /Operator warning/);

  const third = breaker.apply({ ...request(messages), tools: TOOLS }, CFG);
  assert.equal(third.injected, true);
  assert.equal(third.level, 3);
  assert.equal(third.hardStop, true);
  assert.match(String(third.request.messages.at(-1)!.content), /hard stop/);
  assert.equal(third.request.tools, undefined);
});

test("11. escalation is per-conversation: a different conversation starts at level 1", () => {
  const breaker = new LoopBreakerState();
  const base = identicalPolls(3);
  const convA: OpenAiChatRequest = {
    ...request(base),
    messages: [{ role: "user", content: "Task A: monitor the job." }, ...base],
  };
  const convB: OpenAiChatRequest = {
    ...request(base),
    messages: [{ role: "user", content: "A different task entirely." }, ...base],
  };

  breaker.apply(convA, CFG);
  breaker.apply(convA, CFG);
  const aThird = breaker.apply(convA, CFG);
  assert.equal(aThird.hardStop, true);

  const bFirst = breaker.apply(convB, CFG);
  assert.equal(bFirst.level, 1);
  assert.equal(bFirst.hardStop, false);
});

test("12. hard stop with no tools field: still injected, no crash", () => {
  const breaker = new LoopBreakerState();
  const messages = identicalPolls(3);
  breaker.apply(request(messages), CFG);
  breaker.apply(request(messages), CFG);
  const third = breaker.apply(request(messages), CFG);
  assert.equal(third.injected, true);
  assert.equal(third.hardStop, true);
  assert.equal(third.request.tools, undefined);
});

test("13. below-threshold requests do not consume escalation budget", () => {
  const breaker = new LoopBreakerState();
  const stalled = identicalPolls(3);
  const notStalled = identicalPolls(2);

  breaker.apply(request(notStalled), CFG);
  const first = breaker.apply(request(stalled), CFG);
  assert.equal(first.level, 1);
  assert.equal(first.hardStop, false);
});
