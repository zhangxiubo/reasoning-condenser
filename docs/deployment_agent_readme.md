# Deployment Agent Handoff

## Purpose

This document gives the agent operating at the deployment site the context needed to deploy and verify Reasoning Condensation Router without disturbing unrelated CCR routes.

The intended result is to reduce future context consumption by replacing exposed model reasoning with a smaller state summary before a coding agent stores and replays it. The visible answer and tool calls must remain unchanged.

Reasoning Condensation Router is model-neutral. Qwen and llama.cpp appear throughout this handoff because they are the selected profile at this deployment site, not because the project is restricted to them.

## Known deployment-site situation

The deployment site already has:

- A CCR installation that authenticates clients and remaps model names.
- A llama.cpp server running Qwen3.8 27B or a closely related configured Qwen model.
- Coding agents that may include Claude Code, OpenCode, and Pi.

The exact CCR version, installation form, listener addresses, llama.cpp API root, and served model identifier have not been supplied. Discover them before changing configuration.

Do not assume the site's llama.cpp model identifier equals `qwen3.8-27b`. Use the exact identifier returned by its `/v1/models` endpoint.

## Correct position in the request path

The condensation behavior belongs after CCR has resolved the client model alias and before the selected request reaches the actual model endpoint.

```text
Coding agent
    -> CCR authentication and protocol parsing
    -> CCR model remapping and provider selection
    -> Reasoning Condensation Router
    -> llama.cpp and Qwen
```

The return path is:

```text
llama.cpp complete response
    -> Reasoning Condensation Router normalizes and buffers it
    -> condenser reads the current reasoning, final text, and tool calls
    -> Reasoning Condensation Router replaces only the reasoning
    -> CCR serializes the result for the client
    -> coding agent stores the condensed reasoning
```

Reasoning Condensation Router also handles the next request. It converts historical condensed reasoning into the replay representation required by the configured upstream.

Do not configure Reasoning Condensation Router's upstream URL to point back to the same CCR route. That creates a request cycle. Its primary and condenser URLs must ultimately reach llama.cpp or another final model service directly.

## What the condenser sees

The condenser receives only the current completed model turn:

- Original reasoning.
- Final visible response text.
- Exact normalized tool calls.
- A policy instruction and requested replacement size.

It does not receive the entire conversation history. It may use the final response to remove reasoning state already represented there. Tool-continuation turns use a more conservative retention policy than completed-answer turns.

The condenser returns JSON containing replacement reasoning. Reasoning Condensation Router rejects an invalid or non-smaller result and returns the original reasoning instead.

## Current protocol surface

Reasoning Condensation Router accepts:

```text
GET  /health
GET  /v1/models
POST /v1/chat/completions
POST /v1/messages
POST /v1/messages/count_tokens
```

Supported client-facing protocols are:

- OpenAI Chat Completions for Pi, OpenCode, and compatible clients.
- Anthropic Messages for Claude Code and compatible clients.

The upstream primary and condenser calls use OpenAI-compatible `/v1/chat/completions` with `stream=false`.

When a client requests streaming, Reasoning Condensation Router withholds the complete primary response, performs condensation, and then synthesizes a protocol-matching event stream. There is deliberately no early time to first content.

The project does not implement the OpenAI Responses API, embeddings, audio, or file APIs. It does not target real Anthropic model endpoints.

## Behavior that must not change

Successful condensation may replace reasoning only. It must not alter:

- Final visible text.
- Tool names.
- Tool identifiers.
- Tool argument text or parsed input.
- Tool order.
- Stop reason.

Malformed upstream tool arguments fail the request rather than being repaired.

## Current configuration model

One running Reasoning Condensation Router process has one fixed primary target and one fixed condenser target. Incoming requested model names are replaced with `PRIMARY_MODEL` before the primary call.

Consequences:

- One process is suitable for one actual model and replay policy.
- Several CCR aliases may use the process only when they are intended to reach the same actual model.
- Do not route several distinct CCR provider targets through one process and expect the original target selection to survive.
- Use separate processes or implement per-target profiles before supporting several actual models through one instance.

For llama.cpp and Qwen, begin with:

```dotenv
UPSTREAM_REASONING_REPLAY_MODE=reasoning_content
```

Use `assistant_content` only after direct prompt inspection proves that the endpoint ignores historical assistant `reasoning_content`.

Reasoning Condensation Router adds this to primary requests by default:

```json
{
  "chat_template_kwargs": {
    "preserve_thinking": true
  }
}
```

This behavior is controlled by:

```dotenv
PRIMARY_PRESERVE_THINKING=true
```

Set it to `false` for endpoints that reject chat-template options. Leave it enabled for this llama.cpp and Qwen profile unless direct testing shows different behavior.

The llama.cpp server should expose reasoning separately, normally as `reasoning_content`, and should preserve historical reasoning in the next rendered prompt. A representative llama.cpp setup uses `--jinja`, an appropriate reasoning format such as `deepseek`, and `preserve_thinking=true` in chat-template arguments.

## Required read-only discovery

Perform read-only discovery before editing CCR or starting a second service.

Collect, without exposing credentials:

```bash
ccr --version
command -v ccr
command -v node
node --version
ss -lntp
curl -fsS http://127.0.0.1:8000/v1/models
```

Adjust the llama.cpp address in the last command if discovery shows a different port or host.

Also determine:

- Whether CCR runs natively, under systemd, or in a container.
- Whether llama.cpp runs natively or in a container.
- Whether CCR uses the current management UI and SQLite configuration or an older `~/.claude-code-router/config.json` file.
- Which CCR aliases currently resolve to the Qwen provider.
- Whether the existing Qwen provider serves only one actual model or several.

Do not print complete configuration files that contain API keys. Report redacted provider names, protocols, URLs, model identifiers, and routing relationships only.

## Current source deployment

The repository does not yet contain the proposed production container, compiled JavaScript artifact, release archive, or systemd unit. Do not claim that those packages exist.

The current source checkout runs directly on Node.js 22.18 or newer:

```bash
npm ci
npm run check
npm run test:integration
npm start
```

The integration test opens an ephemeral localhost listener. Restricted environments may need explicit permission for that test.

Do not copy the development machine's `.env`; it may select OpenCode Go rather than the deployment site's llama.cpp service. Create the deployment `.env` from `.env.example` and discovered site values.

## Suggested single-model deployment configuration

The following is a template, not a statement of the site's actual port or model identifier:

```dotenv
HOST=127.0.0.1
PORT=3466
PROXY_API_KEY=replace-with-an-internal-secret

PRIMARY_BASE_URL=http://127.0.0.1:8000/v1
PRIMARY_MODEL=replace-with-exact-model-id
PRIMARY_API_KEY=
PRIMARY_TIMEOUT_MS=900000
PRIMARY_PRESERVE_THINKING=true

CONDENSATION_ENABLED=true
CONDENSATION_SMOKE_TAG_ENABLED=false

CONDENSER_BASE_URL=http://127.0.0.1:8000/v1
CONDENSER_MODEL=replace-with-exact-model-id
CONDENSER_API_KEY=
CONDENSER_TIMEOUT_MS=180000
CONDENSER_ENABLE_THINKING=true
CONDENSER_REASONING_EFFORT=low
CONDENSER_MAX_OUTPUT_TOKENS=4096

UPSTREAM_REASONING_REPLAY_MODE=reasoning_content
CONDENSE_MIN_REASONING_TOKENS=512
CONDENSE_COMPLETED_MAX_TOKENS=768
CONDENSE_COMPLETED_RATIO=0.15
CONDENSE_TOOL_MAX_TOKENS=1200
CONDENSE_TOOL_RATIO=0.35

ARCHIVE_PATH=
ESTIMATED_CHARACTERS_PER_TOKEN=3.5
MAX_REQUEST_BYTES=10485760
```

Using the same llama.cpp endpoint and model for the primary and condenser stages is supported. The two calls are sequential within one routed turn.

Keep `ARCHIVE_PATH` empty unless the operator explicitly authorizes retaining original reasoning. An archive may contain prompts, source code, file paths, command output, or secrets.

CCR commonly uses port `3456`, so the suggested Reasoning Condensation Router port is `3466`.

## Adding the internal CCR provider

### Current CCR management UI

Add a custom provider with values resembling:

```text
Name: rcr_qwen
Base URL: http://127.0.0.1:3466/v1
Protocol: OpenAI Chat Completions
API key: the value of PROXY_API_KEY
Models: the exact configured PRIMARY_MODEL
```

Run CCR's connection check. It sends a real model request.

If all traffic using the existing Qwen provider should be condensed and that provider represents only one actual model, editing that provider's endpoint to point at Reasoning Condensation Router preserves the existing routing relationships.

If only selected aliases should be condensed, add `rcr_qwen` alongside the direct llama.cpp provider and change only those aliases to the new provider.

### Older JSON-configured CCR

Older installations may expect a complete Chat Completions URL:

```json
{
  "name": "rcr_qwen",
  "api_base_url": "http://127.0.0.1:3466/v1/chat/completions",
  "api_key": "replace-with-PROXY_API_KEY",
  "models": ["replace-with-exact-model-id"]
}
```

Merge this object into the existing `Providers` array. Do not replace the complete CCR configuration or unrelated routes.

Back up or export the existing CCR configuration before mutation. Record an exact rollback action.

## Container networking warning

If CCR is inside a container, `127.0.0.1:3466` refers to the CCR container, not the host. If Reasoning Condensation Router is also containerized, put both on the same private container network and use its service name. If Reasoning Condensation Router runs on the host, use an explicitly configured host address reachable from CCR without exposing the service publicly.

Similarly, a containerized Reasoning Condensation Router cannot reach a host llama.cpp server that listens only on the host loopback address unless host networking or another deliberate private connection is configured.

Do not bind Reasoning Condensation Router publicly merely to work around container addressing.

## Verification sequence

### 1. Process checks

Verify Reasoning Condensation Router directly:

```bash
curl -fsS http://127.0.0.1:3466/health
curl -fsS -H "Authorization: Bearer replace-with-PROXY_API_KEY" \
  http://127.0.0.1:3466/v1/models
```

Confirm that the reported primary and condenser model identifiers are correct.

### 2. Direct protocol checks

Before involving CCR, send one OpenAI Chat Completions request directly to Reasoning Condensation Router. If Claude Code is installed, also send one simple Anthropic Messages request through the direct Reasoning Condensation Router address.

This separates Reasoning Condensation Router and llama.cpp failures from CCR conversion failures.

### 3. Temporary forced-condensation check

Temporarily set:

```dotenv
CONDENSATION_SMOKE_TAG_ENABLED=true
CONDENSE_MIN_REASONING_TOKENS=1
```

Restart Reasoning Condensation Router. Route one selected CCR alias through it and confirm that the delivered reasoning contains a marker resembling:

```text
[RCR condensed original->delivered]
```

The exact marker uses token estimates. CCR may remove the custom `x-rcr-*` response headers, so use Reasoning Condensation Router logs and the visible smoke marker together.

After verification, restore:

```dotenv
CONDENSATION_SMOKE_TAG_ENABLED=false
CONDENSE_MIN_REASONING_TOKENS=512
```

Restart Reasoning Condensation Router again.

### 4. Tool-continuation and hidden-state check

Use a harmless read-only file. Ask the coding agent to:

1. Choose a marker and retain it only in reasoning.
2. Produce a substantial plan before one read tool call.
3. Read the harmless file.
4. Return the marker and a known value from the file after receiving the tool result.

Success requires all of the following:

- The first turn is logged with `condensation_status` equal to `condensed`.
- Delivered reasoning is smaller than original reasoning.
- The agent executes the exact read tool call.
- The follow-up request reaches Reasoning Condensation Router.
- The final answer recalls the hidden marker.
- llama.cpp prompt inspection shows condensed historical reasoning and not the original trace.
- Final text and tool data remain unchanged by condensation.

Perform this through the complete path:

```text
Claude Code, Pi, or OpenCode -> CCR -> Reasoning Condensation Router -> llama.cpp/Qwen
```

## Useful diagnostics

Reasoning Condensation Router logs one structured `turn_completed` event per primary turn. It includes:

- Requested and upstream model.
- Condensation status and policy profile.
- Original and delivered reasoning estimates.
- Upstream input and output usage.
- Visible output estimate.
- Condensation failure reason when applicable.

It also returns these headers when an intermediary preserves them:

```text
x-rcr-condensation-status
x-rcr-reasoning-original-tokens
x-rcr-reasoning-delivered-tokens
x-rcr-upstream-input-tokens
x-rcr-upstream-output-tokens
x-rcr-visible-output-tokens
```

Interpret statuses as follows:

- `condensed`: a smaller replacement was delivered.
- `below_threshold`: the original reasoning was already below the configured minimum.
- `rejected`: the condenser result was not smaller.
- `failed`: the condenser timed out or returned an error; original reasoning was delivered.
- `disabled`: condensation was disabled.

If the client still displays full reasoning, check these causes in order:

1. CCR resolved the alias to the direct llama.cpp provider instead of `rcr_qwen`.
2. The result was `below_threshold`, `rejected`, or `failed`.
3. CCR removed or transformed the reasoning field.
4. The client did not classify the response field as reasoning.

If the model cannot recall condensed hidden state on the next turn, inspect the second llama.cpp prompt. Determine whether the client or CCR omitted historical reasoning, or whether llama.cpp received `reasoning_content` but its chat template ignored it.

## Evidence already obtained on the development machine

The following checks have passed:

- Type checking and nine unit-test files.
- Two HTTP integration tests covering buffered Anthropic and OpenAI responses.
- OpenCode 1.18.21 read-tool loop against Qwen3.8 27B.
- Pi 0.84.3 read-tool loop against Qwen3.8 27B.
- Claude Code 2.1.245 direct Anthropic Messages test through Reasoning Condensation Router using DeepSeek V4 Flash on OpenCode Go.

The strongest Claude Code test condensed a tool-turn trace from approximately 780 to 82 estimated tokens. Claude Code executed `Read`, returned the tool result in a second request, replayed the condensed state, and recovered a marker that had existed only in that state.

These results verify the Reasoning Condensation Router client adapters. They do not verify the deployment site's CCR transformation or its llama.cpp chat template. The complete remote chain must still be tested.

## Packaging status and direction

The recommended packaging design is one compiled JavaScript artifact used by both:

- An OCI container as the primary deployment form.
- A native release archive with a systemd unit.

A later CCR extension can wrap the same core and start a private backend under CCR's lifecycle. The cleaner long-term CCR design is a reasoning-condensation policy attached after model remapping and around the resolved upstream call.

None of those packaging changes has been implemented in this repository yet.

Do not merge this project directly into a private CCR source fork. Begin with the internal-provider arrangement. Consider a CCR extension only after the complete remote path works and the installed CCR version is known.

## Security and operational constraints

- Keep Reasoning Condensation Router private to the host or private container network.
- Keep CCR as the authenticated client entry service.
- Treat the primary and condenser endpoints as trusted with coding-session data.
- Do not log request bodies, response bodies, complete headers, or credentials.
- Leave original-turn archival disabled by default.
- Preserve unrelated CCR providers and routes.
- Change one Qwen mapping first and retain a direct llama.cpp route for rollback.
- Do not expose a private service publicly to solve local networking problems.

## Required report to the operator

Report in this order:

1. What was done.
2. What was found, keeping observations separate from interpretation.
3. What is good and what is concerning.
4. The mechanism causing each concern.
5. The recommendation, including which choice remains with the operator.

Include:

- CCR version and installation form.
- Redacted route topology before and after.
- Exact llama.cpp model identifier and API root without credentials.
- Reasoning Condensation Router health result.
- Direct and complete-path test results.
- Condensation status and before/after estimates.
- Evidence that hidden state survived the next turn.
- Any rollback performed or still available.

## References

- Project overview and configuration: [`../README.md`](../README.md)
- Internal design: [`design.md`](design.md)
- Current CCR extension mechanism: <https://github.com/musistudio/claude-code-router/blob/main/docs/src/content/docs/en/configuration/extensions.md>
- Current CCR provider configuration: <https://github.com/musistudio/claude-code-router/blob/main/docs/src/content/docs/en/configuration/providers.md>
