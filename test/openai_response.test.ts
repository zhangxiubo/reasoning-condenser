import assert from "node:assert/strict";
import test from "node:test";
import { encodeOpenAiStream, toOpenAiResponse } from "../src/openai_response.ts";

test("serializes condensed reasoning, final text, tools, and usage as OpenAI Chat Completions", () => {
  const response = toOpenAiResponse(
    {
      id: "chatcmpl-upstream",
      model: "primary-model",
      reasoning: "Compact state.",
      text: "I will inspect the file.",
      tool_calls: [{ id: "call_1", name: "read_file", input: { path: "src/main.ts" } }],
      stop_reason: "tool_use",
      upstream_usage: { input_tokens: 200, output_tokens: 80 },
    },
    "primary-model",
    { input_tokens: 200, output_tokens: 35 },
  );

  assert.equal(response.choices[0]?.message.reasoning_content, "Compact state.");
  assert.equal(response.choices[0]?.message.content, "I will inspect the file.");
  assert.equal(response.choices[0]?.message.tool_calls?.[0]?.function.arguments, '{"path":"src/main.ts"}');
  assert.equal(response.choices[0]?.finish_reason, "tool_calls");
  assert.deepEqual(response.usage, { prompt_tokens: 200, completion_tokens: 35, total_tokens: 235 });

  const stream = encodeOpenAiStream(response);
  assert.match(stream, /reasoning_content/);
  assert.match(stream, /tool_calls/);
  assert.match(stream, /"choices":\[\],"usage":/);
  assert.match(stream, /data: \[DONE\]/);
});

test("preserves the original tool argument text", () => {
  const response = toOpenAiResponse(
    {
      id: "chatcmpl-tool-text",
      model: "primary-model",
      reasoning: "Read the requested file.",
      text: "",
      tool_calls: [
        {
          id: "call_exact",
          name: "read_file",
          input: { path: "src/main.ts" },
          arguments_text: '{ "path" : "src/main.ts" }',
        },
      ],
      stop_reason: "tool_use",
      upstream_usage: { input_tokens: 100, output_tokens: 20 },
    },
    "primary-model",
    { input_tokens: 100, output_tokens: 20 },
  );

  assert.equal(
    response.choices[0]?.message.tool_calls?.[0]?.function.arguments,
    '{ "path" : "src/main.ts" }',
  );
});
