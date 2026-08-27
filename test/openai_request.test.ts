import assert from "node:assert/strict";
import test from "node:test";
import { InvalidOpenAiRequest, prepareOpenAiRequest } from "../src/openai_request.ts";

test("prepares an OpenAI request while preserving agent options and historical reasoning", () => {
  const prepared = prepareOpenAiRequest(
    {
      model: "agent-alias",
      messages: [
        { role: "developer", content: "Use tools carefully." },
        { role: "user", content: "Continue the task." },
        {
          role: "assistant",
          content: "Earlier result.",
          reasoning: "Condensed historical state.",
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 4096,
      reasoning_effort: "medium",
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
      seed: 17,
    },
    "primary-model",
  );

  assert.equal(prepared.model, "primary-model");
  assert.equal(prepared.stream, false);
  assert.equal(prepared.stream_options, undefined);
  assert.equal(prepared.max_completion_tokens, 4096);
  assert.equal(prepared.seed, 17);
  assert.equal(prepared.messages[2]?.reasoning_content, "Condensed historical state.");
  assert.equal(prepared.messages[2]?.reasoning, undefined);
  assert.deepEqual(prepared.chat_template_kwargs, { enable_thinking: true, preserve_thinking: true });
});

test("enables preservation when a Chat Completions client does not specify it", () => {
  const prepared = prepareOpenAiRequest(
    { model: "alias", messages: [{ role: "user", content: "test" }] },
    "primary-model",
  );

  assert.deepEqual(prepared.chat_template_kwargs, { preserve_thinking: true });
});

test("omits preservation for endpoints that reject chat-template options", () => {
  const prepared = prepareOpenAiRequest(
    { model: "alias", messages: [{ role: "user", content: "test" }] },
    "primary-model",
    false,
  );

  assert.equal(prepared.chat_template_kwargs, undefined);
});

test("rejects empty prompts and multiple completion choices", () => {
  assert.throws(
    () => prepareOpenAiRequest({ model: "alias", messages: [] }, "primary-model"),
    InvalidOpenAiRequest,
  );
  assert.throws(
    () =>
      prepareOpenAiRequest(
        { model: "alias", messages: [{ role: "user", content: "test" }], n: 2 },
        "primary-model",
      ),
    /Only one completion choice/,
  );
});
