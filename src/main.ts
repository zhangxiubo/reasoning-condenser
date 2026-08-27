import { createTurnArchive } from "./archive.ts";
import { loadConfig } from "./config.ts";
import { ReasoningCondenser, ReasoningCondensationPolicy } from "./condensation.ts";
import { jsonLogger } from "./logger.ts";
import { OpenAiClient } from "./openai_client.ts";
import { ReasoningRouter } from "./reasoning_router.ts";
import { createAppServer } from "./server.ts";
import { CharacterTokenEstimator } from "./token_estimator.ts";

const config = loadConfig();
const token_estimator = new CharacterTokenEstimator(config.estimated_characters_per_token);
const primary_client = new OpenAiClient(config.primary);
const condenser_client = new OpenAiClient(config.condenser);
const policy = new ReasoningCondensationPolicy(config, token_estimator);
const condenser = new ReasoningCondenser(config, condenser_client, policy, token_estimator);
const archive = createTurnArchive(config.archive_path);
const router = new ReasoningRouter(
  config,
  primary_client,
  condenser,
  archive,
  token_estimator,
  jsonLogger,
);
const server = createAppServer(config, router, jsonLogger);

server.listen(config.port, config.host, () => {
  jsonLogger.info("server_started", {
    host: config.host,
    port: config.port,
    primary_url: config.primary.base_url,
    primary_model: config.primary.model,
    condenser_url: config.condenser.base_url,
    condenser_model: config.condenser.model,
    reasoning_replay_mode: config.reasoning_replay_mode,
    condensation_enabled: config.condensation_enabled,
    condensation_smoke_tag_enabled: config.condensation_smoke_tag_enabled,
  });
});

const shutdown = (signal: string): void => {
  jsonLogger.info("server_stopping", { signal });
  server.close((error) => {
    if (error) {
      jsonLogger.error("server_stop_failed", { error: error.message });
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
