import assert from "node:assert/strict";
import test from "node:test";
import { toOpenAiRequest } from "../src/anthropic_request.ts";
import type { AnthropicMessagesRequest } from "../src/types.ts";

test("converts preserved thinking and a tool exchange into OpenAI chat history", () => {
  const request: AnthropicMessagesRequest = {
    model: "claude-code-alias",
    max_tokens: 4096,
    system: [{ type: "text", text: "You are a coding agent." }],
    messages: [
      { role: "user", content: "Inspect the project." },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should list the files.", signature: "local" },
          { type: "text", text: "I will inspect it." },
          { type: "tool_use", id: "tool_1", name: "list_files", input: { depth: 2 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool_1", content: "src/main.ts\ntest/main.test.ts" },
        ],
      },
    ],
    tools: [
      {
        name: "list_files",
        description: "List project files",
        input_schema: { type: "object", properties: { depth: { type: "number" } } },
      },
    ],
    tool_choice: { type: "any", disable_parallel_tool_use: true },
  };

  const converted = toOpenAiRequest(request, "primary-model");

  assert.equal(converted.model, "primary-model");
  assert.equal(converted.stream, false);
  assert.deepEqual(converted.chat_template_kwargs, { preserve_thinking: true });
  assert.deepEqual(converted.messages, [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Inspect the project." },
    {
      role: "assistant",
      content: "I will inspect it.",
      reasoning_content: "I should list the files.",
      tool_calls: [
        {
          id: "tool_1",
          type: "function",
          function: { name: "list_files", arguments: '{"depth":2}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "tool_1", content: "src/main.ts\ntest/main.test.ts" },
  ]);
  assert.equal(converted.tool_choice, "required");
  assert.equal(converted.parallel_tool_calls, false);
});

test("marks failed Anthropic tool results for the upstream model", () => {
  const converted = toOpenAiRequest(
    {
      model: "alias",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_2", content: "permission denied", is_error: true }],
        },
      ],
    },
    "primary-model",
  );

  assert.equal(converted.messages[0]?.content, "[tool_error]\npermission denied");
});

test("preserved condensed thinking survives the next request conversion", () => {
  const converted = toOpenAiRequest(
    {
      model: "alias",
      max_tokens: 100,
      messages: [
        { role: "user", content: "First task" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Compact state retained for the next turn.",
              signature: "local-rcr:digest",
            },
            { type: "text", text: "First task complete." },
          ],
        },
        { role: "user", content: "Continue." },
      ],
    },
    "primary-model",
  );

  const historical_assistant = converted.messages.find((message) => message.role === "assistant");
  assert.equal(historical_assistant?.reasoning_content, "Compact state retained for the next turn.");
});

test("omits preservation for endpoints that reject chat-template options", () => {
  const converted = toOpenAiRequest(
    {
      model: "alias",
      max_tokens: 100,
      messages: [{ role: "user", content: "Test" }],
    },
    "primary-model",
    false,
  );

  assert.equal(converted.chat_template_kwargs, undefined);
});
