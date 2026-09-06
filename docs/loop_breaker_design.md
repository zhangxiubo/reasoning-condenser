# Loop Breaker Design

Revision of the doom-loop breaker introduced in `f2d882b`, following a review that found fifteen defects and one pre-existing converter defect.

## Objective

Detect a primary model repeating tool calls without progress, and end the loop by asking it to stop and report. Escalate across requests when it does not comply, ending in a request the model cannot answer with a tool call.

The breaker inspects tool-call history only. It contains no model or endpoint identifiers and is safe to enable for any routed model.

Client protocol details, including where a conversation identifier comes from, live in the request-side boundary described below. Detection, escalation and intervention see only `NormalizedHistory` and stay protocol-neutral.

## Why the current implementation does not run

The breaker reads the converted OpenAI message list and injects only when the last message has role `tool`. Claude Code places `role: "system"` messages inside `messages`, including a `<total_tokens>` notice appended once a session has usage. `messageConversion` routes every non-assistant role through `userMessage`, so those become `user` messages and the converted history never ends on `tool`.

Measured against Claude Code 2.1.263 through a capture server, with the observed trailing shape spliced onto a stalled history:

| Trailing shape | Converted last role | Stall count | Injected |
|---|---|---|---|
| Absent | `tool` | 4 | yes |
| Claude Code's trailing `system` message | `user` | 4 | no |

The detector is not at fault, and neither is the conversion. The fault is that the detector reads the conversion's output, which has already discarded the role the detector depends on.

The fix is therefore not a change to what the converter produces. The converter keeps mapping these messages to `user` for reasons given under converter policy below. The breaker instead reads the client request, where the `system` role is still present.

## Request-side protocol boundary

`NormalizedTurn` is the boundary between client protocol details and condensation policy for responses. Requests have no equivalent, so the breaker reads raw converted messages and inherits whatever the conversion lost.

`NormalizedHistory` is the matching boundary for requests. It is derived from the **client** request, before conversion, where protocol structure is still intact.

```text
NormalizedHistory
  conversation_id         stable identity for escalation state
  turns                   bounded, oldest first
  awaiting_tool_decision  history ends on tool results
```

Each turn reduces to three signatures:

```text
HistoryTurn
  tool_sig    tool names only
  call_sig    tool names with arguments
  result_sig  tool result contents
```

`normalized_history` exports one builder per client protocol. Neither request adapter changes signature.

| Builder | Source | Human turn | Tool result turn |
|---|---|---|---|
| `fromAnthropicRequest` | `AnthropicMessagesRequest` | `user` message with no `tool_result` block | `user` message containing `tool_result` blocks |
| `fromOpenAiRequest` | `OpenAiClientChatRequest` | `user` message | `tool` message |

`system` messages are neither. They carry client and session metadata, not conversation, so they are skipped when locating the trailing run and do not end it. Reading the client request rather than the converted output is what makes this classification possible: after conversion the role is gone.

A human turn ends the trailing run. Turns are collected backwards from the end, stopping after `max(threshold + 2, 4) + 1` turns — the longest run any signal can consult, plus one turn to prove the run ended. History size therefore does not affect per-request cost.

The previous implementation walked the whole message list and serialized every tool result on every request, though only the trailing turns can change the outcome. It also skipped intervening human turns rather than stopping at them, so repeats a person explicitly asked for counted as the model stalling.

## Converter policy for system messages

`AnthropicMessage.role` is declared `"user" | "assistant"`. Real traffic contains `"system"`. The type widens to include it, and the conversion to a `user` message becomes explicit and documented rather than an accident of every non-assistant role falling through to `userMessage`.

Placement is constrained by the chat template the serving runtime applies. Measured by rendering each backend model's own template against a tool-using conversation:

| Placement | Qwen3.8 27B | Gemma4 26B A4B | Nemotron 3 Super 120B | GPT-OSS 120B |
|---|---|---|---|---|
| Retained as a `system` message in place | **raises** | renders | renders | **content silently lost** |
| Merged into the leading system prompt | renders | renders | renders | renders |
| Converted to a `user` message | renders | renders | renders | renders |

Qwen3.8 raises `System message must be at the beginning.` GPT-OSS renders without error and drops the content, which is the more dangerous failure because nothing reports it. Retaining a system message in place is therefore not available.

Of the two remaining placements, conversion to a `user` message is chosen. Merging into the leading prompt is more faithful about who spoke, but the leading prompt is the cacheable prefix, and Claude Code appends a `<total_tokens>` notice whose value changes on every request. Merging would rewrite that prefix each turn and defeat prefix reuse on vLLM and llama.cpp for the whole session.

Selective merging — stable system content to the prompt, volatile notices left in place — is not implementable. The converter cannot tell the two apart without matching on client-specific content such as `<total_tokens>`, which would put a client marker inside a component that must stay protocol-neutral.

The chosen placement is therefore a deliberate trade: the message is labelled as a user turn, which is not literally who produced it, in exchange for a stable cacheable prefix and uniform handling with no content matching.

This placement does not affect the breaker. `NormalizedHistory` is derived from the client request, where the role is still `system`, so detection classifies these messages correctly regardless of what the converter does with them.

## Stall signals

Detection is a table evaluated most-specific first. Each signal names the equality it requires across a trailing run of turns.

| Signal | Requires | Minimum run |
|---|---|---|
| `unchanged_result` | `call_sig` and `result_sig` equal | max(threshold, 2) |
| `repeated_call` | `call_sig` equal | max(threshold, 2) |
| `variant_thrash` | `tool_sig` and `result_sig` equal, `call_sig` differing | max(threshold + 2, 2) |
| `alternating_calls` | period-2 repetition of `call_sig` with `result_sig` | max(threshold, 4) |

A run must be at least twice the signal's period, because a repeat cannot be shown in fewer turns than that: the first three signals compare adjacent turns (period 1), `alternating_calls` compares turns two apart (period 2).

`unchanged_result` is a strict subset of `repeated_call`; it is listed first so the more informative reason is reported.

Two consequences are deliberate:

- Identical results with differing calls no longer count on their own. A search sweep where every probe returns nothing is progress, not a stall. `variant_thrash` recovers the genuine case — the same tool hitting the same wall with differing arguments — at a higher run length.
- `repeated_call` with differing results covers legitimate polling of a changing resource. It is the signal most likely to need tuning against real traffic, and is the first place to look if false positives appear.

Run lengths count the turns actually present. The previous alternation count stopped one step early and understated odd-length runs.

## Escalation policy

State is per conversation, keyed by `conversation_id`.

```text
stall observed          injections + 1, clean run reset to 0
clean request observed  clean run + 1
                        when clean run reaches LOOP_BREAKER_DECAY_AFTER_CLEAN,
                        injections - 1 and clean run reset to 0
```

Injections never fall below zero. Resetting the clean run after each decay step is what makes decay cost a fresh run of clean requests every time, rather than one run followed by a decay on every subsequent request.

Escalation is faster than decay by design, for `decay_after_clean` of `2` or more: a single clean request never cancels a stall, so a model that emits one unrelated call between stalls still climbs. A model that recovers walks its level back to zero. At `decay_after_clean = 1`, escalation and decay run at the same rate: each clean request cancels exactly the increment from the stall before it, so a model alternating one stall with one clean request makes no net progress toward the hard stop, wherever the level already stands.

Entries carry a last-seen time. Expiry is checked on access, not only when the map overflows, so a quiet conversation's entry does not survive indefinitely. The size cap remains as a second limit.

## Intervention policy

Level selects a request transform. The notice text is generated from the transform that is applied, so a message cannot describe a restriction that was not imposed.

| Level | Transform | Message states |
|---|---|---|
| below `max_injections`, first | append notice | tools remain available; stop and report |
| below `max_injections`, later | append notice | tools remain available; stronger wording |
| at `max_injections` | append notice, remove tool affordances | tools are unavailable |

The last row is selected by reaching `max_injections`, not by a fixed level number. A `max_injections` of `1` therefore removes tool affordances on the first intervention, and no level below the maximum ever claims tools were removed.

`remove_tool_affordances` removes `tools`, `tool_choice` and `parallel_tool_calls` together. They describe one capability, and removing `tools` alone leaves `tool_choice` referring to a capability that no longer exists.

Endpoint tolerance for that incoherent request varies and was measured as permissive, not fatal:

| Request | Qwen3.8 27B | DeepSeek V4 Flash |
|---|---|---|
| `tools` removed, `tool_choice: "auto"` left | accepted, no tool call | accepted, no tool call |
| `tools` removed, `tool_choice: "required"` left | accepted, no tool call | accepted, no tool call |
| all three removed | accepted, no tool call | accepted, no tool call |

Through OpenRouter neither model rejected the incoherent form. Removing all three is still correct: it is the only form that states one thing, it is never worse than the alternative, and stricter OpenAI-compatible servers are free to reject a `tool_choice` that names no tools. This defect is a correctness and clarity fix, not a repair for an observed request failure.

The delivery shape — a `user` message appended after tool results — renders on every backend model's template, with and without tools present:

| Shape | Qwen3.8 27B | Gemma4 26B A4B | Nemotron 3 Super 120B | GPT-OSS 120B |
|---|---|---|---|---|
| Notice appended as a `user` message | renders | renders | renders | renders |
| Same, with tool affordances removed | renders | renders | renders | renders |

Templates that require strict user/assistant alternation reject this shape, because the notice follows tool results with no intervening assistant turn. None of the backend models impose that rule, so appending remains the delivery mechanism.

The input request is never mutated.

## Conversation identity

| Client | Source | Handling |
|---|---|---|
| Anthropic | `metadata.user_id`, a JSON string containing `session_id` | parse, take `session_id`, hash it |
| Any other | leading system prompt and first human turn | canonical JSON serialization, hashed |

The previous key called `.toString()` on message content typed `string | JsonValue[] | null`. Array content parts stringify to `[object Object]`, so every conversation using content parts collapsed to one key and shared one escalation budget.

The fallback uses canonical serialization rather than string coercion. The Anthropic path prefers `session_id` because it is what the client already means by "this conversation": it is stable across compaction and across edits to the system prompt, and it avoids hashing a system prompt that runs to tens of kilobytes on every request. The captured Claude Code session prompt was 15,612 characters.

`metadata.user_id` carries more than the session id, and what else it carries is not fixed. Claude Code 2.1.263 was observed sending `device_id`, `account_uuid`, `parent_session_id`, `ti` and `tk`, and `CLAUDE_CODE_EXTRA_METADATA` lets a user put arbitrary further keys of their own into the same field. The field's contents are therefore unknown in advance and must be treated as sensitive as a whole, not as a known short list of harmless identifiers. Only `session_id` is read, it is hashed before storage, and no part of the field is logged. Anything that later wants to read, store or log another key from this field needs its own justification; the current posture is deliberate.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `LOOP_BREAKER_ENABLED` | `false` | Enables the breaker |
| `LOOP_BREAKER_THRESHOLD` | `3` | Trailing no-progress turns before the first notice |
| `LOOP_BREAKER_MAX_INJECTIONS` | `3` | Notices per conversation before tool affordances are removed |
| `LOOP_BREAKER_DECAY_AFTER_CLEAN` | `2` | Consecutive clean requests that reduce the level by one |

These are validated like every other setting: an unparseable value fails startup. The previous parsers accepted anything and fell back silently, so `LOOP_BREAKER_ENABLED=ture` disabled the feature with no signal, and a threshold of `0` or `-1` silently became `3`. A single parser serves both strict and defaulted settings.

## Module layout

```text
reasoning_router
  ├── normalized_history      client request -> NormalizedHistory
  └── loop_breaker            composition
        ├── stall_detector    signal table over turns
        └── loop_escalation   per-conversation ledger
```

`LoopBreakerState` becomes a constructor parameter of `ReasoningRouter`, matching every other collaborator. It is currently constructed inside the constructor, which is why the router seam cannot be tested.

Data fields use snake case, matching the rest of `src`. The current mixture required the router to translate field names by hand when logging.

## Findings covered

| Area | Findings |
|---|---|
| Request-side boundary and converter | #1, #6, #9, plus the `role: "system"` conversion defect |
| Stall signals | #5, #11 |
| Escalation state | #3, #4, #10 |
| Request transform | #2, #7, #14 |
| Configuration | #12, #13 |
| Wiring and tests | #8 |
| Naming and dispatch | #15 |

## Verification method

Detection, escalation and intervention are pure over their inputs and are covered by unit tests. The router seam gets its own tests: that the breaker is invoked, that configuration reaches it, and that a hard-stopped request carries no remaining tool affordance. That last test is what catches the `tool_choice` defect — by asserting the request describes one thing, rather than by waiting for an endpoint to object to it.

History builders are tested per protocol against captured request shapes, including Claude Code's trailing `system` message and OpenAI array content parts.

## Open questions

Template behavior was measured by rendering each template with Jinja2 directly. vLLM renders templates this way; llama.cpp uses its own implementation, which may differ in edge cases. The results here are strong evidence, not a guarantee about either server.

The `user` label applied to converted `system` messages is knowingly inaccurate about who produced the content. It was chosen over the faithful alternative to keep the cacheable prefix stable. If prefix reuse turns out not to matter at this deployment, merging into the leading system prompt is the better representation and the decision should be revisited.

`variant_thrash` uses threshold plus two. That margin is a starting value with no measurement behind it.

No endpoint was found that rejects a `tool_choice` naming no tools. The review originally predicted such a rejection and it did not occur on either model tested through OpenRouter. Whether vLLM's or llama.cpp's own request validation rejects that form is untested.

Prefix reuse itself has not been measured at this deployment. The argument for the chosen placement assumes it is worth preserving; that assumption is untested.
