import assert from "node:assert/strict";
import test from "node:test";
import { ReasoningCondenser, ReasoningCondensationPolicy } from "../src/condensation.ts";
import { LoopBreakerState } from "../src/loop_breaker.ts";
import { NullTurnArchive } from "../src/archive.ts";
import { ReasoningRouter } from "../src/reasoning_router.ts";
import { CharacterTokenEstimator } from "../src/token_estimator.ts";
import { FakeChatClient, silentLogger, testConfig } from "./helpers.ts";
import type { AnthropicMessage } from "../src/types.ts";

// The primary and condenser get separate fake clients, as in
// test/server.integration.ts, so `primary.requests[0]` is unambiguously the
// request the loop breaker shaped.
const routerWith = (loop_breaker_overrides: Record<string, unknown>, primary: FakeChatClient) => {
  const config = testConfig({
    loop_breaker: {
      enabled: true,
      threshold: 3,
      max_injections: 3,
      decay_after_clean: 2,
      ...loop_breaker_overrides,
    },
  });
  const estimator = new CharacterTokenEstimator(4);
  const policy = new ReasoningCondensationPolicy(config, estimator);
  const condenser_client = new FakeChatClient({
    choices: [{ message: { content: '{"reasoning":"Checked."}' } }],
  });
  const condenser = new ReasoningCondenser(config, condenser_client, policy, estimator);
  return new ReasoningRouter(
    config,
    primary,
    condenser,
    new NullTurnArchive(),
    estimator,
    silentLogger,
    new LoopBreakerState(),
  );
};

const stalledAnthropicMessages = (): AnthropicMessage[] => {
  const messages: AnthropicMessage[] = [{ role: "user", content: "Monitor the job." }];
  for (let index = 1; index <= 3; index += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${index}`, name: "Bash", input: { command: "tail -5 log" } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${index}`, content: "step 5/50 done" }],
    });
  }
  // Claude Code appends this to every request once a session has usage.
  messages.push({ role: "system", content: "<total_tokens>1 tokens left</total_tokens>" });
  return messages;
};

// No reasoning_content, so condensation stays below the threshold and the
// primary request is the only thing under test.
const textResponse = () => ({
  id: "chatcmpl_router",
  model: "primary-model",
  choices: [{ message: { content: "Reporting status." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

test("the router injects a notice for a stalled Claude Code request", async () => {
  const client = new FakeChatClient(textResponse());
  const router = routerWith({}, client);

  await router.route({
    model: "alias",
    max_tokens: 100,
    system: "sys",
    messages: stalledAnthropicMessages(),
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
  });

  const sent = client.requests[0]!;
  assert.match(String(sent.messages.at(-1)?.content), /Operator notice/);
});

test("the router leaves an unstalled request alone", async () => {
  const client = new FakeChatClient(textResponse());
  const router = routerWith({}, client);

  await router.route({
    model: "alias",
    max_tokens: 100,
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
  });

  const sent = client.requests[0]!;
  assert.doesNotMatch(String(sent.messages.at(-1)?.content ?? ""), /Operator/);
});

test("a disabled breaker changes nothing", async () => {
  const client = new FakeChatClient(textResponse());
  const router = routerWith({ enabled: false }, client);

  await router.route({
    model: "alias",
    max_tokens: 100,
    system: "sys",
    messages: stalledAnthropicMessages(),
  });

  const sent = client.requests[0]!;
  assert.doesNotMatch(String(sent.messages.at(-1)?.content ?? ""), /Operator/);
});

test("a hard-stopped request carries no remaining tool affordance", async () => {
  const client = new FakeChatClient(textResponse());
  const router = routerWith({ max_injections: 1 }, client);

  await router.route({
    model: "alias",
    max_tokens: 100,
    system: "sys",
    messages: stalledAnthropicMessages(),
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    // `disable_parallel_tool_use` is what makes the converted request carry
    // `parallel_tool_calls` at all; without it the assertion below would hold
    // whether or not the breaker strips the field.
    tool_choice: { type: "auto", disable_parallel_tool_use: false },
  });

  const sent = client.requests[0]!;
  assert.equal("tools" in sent, false);
  assert.equal("tool_choice" in sent, false);
  assert.equal("parallel_tool_calls" in sent, false);
  assert.match(String(sent.messages.at(-1)?.content), /Operator hard stop/);
});

test("the OpenAI route is covered by the same breaker", async () => {
  const client = new FakeChatClient(textResponse());
  const router = routerWith({}, client);
  const messages = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "Monitor the job." },
  ];
  for (let index = 1; index <= 3; index += 1) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: `c${index}`, type: "function", function: { name: "bash", arguments: `{"c":"tail"}` } },
      ],
    } as never);
    messages.push({ role: "tool", tool_call_id: `c${index}`, content: "same" } as never);
  }

  await router.routeOpenAi({ model: "alias", messages });

  const sent = client.requests[0]!;
  assert.match(String(sent.messages.at(-1)?.content), /Operator notice/);
});
