# Reasoning Condensation Router

Reasoning Condensation Router is a buffered reasoning proxy for coding agents and OpenAI-compatible reasoning models. It accepts Anthropic Messages and OpenAI Chat Completions requests, so it can serve Claude Code, OpenCode, Pi, and other compatible clients.

The router buffers each complete primary response, gives the exposed reasoning and final response to a separately configured condensation model, replaces only the reasoning, and then returns the response in the client's protocol. The smaller reasoning block is what the client retains and sends back on later turns.

The router never changes final text, tool names, tool identifiers, tool arguments, tool order, or stop reasons. If condensation fails or does not make the reasoning smaller, it returns the original reasoning.

## Data path

```text
Claude Code, OpenCode, Pi, or another compatible client
    │ Anthropic /v1/messages or OpenAI /v1/chat/completions
    ▼
Reasoning Condensation Router
    │ OpenAI /v1/chat/completions, stream=false
    ▼
Primary reasoning model
    │ separated reasoning + final text + tool calls
    ▼
Condensation model
    │ compact replacement reasoning
    ▼
Reasoning Condensation Router
    │ buffered JSON or synthesized protocol-matching SSE
    ▼
Coding agent
```

On the next turn, historical Anthropic `thinking` blocks or OpenAI `reasoning_content` fields are normalized and replayed according to `UPSTREAM_REASONING_REPLAY_MODE`.

Some endpoints consume historical assistant `reasoning_content` directly. Others return that field but ignore it in later model input. For the latter, `assistant_content` replay moves the condensed reasoning into an historical `<think>` block inside assistant content.

## Primary-response contract

The primary endpoint must expose an OpenAI-compatible `/v1/chat/completions` API. The router recognizes reasoning in this order:

1. `message.reasoning_content`
2. `message.reasoning`
3. `message.thinking`
4. A leading `<think>...</think>` block in `message.content`

Separated reasoning takes precedence. Inline extraction is a compatibility fallback.

The primary response may contain standard OpenAI `tool_calls`. Tool argument text must parse as a JSON object. Invalid arguments fail the request because silently changing them could change the requested action.

## Model compatibility profiles

Reasoning extraction is broadly compatible, but historical replay and thinking controls remain provider-specific. Treat these settings as a model profile rather than assuming one configuration works everywhere.

### Dedicated reasoning field

Use this when the endpoint consumes historical assistant `reasoning_content`:

```dotenv
UPSTREAM_REASONING_REPLAY_MODE=reasoning_content
```

### Reasoning embedded in assistant content

Use this only after a history comparison proves that the endpoint ignores the dedicated field:

```dotenv
UPSTREAM_REASONING_REPLAY_MODE=assistant_content
```

### Chat-template preservation option

By default, the router adds:

```json
{
  "chat_template_kwargs": {
    "preserve_thinking": true
  }
}
```

This supports llama.cpp and other chat-template servers that expose preserved reasoning. Disable it for strict endpoints that reject unknown chat-template options:

```dotenv
PRIMARY_PRESERVE_THINKING=false
```

An OpenAI Chat Completions client may also supply its own `chat_template_kwargs`; explicit client values are retained.

## Example: llama.cpp with Qwen

The exact arguments depend on the llama.cpp revision and selected model. A representative primary command is:

```bash
llama-server \
  --model /models/Qwen3.8-27B-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --jinja \
  --reasoning-format deepseek \
  --chat-template-kwargs '{"preserve_thinking":true}'
```

The important behavior is:

- The response contains separate `reasoning_content` and `content` fields.
- Historical assistant `reasoning_content` is serialized into the next prompt.
- Tool calls use OpenAI-compatible `tool_calls` objects.

A smaller condensation model can run separately:

```bash
llama-server \
  --model /models/Qwen3.8-4B-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8081 \
  --jinja
```

Using the same endpoint and model for both stages is supported. Set `CONDENSER_BASE_URL` and `CONDENSER_MODEL` to the primary values. Calls are sequential within one routed turn, so this does not recurse through the proxy.

## Requirements

- Node.js 22.18 or newer.
- A primary model endpoint exposing OpenAI-compatible `/v1/chat/completions`.
- A second compatible endpoint for condensation, or permission to reuse the primary endpoint sequentially.
- Reasoning exposed through a recognized field or a leading inline `<think>` block.

## Configure and run

```bash
npm install
cp .env.example .env
npm start
```

The default proxy address is `http://127.0.0.1:3456`.

When `PROXY_API_KEY` is empty, the proxy accepts any supplied local token. When configured, it accepts the matching `x-api-key` or Bearer token.

### Claude Code

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3456 \
ANTHROPIC_API_KEY=local \
claude --model reasoning-model
```

The model name sent by the client is the public alias returned to the client. The primary call always uses `PRIMARY_MODEL`.

### OpenCode

Create `opencode.json` in the project that should use the proxy:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "rcr/reasoning-model",
  "provider": {
    "rcr": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Reasoning Condensation Router",
      "options": {
        "baseURL": "http://127.0.0.1:3456/v1",
        "apiKey": "local"
      },
      "models": {
        "reasoning-model": {
          "name": "Reasoning Model through RCR",
          "reasoning": true,
          "interleaved": { "field": "reasoning_content" },
          "tool_call": true,
          "limit": { "context": 262144, "output": 32768 }
        }
      }
    }
  }
}
```

Then run:

```bash
opencode run --model rcr/reasoning-model --variant low "Inspect this project"
```

The `interleaved` setting tells OpenCode to store and replay `reasoning_content` alongside the assistant response.

#### OpenCode Go with DeepSeek V4 Flash

This checkout includes a development launcher. It reads `OPENCODE_GO_API_KEY` from `OPENCODE_GO_CREDENTIAL_FILE`, which defaults to the repository's ignored `.env` file:

```bash
npm run start:opencode-go
```

The checked-in `opencode.json` selects `rcr/deepseek-v4-flash`.

DeepSeek V4 Flash on OpenCode Go ignores historical `reasoning_content`. The launcher therefore selects `assistant_content` replay so the condensed state is included in later input.

### Pi

Add a provider to `~/.pi/agent/models.json`. Compatibility options depend on the primary endpoint. This example is for a local Qwen chat template:

```json
{
  "providers": {
    "rcr": {
      "baseUrl": "http://127.0.0.1:3456/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [
        {
          "id": "reasoning-model",
          "name": "Reasoning Model through RCR",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 262144,
          "maxTokens": 32768,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "compat": {
            "supportsDeveloperRole": true,
            "supportsReasoningEffort": true,
            "maxTokensField": "max_tokens",
            "thinkingFormat": "qwen-chat-template"
          }
        }
      ]
    }
  }
}
```

Then run:

```bash
pi --provider rcr --model reasoning-model --api-key local --thinking low
```

For another provider, select the Pi compatibility options that match that endpoint. The router itself returns condensed reasoning as `reasoning_content` on its OpenAI interface.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `HOST` | `127.0.0.1` | Proxy listen address |
| `PORT` | `3456` | Proxy listen port |
| `PRIMARY_BASE_URL` | `http://127.0.0.1:8080/v1` | Primary OpenAI-compatible API root |
| `PRIMARY_MODEL` | `reasoning-model` | Primary model sent upstream |
| `PRIMARY_API_KEY` | empty | Optional primary endpoint key |
| `PRIMARY_TIMEOUT_MS` | `900000` | Primary completion timeout |
| `PRIMARY_PRESERVE_THINKING` | `true` | Adds `chat_template_kwargs.preserve_thinking` by default |
| `CONDENSATION_ENABLED` | `true` | Enables reasoning replacement |
| `CONDENSATION_SMOKE_TAG_ENABLED` | `false` | Prefixes successful replacements with visible original and delivered estimates for testing |
| `CONDENSER_BASE_URL` | `http://127.0.0.1:8081/v1` | Condensation API root |
| `CONDENSER_MODEL` | `condensation-model` | Condensation model |
| `CONDENSER_API_KEY` | empty | Optional condensation endpoint key |
| `CONDENSER_TIMEOUT_MS` | `180000` | Condensation timeout |
| `CONDENSER_ENABLE_THINKING` | `true` | Enables the condenser model's own reasoning before it writes replacement JSON |
| `CONDENSER_REASONING_EFFORT` | `low` | Reasoning effort sent to the condenser |
| `CONDENSER_MAX_OUTPUT_TOKENS` | `4096` | Total condenser allowance shared by its own reasoning and final JSON |
| `UPSTREAM_REASONING_REPLAY_MODE` | `reasoning_content` | Historical replay form: `reasoning_content` or `assistant_content` |
| `CONDENSE_MIN_REASONING_TOKENS` | `512` | Estimated size below which reasoning passes through |
| `CONDENSE_COMPLETED_MAX_TOKENS` | `768` | Maximum summary budget after a completed answer |
| `CONDENSE_COMPLETED_RATIO` | `0.15` | Target completed-answer compression ratio |
| `CONDENSE_TOOL_MAX_TOKENS` | `1200` | Maximum summary budget before tool execution |
| `CONDENSE_TOOL_RATIO` | `0.35` | Conservative tool-continuation ratio |
| `ARCHIVE_PATH` | empty | Optional append-only JSON Lines archive of original turns |
| `PROXY_API_KEY` | empty | Optional local proxy secret |
| `ESTIMATED_CHARACTERS_PER_TOKEN` | `3.5` | Visible token-count approximation |
| `MAX_REQUEST_BYTES` | `10485760` | Maximum accepted request body |

`CONDENSER_MAX_OUTPUT_TOKENS` is the total generation allowance for the condenser's own reasoning and final JSON. Profile ratios and maximums independently set the requested size of replacement reasoning. A result is accepted only when its estimated reasoning size is smaller than the original.

The smoke tag is intended only for verification. Its size is included in the delivered estimate and smaller-than-original check. Leave it disabled after testing.

## Response behavior

The primary call is always non-streaming. This is deliberate: the final response must be available to the condenser before any original reasoning reaches the coding agent.

If a client asks for streaming, the proxy emits a valid Anthropic or OpenAI event stream after condensation finishes. The stream is synthesized from the completed replacement response and does not improve time to first content.

Completed-answer turns and tool-continuation turns use separate policies. Tool-continuation summaries retain more state and receive a larger budget.

Condensation status and accounting are exposed in response headers:

```text
x-rcr-condensation-status
x-rcr-reasoning-original-tokens
x-rcr-reasoning-delivered-tokens
x-rcr-upstream-input-tokens
x-rcr-upstream-output-tokens
x-rcr-visible-output-tokens
```

The Anthropic-compatible `/v1/messages/count_tokens` endpoint returns an estimate and marks it with `x-rcr-token-count-estimated: true`. The OpenAI-compatible `/v1/models` endpoint advertises the configured primary model.

## Failure behavior

Condenser failures do not fail the primary request. Original reasoning is returned when:

- The condenser times out or returns an error.
- Its final content is not valid JSON with a non-empty `reasoning` string.
- Its result is not smaller than the original reasoning.
- The reasoning is below the configured threshold.

Malformed upstream tool arguments fail the request. Silently repairing tool JSON could change the requested action.

## Original-turn archive

Set `ARCHIVE_PATH=var/original-turns.jsonl` to retain original normalized turns for debugging. Each write opens, appends, and closes the file. The file is created with owner-only permissions when possible.

The archive can contain prompts, code, paths, command output, and secrets present in model reasoning. It is disabled by default and should remain local.

## Verification

```bash
npm run check
npm run test:integration
```

The integration test binds an ephemeral localhost port. Some restricted execution environments require additional permission.

To verify preservation end to end:

1. Send a request that produces substantial reasoning and one harmless tool call.
2. Confirm `x-rcr-condensation-status: condensed` or the corresponding structured log.
3. Send the tool result or another user turn in the same agent session.
4. Inspect the second primary-model prompt.
5. Confirm it contains condensed historical reasoning and not the original trace.

A hidden-marker tool test is stronger: retain a marker only in reasoning before the tool call, then require the post-tool turn to reproduce it. Successful recall proves that the client stored and replayed the delivered reasoning.

Live development checks have covered:

- OpenCode 1.18.21 and Pi 0.84.3 tool loops with Qwen3.8 27B on llama.cpp.
- Claude Code 2.1.245 text, synthesized streaming, reasoning signatures, tool-result replay, and hidden-state recovery using DeepSeek V4 Flash on OpenCode Go.
- A Claude tool-turn reasoning trace reduced from approximately 780 to 82 estimated tokens while preserving a marker needed after the tool result.

These are compatibility examples, not restrictions on supported model names.

## Current scope

The router targets coding agents and OpenAI-compatible endpoints that expose model reasoning. Provider-specific replay and thinking controls must be configured according to observed endpoint behavior.

The request adapters cover text and tool-use content used by coding sessions. Images on the Anthropic text-only route become explicit omission markers; OpenAI multimodal message content passes through to the primary endpoint. Token counts are estimates because the proxy does not load a provider-specific tokenizer.

The router is not intended to proxy real Anthropic model endpoints.

See [`docs/design.md`](docs/design.md) for internal contracts and extension points. The deployment-site handoff is in [`docs/deployment_agent_readme.md`](docs/deployment_agent_readme.md).
