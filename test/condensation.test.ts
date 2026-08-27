import assert from "node:assert/strict";
import test from "node:test";
import { ReasoningCondenser, ReasoningCondensationPolicy } from "../src/condensation.ts";
import { CharacterTokenEstimator } from "../src/token_estimator.ts";
import type { NormalizedTurn } from "../src/types.ts";
import { FakeChatClient, testConfig } from "./helpers.ts";

const completedTurn = (reasoning: string): NormalizedTurn => ({
  id: "msg_1",
  model: "primary-model",
  reasoning,
  text: "The implementation is complete.",
  tool_calls: [],
  stop_reason: "end_turn",
  upstream_usage: { input_tokens: 100, output_tokens: 50 },
});

test("condenses completed reasoning and leaves final content untouched", async () => {
  const config = testConfig();
  const estimator = new CharacterTokenEstimator(1);
  const client = new FakeChatClient({
    choices: [{ message: { content: '{"reasoning":"Changed src/main.ts; tests pass."}' } }],
  });
  const condenser = new ReasoningCondenser(
    config,
    client,
    new ReasoningCondensationPolicy(config, estimator),
    estimator,
  );
  const original = completedTurn("Long exploratory reasoning. ".repeat(20));

  const outcome = await condenser.condense(original);

  assert.equal(outcome.status, "condensed");
  assert.equal(outcome.profile, "completed_response");
  assert.equal(outcome.turn.reasoning, "Changed src/main.ts; tests pass.");
  assert.equal(outcome.turn.text, original.text);
  assert.deepEqual(outcome.turn.tool_calls, original.tool_calls);
  assert.deepEqual(client.requests[0]?.response_format, { type: "json_object" });
  assert.deepEqual(client.requests[0]?.chat_template_kwargs, { enable_thinking: true });
  assert.equal(client.requests[0]?.temperature, 0);
  assert.equal(client.requests[0]?.max_tokens, 4_096);
  const condenser_payload = JSON.parse(String(client.requests[0]?.messages.at(-1)?.content)) as {
    replacement_reasoning_token_budget: number;
  };
  assert.equal(condenser_payload.replacement_reasoning_token_budget, 100);
});

test("uses the conservative profile for tool continuations", async () => {
  const config = testConfig();
  const estimator = new CharacterTokenEstimator(1);
  const client = new FakeChatClient({
    choices: [{ message: { content: '{"reasoning":"Read src/main.ts to inspect the reported error."}' } }],
  });
  const condenser = new ReasoningCondenser(
    config,
    client,
    new ReasoningCondensationPolicy(config, estimator),
    estimator,
  );
  const original = {
    ...completedTurn("Detailed reasoning. ".repeat(20)),
    tool_calls: [{ id: "call_1", name: "read_file", input: { path: "src/main.ts" } }],
    stop_reason: "tool_use" as const,
  };

  const outcome = await condenser.condense(original);

  assert.equal(outcome.status, "condensed");
  assert.equal(outcome.profile, "tool_continuation");
});

test("adds an accurately measured diagnostic tag", async () => {
  const config = testConfig({ condensation_smoke_tag_enabled: true });
  const estimator = new CharacterTokenEstimator(1);
  const client = new FakeChatClient({
    choices: [{ message: { content: '{"reasoning":"Compact retained state."}' } }],
  });
  const condenser = new ReasoningCondenser(
    config,
    client,
    new ReasoningCondensationPolicy(config, estimator),
    estimator,
  );

  const outcome = await condenser.condense(completedTurn("Detailed original reasoning. ".repeat(30)));

  assert.equal(outcome.status, "condensed");
  assert.match(outcome.turn.reasoning, /^\[RCR condensed \d+→\d+\]\nCompact retained state\.$/);
  assert.equal(outcome.delivered_reasoning_tokens, estimator.estimate(outcome.turn.reasoning));
  assert.equal(
    outcome.turn.reasoning.startsWith(
      `[RCR condensed ${outcome.original_reasoning_tokens}→${outcome.delivered_reasoning_tokens}]`,
    ),
    true,
  );
});

test("returns the original reasoning when the condenser fails", async () => {
  const config = testConfig();
  const estimator = new CharacterTokenEstimator(1);
  const condenser = new ReasoningCondenser(
    config,
    new FakeChatClient(new Error("condenser unavailable")),
    new ReasoningCondensationPolicy(config, estimator),
    estimator,
  );
  const original = completedTurn("Important reasoning. ".repeat(20));

  const outcome = await condenser.condense(original);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.turn, original);
  assert.match(outcome.error ?? "", /condenser unavailable/);
});
