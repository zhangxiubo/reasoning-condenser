import assert from "node:assert/strict";
import test from "node:test";
import { NullTurnArchive } from "../src/archive.ts";
import { ReasoningCondenser, ReasoningCondensationPolicy } from "../src/condensation.ts";
import { ReasoningRouter } from "../src/reasoning_router.ts";
import { CharacterTokenEstimator } from "../src/token_estimator.ts";
import { FakeChatClient, silentLogger, testConfig } from "./helpers.ts";

test("estimates input tokens for Claude Code count_tokens requests", () => {
  const config = testConfig();
  const estimator = new CharacterTokenEstimator(4);
  const client = new FakeChatClient({ choices: [{ message: { content: "unused" } }] });
  const condenser = new ReasoningCondenser(
    config,
    client,
    new ReasoningCondensationPolicy(config, estimator),
    estimator,
  );
  const router = new ReasoningRouter(
    config,
    client,
    condenser,
    new NullTurnArchive(),
    estimator,
    silentLogger,
  );

  const count = router.countInputTokens({
    model: "alias",
    system: "System instructions",
    messages: [{ role: "user", content: "A request with enough content to count" }],
  });

  assert.ok(count > 1);
  assert.equal(client.requests.length, 0);
});
