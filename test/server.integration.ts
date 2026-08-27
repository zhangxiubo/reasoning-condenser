import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { NullTurnArchive } from "../src/archive.ts";
import { ReasoningCondenser, ReasoningCondensationPolicy } from "../src/condensation.ts";
import { ReasoningRouter } from "../src/reasoning_router.ts";
import { createAppServer } from "../src/server.ts";
import { CharacterTokenEstimator } from "../src/token_estimator.ts";
import { FakeChatClient, silentLogger, testConfig } from "./helpers.ts";

test("serves a buffered, condensed Anthropic response", async () => {
  const config = testConfig();
  const estimator = new CharacterTokenEstimator(1);
  const primary = new FakeChatClient({
    id: "chatcmpl_server",
    model: "primary-model",
    choices: [
      {
        message: {
          reasoning_content: "Exploratory reasoning. ".repeat(30),
          content: "Finished without changing the final response.",
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 300, completion_tokens: 200 },
  });
  const condenser_client = new FakeChatClient({
    choices: [{ message: { content: '{"reasoning":"Verified the result."}' } }],
  });
  const condenser = new ReasoningCondenser(
    config,
    condenser_client,
    new ReasoningCondensationPolicy(config, estimator),
    estimator,
  );
  const router = new ReasoningRouter(
    config,
    primary,
    condenser,
    new NullTurnArchive(),
    estimator,
    silentLogger,
  );
  const server = createAppServer(config, router, silentLogger);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-code-alias",
        max_tokens: 1000,
        messages: [{ role: "user", content: "Complete the task." }],
        stream: false,
      }),
    });
    const body = await response.json() as {
      content: Array<{ type: string; thinking?: string; text?: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-rcr-condensation-status"), "condensed");
    assert.equal(body.content[0]?.thinking, "Verified the result.");
    assert.equal(body.content[1]?.text, "Finished without changing the final response.");
    assert.equal(primary.requests[0]?.stream, false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("serves buffered OpenAI JSON, SSE, and model discovery", async () => {
  const config = testConfig({ reasoning_replay_mode: "assistant_content" });
  const estimator = new CharacterTokenEstimator(1);
  const primary = new FakeChatClient({
    id: "chatcmpl_openai",
    model: "primary-model",
    choices: [
      {
        message: {
          reasoning_content: "Original reasoning. ".repeat(30),
          content: "Unmodified final response.",
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 250, completion_tokens: 180 },
  });
  const condenser_client = new FakeChatClient({
    choices: [{ message: { content: '{"reasoning":"Condensed state."}' } }],
  });
  const condenser = new ReasoningCondenser(
    config,
    condenser_client,
    new ReasoningCondensationPolicy(config, estimator),
    estimator,
  );
  const router = new ReasoningRouter(
    config,
    primary,
    condenser,
    new NullTurnArchive(),
    estimator,
    silentLogger,
  );
  const server = createAppServer(config, router, silentLogger);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address() as AddressInfo;
    const base_url = `http://127.0.0.1:${address.port}/v1`;
    const models = await fetch(`${base_url}/models`).then((response) => response.json()) as {
      data: Array<{ id: string }>;
    };
    assert.equal(models.data[0]?.id, "primary-model");

    const body = {
      model: "primary-model",
      messages: [
        {
          role: "assistant",
          reasoning_content: "Condensed historical state.",
          content: "Earlier result.",
        },
        { role: "user", content: "Complete the task." },
      ],
      stream: false,
    };
    const json_response = await fetch(`${base_url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local" },
      body: JSON.stringify(body),
    });
    const json = await json_response.json() as {
      choices: Array<{ message: { content: string; reasoning_content: string } }>;
    };
    assert.equal(json_response.headers.get("x-rcr-condensation-status"), "condensed");
    assert.equal(json.choices[0]?.message.reasoning_content, "Condensed state.");
    assert.equal(json.choices[0]?.message.content, "Unmodified final response.");
    assert.equal(primary.requests[0]?.messages[0]?.reasoning_content, undefined);
    assert.equal(
      primary.requests[0]?.messages[0]?.content,
      "<think>\nCondensed historical state.\n</think>\n\nEarlier result.",
    );

    const stream_response = await fetch(`${base_url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local" },
      body: JSON.stringify({ ...body, stream: true }),
    });
    const stream = await stream_response.text();
    assert.match(stream, /reasoning_content/);
    assert.match(stream, /data: \[DONE\]/);
    assert.equal(primary.requests.every((request) => request.stream === false), true);
  } finally {
    server.close();
    await once(server, "close");
  }
});
