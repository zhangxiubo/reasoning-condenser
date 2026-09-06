import assert from "node:assert/strict";
import test from "node:test";
import { fromAnthropicRequest, fromOpenAiRequest } from "../src/normalized_history.ts";
import type { AnthropicMessage, OpenAiChatMessage } from "../src/types.ts";

const LIMIT = 6;

const anthropicPolls = (n: number): AnthropicMessage[] => {
  const messages: AnthropicMessage[] = [{ role: "user", content: "Monitor the job." }];
  for (let index = 1; index <= n; index += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${index}`, name: "Bash", input: { command: "tail -5 log" } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${index}`, content: "step 5/50 done" }],
    });
  }
  return messages;
};

const anthropic = (messages: AnthropicMessage[], extra: Record<string, unknown> = {}) =>
  ({ model: "alias", max_tokens: 100, system: "sys", messages, ...extra }) as never;

test("a trailing system message does not hide that a tool decision is pending", () => {
  const withNotice = anthropic([
    ...anthropicPolls(3),
    { role: "system", content: "<total_tokens>1 tokens left</total_tokens>" },
  ]);

  const history = fromAnthropicRequest(withNotice, LIMIT);

  assert.equal(history.awaiting_tool_decision, true);
  assert.equal(history.turns.length, 3);
});

test("a real human turn ends the trailing run", () => {
  const messages: AnthropicMessage[] = [...anthropicPolls(2), { role: "user", content: "check again" }];
  messages.push({
    role: "assistant",
    content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "tail -5 log" } }],
  });
  messages.push({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t9", content: "step 5/50 done" }],
  });

  const history = fromAnthropicRequest(anthropic(messages), LIMIT);

  assert.equal(history.awaiting_tool_decision, true);
  assert.equal(history.turns.length, 1);
});

test("collection is bounded by the turn limit", () => {
  const history = fromAnthropicRequest(anthropic(anthropicPolls(50)), LIMIT);

  assert.equal(history.turns.length, LIMIT);
});

test("identical calls produce identical signatures", () => {
  const history = fromAnthropicRequest(anthropic(anthropicPolls(3)), LIMIT);
  const [first, second] = history.turns;

  assert.equal(first?.call_sig, second?.call_sig);
  assert.equal(first?.result_sig, second?.result_sig);
  assert.equal(first?.tool_sig, second?.tool_sig);
});

test("the Anthropic conversation id comes from the Claude Code session id", () => {
  const metadata = {
    user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "session-one" }),
  };
  const first = fromAnthropicRequest(anthropic(anthropicPolls(3), { metadata }), LIMIT);
  const withOtherPrompt = fromAnthropicRequest(
    anthropic(anthropicPolls(3), { metadata, system: "a completely different system prompt" }),
    LIMIT,
  );
  const otherSession = fromAnthropicRequest(
    anthropic(anthropicPolls(3), {
      metadata: { user_id: JSON.stringify({ session_id: "session-two" }) },
    }),
    LIMIT,
  );

  assert.equal(first.conversation_id, withOtherPrompt.conversation_id);
  assert.notEqual(first.conversation_id, otherSession.conversation_id);
  assert.doesNotMatch(first.conversation_id, /session-one/);
});

test("array content produces distinct OpenAI conversation ids", () => {
  const openAiPolls: OpenAiChatMessage[] = [];
  for (let index = 1; index <= 3; index += 1) {
    openAiPolls.push({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: `c${index}`, type: "function", function: { name: "bash", arguments: `{"c":"x"}` } },
      ],
    });
    openAiPolls.push({ role: "tool", tool_call_id: `c${index}`, content: "same" });
  }
  const build = (text: string) =>
    fromOpenAiRequest(
      {
        model: "m",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: [{ type: "text", text }] as never },
          ...openAiPolls,
        ],
      },
      LIMIT,
    );

  assert.notEqual(build("Task X").conversation_id, build("Task Y").conversation_id);
  assert.equal(build("Task X").awaiting_tool_decision, true);
  assert.equal(build("Task X").turns.length, 3);
});
