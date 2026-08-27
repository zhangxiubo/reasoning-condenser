import assert from "node:assert/strict";
import test from "node:test";
import { anthropicStreamEvents, encodeAnthropicStream, toAnthropicResponse } from "../src/anthropic_response.ts";

test("serializes reasoning, final text, and tools in Anthropic order", () => {
  const response = toAnthropicResponse(
    {
      id: "chatcmpl_1",
      model: "primary-model",
      reasoning: "Compact working state.",
      text: "I will inspect the file.",
      tool_calls: [{ id: "call_1", name: "read_file", input: { path: "src/main.ts" } }],
      stop_reason: "tool_use",
      upstream_usage: { input_tokens: 90, output_tokens: 40 },
    },
    "claude-code-alias",
    { input_tokens: 90, output_tokens: 25 },
  );

  assert.deepEqual(response.content.map((block) => block.type), ["thinking", "text", "tool_use"]);
  const thinking_block = response.content.find((block) => block.type === "thinking");
  assert.match(thinking_block?.signature ?? "", /^local-rcr:/);
  assert.equal(response.model, "claude-code-alias");
  assert.equal(response.stop_reason, "tool_use");

  const events = anthropicStreamEvents(response);
  assert.equal(events.at(0)?.event, "message_start");
  assert.equal(events.at(-1)?.event, "message_stop");
  assert.match(encodeAnthropicStream(response), /event: content_block_delta/);
  assert.match(encodeAnthropicStream(response), /input_json_delta/);
});
