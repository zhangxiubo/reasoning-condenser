# Pre-final condensation handover

## Purpose

This note records a clarified product direction for the next development session.

The requested behavior is not merely to rewrite reasoning before a coding agent stores it. The requested behavior is:

```text
primary model generates reasoning
    -> router withholds all primary output
    -> condenser replaces the reasoning with a smaller representation
    -> primary model generates final text or tool calls from that replacement
    -> router delivers replacement reasoning and the newly generated final output
```

The original reasoning must not be present in the final-generation prompt. The delivered final output must therefore be causally downstream of the replacement reasoning.

The user accepts delayed delivery. No reasoning, final text, or tool-call fragment needs to reach the client before condensation and finalization complete.

## Project and deployment context

- Repository: `https://github.com/zhangxiubo/reasoning-condenser`
- Local checkout: `/home/xiubo/projects/reasoning-condenser`
- Baseline before this note: commit `5ae70bf`
- License: MIT
- Primary deployment profile: Qwen3.8 27B served by llama.cpp
- The project remains model-neutral. Qwen and llama.cpp require a compatibility strategy rather than model-specific logic distributed through the router.
- Supported client interfaces currently include Anthropic Messages and OpenAI Chat Completions.
- Tested coding agents include Claude Code, OpenCode, and Pi.
- The project is not intended to proxy real Anthropic model endpoints.
- A remote deployment may place the service after CCR model remapping and before the actual llama.cpp endpoint.

## Current behavior

The current router implements post-response condensation:

```text
client request
    -> complete non-streaming primary response
    -> normalize reasoning, final text, and tool calls
    -> condense reasoning
    -> replace reasoning only
    -> serialize and deliver
```

The current final text and tool calls were generated from the original reasoning. Condensation affects only what the client stores and replays later.

Relevant code:

- `src/reasoning_router.ts`: `processTurn` performs one complete primary call and then invokes the condenser.
- `src/openai_client.ts`: `OpenAiClient.complete` supports JSON completion responses only.
- `src/condensation.ts`: selects a post-response policy and constructs the condenser request.
- `src/normalized_turn.ts`: normalizes a completed response containing reasoning, text, tool calls, stop reason, and usage.
- `src/anthropic_response.ts` and `src/openai_response.ts`: serialize a completed normalized turn.

The condenser currently receives:

- Original reasoning.
- Final response text.
- Exact normalized tool calls.
- A completed-response or tool-continuation policy.
- A requested replacement size.

That request shape is appropriate for post-response condensation. It is not the right abstraction for pre-final condensation.

## Required architecture

Add pre-final condensation as a separate pipeline selected by configuration. Preserve the current pipeline as the stable mode.

Suggested configuration:

```dotenv
CONDENSATION_STAGE=post_response
```

Experimental selection:

```dotenv
CONDENSATION_STAGE=pre_final
```

Use data-driven stage selection rather than scattering stage checks through protocol adapters.

### Proposed state sequence

```text
received
    -> reasoning_generation_started
    -> reasoning_captured
    -> reasoning_condensed | original_reasoning_retained
    -> finalization_started
    -> finalization_completed
    -> assembled
    -> serialized
    -> delivered
```

No stage-one output should be emitted downstream.

### Proposed module responsibilities

Keep protocol conversion separate from generation strategy.

- `reasoning_generation`: starts the first primary stream, collects reasoning, detects the transition to final output, and cancels the stream.
- `pre_final_condensation`: applies a dedicated policy to a reasoning draft.
- `finalization`: constructs and executes a second primary request from the original request and replacement reasoning.
- `finalization_strategy`: provider capability interface for assistant prefill, native completion, or a future continuation mechanism.
- `post_response_pipeline`: retains current behavior without semantic changes.
- `pre_final_pipeline`: composes reasoning generation, condensation, finalization, and assembly.
- Existing Anthropic and OpenAI response serializers should consume one common assembled result.

Prefer immutable stage values. A useful boundary type would represent captured reasoning separately from a completed turn. Do not force an incomplete generation into `NormalizedTurn`, because that type promises final text, tool calls, and a final stop reason.

Illustrative shapes:

```ts
interface ReasoningDraft {
  model: string;
  reasoning: string;
  usage: TokenUsage;
  transition: "content" | "tool_call" | "end";
}

interface FinalizedTurn {
  reasoning: string;
  text: string;
  tool_calls: ToolCall[];
  stop_reason: StopReason;
  usage: MultiStageUsage;
}
```

Names and exact fields should follow the surrounding TypeScript structures when implemented.

## First-generation strategy

The optimized implementation should request a streaming primary completion even when the downstream client requested JSON.

Collect separated reasoning chunks. When the first final-content or tool-call delta arrives:

1. Record which transition occurred.
2. Discard the final fragment.
3. cancel the upstream stream.
4. Condense the collected reasoning.
5. Start finalization.

This avoids generating an entire final answer that will be discarded. The endpoint may still generate a small amount of final output before cancellation reaches it.

The first implementation should support endpoints that emit reasoning separately from content. Inline `<think>` parsing can be added as an explicit compatibility strategy, but it should not be mixed into the generic streaming parser.

A simpler proof of concept may allow the first primary call to finish, discard its final response, condense the reasoning, and generate a second final response. This proves assistant continuation semantics but wastes the entire first final generation. Do not mistake proof-of-concept performance for the intended steady-state design.

## Pre-final condensation policy

Before finalization, the router does not know whether the model will produce final text or a tool call. The existing policy choice based on `turn.tool_calls.length` is unavailable.

Create a dedicated pre-final policy. It should preserve:

- The intended answer or next action.
- Established facts and observations needed to produce it.
- Exact paths, identifiers, commands, constraints, errors, and unresolved questions.
- Any tool name or arguments already selected in reasoning.
- Qualifications that affect correctness.

It should remove exploration, repetition, self-talk, and rejected approaches.

The condenser request should contain the captured reasoning, instructions, and replacement size. There is no completed final response to send. Tool definitions from the client request should not be sent unless evaluation shows that they materially improve preservation; the primary finalization request will receive the original tool definitions.

Condenser failure should retain the captured original reasoning and proceed to finalization with it. A condensation failure must not prevent the primary model from answering.

## Finalization strategy

The intended second primary request contains:

- The original conversation and tools.
- No original reasoning from the interrupted generation.
- A trailing assistant prefill containing the replacement reasoning.
- Thinking disabled for the continuation, so generation proceeds into final text or tool syntax.

The preferred Chat Completions representation to probe is:

```json
{
  "role": "assistant",
  "reasoning_content": "replacement reasoning",
  "content": ""
}
```

The finalization strategy must decide how that value is rendered and which thinking controls are sent. Do not assume that `preserve_thinking` performs same-turn continuation. It controls reasoning serialization in chat history. Assistant prefill or a native continuation endpoint is the relevant mechanism here.

### Current llama.cpp evidence

Current llama.cpp documentation says trailing assistant messages are treated as response prefills by default:

- <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md?plain=1>

Its automatic parser documentation describes reasoning-prefill handling. A generation prompt containing both reasoning start and end markers leaves the reasoning sampler idle, which is the state needed before final output:

- <https://github.com/ggml-org/llama.cpp/blob/master/docs/autoparser.md>

A llama.cpp issue reports that `/v1/chat/completions` rejects an assistant prefill while thinking is enabled. The same report demonstrates a closed `<think>...</think>` prefill through the native `/completion` endpoint. Treat this as experimental evidence, not a compatibility promise:

- <https://github.com/ggml-org/llama.cpp/issues/21889>

Another llama.cpp issue reproduces trailing-assistant continuation behavior with Qwen3.8 27B and reports tool calls disappearing when the trailing prefill itself contains tool calls. The proposed design prefills reasoning only, but this result confirms that the exact continuation path must be tested against the deployed build:

- <https://github.com/ggml-org/llama.cpp/issues/27588>

### Strategy order

Probe strategies in this order:

1. OpenAI Chat Completions assistant prefill with `reasoning_content` and thinking disabled.
2. OpenAI Chat Completions assistant prefill containing a template-appropriate closed thinking block.
3. llama.cpp native `/completion` with a correctly rendered prompt and a compatibility response parser.
4. A narrow llama.cpp change that permits a closed-thinking assistant prefill through Chat Completions.

The generic pipeline should depend on a finalization capability interface. llama.cpp-specific prompt serialization belongs in a llama.cpp strategy module.

## Failure behavior

Use a layered recovery policy:

1. If reasoning streaming is unsupported, restart using the existing post-response pipeline.
2. If condensation fails, finalize from the captured original reasoning.
3. If replacement-reasoning finalization fails, retry only when the error is transient.
4. If the continuation representation is unsupported, restart using the existing post-response pipeline.
5. Never return the partial final fragment from the interrupted first stream.

Record the selected recovery path in structured logs and diagnostics.

## Usage accounting

Pre-final mode has three model operations:

1. Primary reasoning generation.
2. Condensation.
3. Primary finalization.

Track each operation separately. Also report aggregate primary input and output usage where downstream protocols require one value.

Do not claim that this mode reduces the cost of generating the original reasoning. It can reduce:

- Context used while the primary model generates final output.
- Reasoning retained in later coding-agent turns.
- KV-cache and attention work attributable to the original reasoning during final decoding.

It adds condenser work and a second evaluation of the original prompt. llama.cpp prompt caching may reuse the shared prefix, but measure rather than assume reuse.

## Quality risk

Post-response condensation cannot change the current final answer. Pre-final condensation can.

If the condenser omits a necessary fact, qualification, identifier, or planned tool argument, the final answer can become incorrect. This is the main product risk and requires evaluation before pre-final mode becomes a default.

The safe product posture is:

- Keep `post_response` as the default.
- Mark `pre_final` experimental.
- Preserve the original reasoning as the fallback input for finalization.
- Compare correctness, tool-call fidelity, latency, and total tokens against an unmodified primary completion.

## Test plan

### Protocol probes

Run these directly against the deployed llama.cpp build before changing the router:

1. Record `llama-server --version` and the exact model identifier.
2. Confirm a streaming response exposes reasoning separately from content and tool-call deltas.
3. Use `/apply-template`, if enabled, to inspect a trailing assistant message containing `reasoning_content` and empty content.
4. Confirm the rendered prompt contains replacement reasoning exactly once and closes the reasoning region before generation.
5. Send the same shape to `/v1/chat/completions` with thinking disabled.
6. Confirm the response contains only newly generated final text or tool calls rather than echoed prefill or injected markers.
7. Repeat with tools supplied and require the finalization call to generate a tool call.

### Router tests

Add deterministic integration fixtures for:

- Reasoning chunks followed by content chunks.
- Reasoning chunks followed by tool-call chunks.
- Cancellation after the first final-output transition.
- No downstream bytes before finalization completes.
- Condenser success and failure.
- Assistant-prefill success and unsupported-response fallback.
- Final text and tool calls originating only from the second primary call.
- Original reasoning absent from the second primary request.
- Replacement reasoning present exactly once in the second primary request.
- OpenAI JSON, OpenAI synthesized streaming, Anthropic JSON, and Anthropic synthesized streaming.
- Separate usage accounting for all model operations.

### Behavioral checks

Use tasks whose final answer depends on a marker present only in reasoning. The condenser must retain the marker, and the finalization call must reproduce it. Inspect the second primary prompt to prove that it contains the replacement reasoning and not the original trace.

Also include negative cases where the original reasoning contains a rejected answer followed by a corrected plan. The replacement must retain only the corrected plan, and the final output must follow it.

For tools, require exact preservation of file paths, tool names, and argument values. Compare generated calls structurally, not only as rendered text.

## Acceptance criteria

Do not describe pre-final mode as working until all of the following are demonstrated:

- The client receives no stage-one output.
- The second primary request excludes the original reasoning.
- The second primary request includes replacement reasoning exactly once.
- Final text and tool calls come from the second primary response.
- Condenser failure still produces a primary answer.
- Unsupported assistant prefill returns to post-response behavior without corrupting the conversation.
- Tool loops complete through Claude Code, OpenCode, and Pi for the selected provider profiles.
- Quality evaluation shows an explicitly accepted tradeoff relative to the primary model without condensation.
- Logs distinguish reasoning-generation, condensation, and finalization usage and latency.

## Decisions still owned by the user

- Whether the proof of concept may generate and discard a complete draft final response.
- Whether a llama.cpp-specific native `/completion` adapter is acceptable.
- Whether modifying the deployed llama.cpp build is acceptable if Chat Completions assistant prefill remains restricted.
- What quality regression, if any, is acceptable in exchange for smaller active context.
- Whether replacement reasoning should have one generic budget or separate budgets based on request characteristics available before finalization.

## Recommended next action

Do not begin with broad router changes. Start with a small executable protocol probe against the actual Qwen3.8 and llama.cpp deployment:

1. Capture separated streaming reasoning.
2. Construct a trailing assistant prefill from a short replacement.
3. Disable thinking for the continuation.
4. Verify final text and tool-call generation.
5. Inspect the rendered prompt or prompt log.

The result determines which finalization strategy the router should implement and prevents the generic architecture from being built around an unsupported request shape.
