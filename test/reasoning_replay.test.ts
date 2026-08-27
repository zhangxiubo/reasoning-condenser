import assert from "node:assert/strict";
import test from "node:test";
import { applyReasoningReplay } from "../src/reasoning_replay.ts";
import type { OpenAiChatRequest } from "../src/types.ts";

const request: OpenAiChatRequest = {
  model: "model",
  stream: false,
  messages: [
    { role: "user", content: "Inspect the project." },
    {
      role: "assistant",
      reasoning_content: "The configuration file contains the relevant setting.",
      content: "I found the setting.",
    },
    { role: "user", content: "Continue." },
  ],
};

test("keeps historical reasoning in its dedicated field by default", () => {
  const replayed = applyReasoningReplay(request, "reasoning_content");

  assert.deepEqual(replayed.messages, request.messages);
});

test("moves historical reasoning into assistant content for endpoints that ignore its field", () => {
  const replayed = applyReasoningReplay(request, "assistant_content");
  const assistant = replayed.messages.find((message) => message.role === "assistant");

  assert.equal(assistant?.reasoning_content, undefined);
  assert.equal(
    assistant?.content,
    "<think>\nThe configuration file contains the relevant setting.\n</think>\n\nI found the setting.",
  );
});

test("preserves array content and tool calls while moving historical reasoning", () => {
  const replayed = applyReasoningReplay(
    {
      ...request,
      messages: [
        {
          role: "assistant",
          reasoning_content: "Call the read tool next.",
          content: [{ type: "text", text: "Reading now." }],
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: "{\"path\":\"README.md\"}" },
            },
          ],
        },
      ],
    },
    "assistant_content",
  );
  const [assistant] = replayed.messages;

  assert.ok(assistant);
  assert.deepEqual(assistant.content, [
    { type: "text", text: "<think>\nCall the read tool next.\n</think>" },
    { type: "text", text: "Reading now." },
  ]);
  assert.equal(assistant.tool_calls?.[0]?.function.name, "read");
});
