import assert from "node:assert/strict";
import test from "node:test";
import { InvalidUpstreamResponse, normalizeOpenAiResponse } from "../src/normalized_turn.ts";

test("normalizes separated reasoning, text, usage, and tool calls", () => {
  const turn = normalizeOpenAiResponse(
    {
      id: "chatcmpl_1",
      model: "primary-model",
      choices: [
        {
          message: {
            content: "Calling the tool.",
            reasoning_content: "The exact file must be opened.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"src/main.ts"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    },
    "requested",
  );

  assert.equal(turn.reasoning, "The exact file must be opened.");
  assert.equal(turn.text, "Calling the tool.");
  assert.equal(turn.stop_reason, "tool_use");
  assert.deepEqual(turn.tool_calls, [
    {
      id: "call_1",
      name: "read_file",
      input: { path: "src/main.ts" },
      arguments_text: '{"path":"src/main.ts"}',
    },
  ]);
  assert.deepEqual(turn.upstream_usage, { input_tokens: 120, output_tokens: 30 });
});

test("extracts inline think tags when the upstream does not separate reasoning", () => {
  const turn = normalizeOpenAiResponse(
    {
      choices: [
        {
          message: { content: "<think>Inspect the evidence.</think>\nThe result is sound." },
          finish_reason: "stop",
        },
      ],
    },
    "primary-model",
  );

  assert.equal(turn.reasoning, "Inspect the evidence.");
  assert.equal(turn.text, "The result is sound.");
  assert.equal(turn.stop_reason, "end_turn");
});

test("rejects malformed tool arguments instead of changing their meaning", () => {
  assert.throws(
    () =>
      normalizeOpenAiResponse(
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "bad", type: "function", function: { name: "write", arguments: "{broken" } },
                ],
              },
            },
          ],
        },
        "primary-model",
      ),
    InvalidUpstreamResponse,
  );
});
