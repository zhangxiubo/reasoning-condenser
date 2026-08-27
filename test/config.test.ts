import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("loads strict condensation configuration", () => {
  const config = loadConfig({
    CONDENSATION_ENABLED: "false",
    CONDENSE_COMPLETED_RATIO: "0.2",
    CONDENSE_TOOL_RATIO: "0.4",
  });

  assert.equal(config.condensation_enabled, false);
  assert.equal(config.condensation_smoke_tag_enabled, false);
  assert.equal(config.primary_preserve_thinking, true);
  assert.equal(config.condenser_enable_thinking, true);
  assert.equal(config.reasoning_replay_mode, "reasoning_content");
  assert.equal(config.profiles.completed_response.target_ratio, 0.2);
  assert.equal(config.profiles.tool_continuation.target_ratio, 0.4);
  assert.equal(config.condenser_max_output_tokens, 4_096);
});

test("allows the diagnostic condensation tag to be enabled", () => {
  const config = loadConfig({ CONDENSATION_SMOKE_TAG_ENABLED: "true" });

  assert.equal(config.condensation_smoke_tag_enabled, true);
});

test("allows condenser thinking to be disabled explicitly", () => {
  const config = loadConfig({ CONDENSER_ENABLE_THINKING: "false" });

  assert.equal(config.condenser_enable_thinking, false);
});

test("allows primary preservation options to be disabled explicitly", () => {
  const config = loadConfig({ PRIMARY_PRESERVE_THINKING: "false" });

  assert.equal(config.primary_preserve_thinking, false);
});

test("allows historical reasoning to replay as assistant content", () => {
  const config = loadConfig({ UPSTREAM_REASONING_REPLAY_MODE: "assistant_content" });

  assert.equal(config.reasoning_replay_mode, "assistant_content");
});

test("rejects ambiguous booleans and ratios above one", () => {
  assert.throws(() => loadConfig({ CONDENSATION_ENABLED: "sometimes" }), /Expected a boolean value/);
  assert.throws(() => loadConfig({ CONDENSE_TOOL_RATIO: "1.1" }), /must not exceed 1/);
  assert.throws(() => loadConfig({ UPSTREAM_REASONING_REPLAY_MODE: "automatic" }), /must be/);
});
