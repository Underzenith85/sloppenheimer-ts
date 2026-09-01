# Design: Claude Code as a second agent runner

Status: proposed. Supersedes nothing. This document is the architecture record for adding a second
agent-runner backend; do not open a separate ADR for it.

## What this adds

Sloppenheimer dispatches work to exactly one coding agent today: Codex, over the App Server JSONL
protocol. This design makes the backend a _selection_ rather than a compile-time fact, and adds
Claude Code as the second registered kind, so a workflow chooses its runner the same way it already
chooses its tracker.

The end state a workflow author sees:

```yaml
runner:
  kind: claude-code
  settings:
    command: claude
    model: claude-opus-5
    permission_mode: acceptEdits
    turn_timeout_ms: 3600000
    read_timeout_ms: 10000
    stall_timeout_ms: 600000
```

Everything else — polling, workspaces, containment, hooks, retries, handoff, the operator console —
is unchanged and shared. One runner is selected per workflow; running two backends against one
tracker concurrently is explicitly out of scope (see [Non-goals](#non-goals)).

## The port is right; its surroundings are not

`AgentRunnerPort` (`packages/core/src/ports/agent-runner.ts`) was introduced by
[#89](https://github.com/Underzenith85/sloppenheimer-ts/issues/89) and
[#140](https://github.com/Underzenith85/sloppenheimer-ts/issues/140) precisely so that a second
backend would be an adapter rather than a rewrite. That worked: `run` and `AgentLaunch` need no
change, and `AgentEvent` is already a normalized, bounded, pre-redacted vocabulary rather than a
Codex wire shape.

What did not get finished is everything _around_ the port. Codex is still named in six places above
the adapter, and each one is a place a second runner would be misread rather than merely unsupported.

| #   | Leak                                                                                                          | Where                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| L1  | The only agent config block is `codex:`, typed as `CodexConfig`                                               | `packages/core/src/config/workflow.ts:34,51`; `src/config/workflow.ts:173-181,338-346`                                                     |
| L2  | `AgentRunnerConfig` is structurally Codex's settings (`approvalPolicy`, `threadSandbox`, `turnSandboxPolicy`) | `packages/core/src/ports/agent-runner.ts:14-23`                                                                                            |
| L3  | Codex's policy enums are validated **in core**                                                                | `packages/core/src/config/workflow.ts:87-88`                                                                                               |
| L4  | The orchestrator matches Codex's literal event names                                                          | `packages/core/src/core/dispatch.ts:63-68`; `packages/core/src/core/runtime.ts:809,817,828`; `packages/core/src/telemetry.ts:424,427,1007` |
| L5  | Codex's authentication env names are a core constant                                                          | `packages/core/src/config/env-reference.ts:12-15,84`                                                                                       |
| L6  | Preflight and the composition root name Codex directly                                                        | `src/config/workflow.ts:413`; `src/cli.ts:7,73`                                                                                            |

L4 is the dangerous one. `AgentEventSemantics` was added so a runner's _turn statuses_ are read by
that runner, but the _event names_ that carry those statuses are still matched as string literals in
the scheduler's hottest path. A Claude runner that emits its own vocabulary would produce a session
that starts, runs, and completes while the orchestrator observes no lifecycle at all: no
`session_started` log, `turnActive` never set, and lifecycle queueing (`queuePendingLifecycle`)
silently skipped. That failure is quiet, which is why it is worth fixing before any Claude code
exists.

## Decisions

### D1 — Runner selection is `runner: {kind, settings}`

Mirror the accepted tracker shape (`tracker: {kind, provider}`, `AGENTS.md`). The kind selects an
adapter from a composition-root registry; `settings` is preserved verbatim as exact JSON and
validated only by the adapter that owns the kind — the same contract `tracker.provider` already has,
including `$VAR` indirection for anything an adapter declares as a secret or a path.

Rejected: putting `kind` under the existing `agent:` block. `agent:` holds scheduling policy
(`max_concurrent_agents`, `max_turns`, `max_retry_backoff_ms`) that is runner-independent, and
splitting adapter configuration across two sections buys nothing.

**Compatibility.** A document with a `codex:` block and no `runner:` block is read as
`runner: {kind: codex, settings: <that block>}`. `WORKFLOW.md`, every fixture, and every existing
front-matter test keep passing unchanged. Declaring both is a configuration error rather than a
merge. The alias is deprecated on arrival and removed in a later change, not this one.

### D2 — `AgentRunnerConfig` is neutral fields plus opaque settings

```ts
export type AgentRunnerConfig = Readonly<{
  command: string
  turnTimeoutMs: number
  readTimeoutMs: number
  stallTimeoutMs: number
  /** Adapter-owned, preserved exactly as authored until the owning adapter validates it. */
  settings: JsonObject
}>
```

The four neutral fields are the ones core genuinely consumes: `command` for preflight,
`stallTimeoutMs` for stall detection in `captureExecutionSnapshot`
(`packages/core/src/core/policy.ts:140`), and the two read/turn bounds that every subprocess
transport needs. `approvalPolicy`, `threadSandbox`, and `turnSandboxPolicy` move into Codex's
`settings`; `model`, `permission_mode`, `allowed_tools`, and the rest move into Claude's.

This resolves L2 and L3 together. The port comment currently says "a second runner widens the shape
here rather than at every launch site" — widening into a union was the other option, but it grows
core by a field per backend and keeps backend policy enums (L3) inside core forever. The opaque-
settings form is the pattern this repository already accepted for trackers, and it lets
`codexApprovalPolicies` / `codexSandboxModes` move to `packages/adapter-codex` where they belong.

### D3 — Events carry their own lifecycle meaning; `AgentEventSemantics` retires

Add a discriminant the adapter sets at normalization time:

```ts
export type AgentLifecycle =
  | Readonly<{ phase: 'session_started' }>
  | Readonly<{ phase: 'turn_started' }>
  | Readonly<{ phase: 'turn_settled'; outcome: AgentTurnOutcome }>

export type AgentEvent = Readonly<{
  /* ...unchanged... */
  lifecycle: AgentLifecycle | null
}>
```

Every literal-name match in L4 becomes a read of `update.lifecycle`. `event` stays as the runner's
own name for the message, for logs and the operator timeline; it stops being load-bearing.

This subsumes `AgentEventSemantics.turnOutcome` entirely: the outcome travels on the settling event
instead of being recovered later by asking the runner to interpret a status string it already
interpreted. `AgentRunnerPort` therefore loses its `semantics` member and becomes a single
operation, and `runtime.ts:833`'s lookup goes away. This is a deliberate port change, not an
oversight.

### D4 — Authentication environment names are per-runner

`codexAuthenticationEnvironmentNames` (L5) enforces two rules: tracker configuration may not reuse
those names, and the host never strips them from the agent subprocess environment. Both are facts
about the _selected_ runner, so both move onto the registered runner entry.

- Codex: `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN` (unchanged).
- Claude Code: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, plus the
  third-party backend selectors (`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` and the cloud
  credentials they imply) when a deployment uses one.

**A real difference, worth stating.** Codex authenticates from the environment. Claude Code does not
have to: a probe run in this container reported `apiKeySource: "none"` and authenticated from an
on-disk profile under `$HOME`. Environment stripping therefore does not bound what the child can
reach, and never did — it bounds only what Sloppenheimer hands it. That is fine for the invariant
Sloppenheimer actually promises (tracker credentials never reach the agent), but it means the Claude
adapter must be explicit about what else the child inherits. See D12.

### D5 — Transport: `claude -p` in bidirectional stream-json

Run one long-lived child per session:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --permission-mode <mode> --model <model> \
       --mcp-config <host-tools> --strict-mcp-config \
       --setting-sources project --replay-user-messages
```

The host writes one NDJSON user message per turn to stdin and reads NDJSON messages from stdout;
each turn ends with a `result` message.

This was verified against Claude Code 2.1.251, not assumed: a single child process took two
host-driven turns written to its stdin, returned a `result` for each, and reported the same
`session_id` throughout. That is structurally the same shape as the Codex App Server —
long-lived child, newline-framed JSON both ways, host-driven turn loop — which means the session
lifecycle, workspace-identity rebinding, `SIGTERM` grace, post-`SIGKILL` group reap, stall detection,
and redaction-at-ingest all carry over rather than being re-invented.

Rejected — **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): it inverts control into an async
iterator, and it owns the subprocess. The invariants this repository has paid for — re-confirming the
workspace's device and inode after process creation and before every turn, bounded shutdown with a
group reap, a framing byte limit — all live at the process boundary the SDK hides. Re-establishing
them through SDK options would be more work than framing NDJSON, and less verifiable.

Rejected — **the Messages API directly**: that builds a coding agent rather than embedding one. The
file editing, tool execution, permission model, and context management are the product being
integrated.

### D6 — Promote the process and framing scaffolding out of `adapter-codex`

`packages/adapter-codex/src/framing.ts` is already generic: `protocolLines` frames newline-delimited
JSON under a byte limit, `diagnosticLines` / `diagnosticRecords` frame stderr. Nothing in it is
Codex-specific. Move it, together with the spawn/shutdown/reap supervision and the
redact-and-bound-at-ingest helpers (`boundedMessage`, `sessionSecretValues`, `makeCodexEnvironment`
generalized to take the runner's auth names), into `@sloppenheimer/adapter-node`.

Both adapters then depend on it, and the accepted dependency direction is unchanged:

```
core  <-  adapter-node  <-  adapter-github, adapter-codex, adapter-claude  <-  root application
```

`test/package-boundaries.test.ts` gains one manifest to assert.

### D7 — Session identity

Codex issues `thread_id` and `turn_id`; `composeSessionId` builds `<thread>-<turn>` for SPEC 4.1.6.
Claude Code reports a `session_id` (a UUID, stable for the life of the process and across
`--resume`) and no turn id.

Map it as: **thread = `session_id`, turn = the `result` message's `uuid`.** Both halves are then
server-supplied identifiers rather than host counters, `composeSessionId` is untouched, and each
host turn produces a distinct `session_id` exactly as SPEC 10.2 asks.

The probe confirms both halves behave as required: `session_id` was stable across two host turns on
one process, and each turn produced its own `result` with a distinct `uuid`. (`result.num_turns`
counts the agent's _inner_ turns within one host turn and is not cumulative, so it is telemetry
rather than a budget — see D11.)

One improvement over Codex worth taking: `--session-id <uuid>` lets the _host_ choose the thread id
before the child starts, so it is known at launch rather than after `thread/start` returns, and a
crashed session is addressable for `--resume` without having captured anything from the stream.

### D8 — Widen `TokenCounts` for cache tokens

`TokenCounts` is `{inputTokens, outputTokens, totalTokens}`. Claude Code reports
`cache_creation_input_tokens` and `cache_read_input_tokens` separately, and they dominate: in the
probe run, the first assistant message billed **10** uncached input tokens against **27,781**
cache-creation tokens. Folding them into `inputTokens` misprices the run; dropping them understates
it by three orders of magnitude.

Add two nullable fields (`cacheCreationInputTokens`, `cacheReadInputTokens`), null for Codex, and
render them in the console beside the existing totals. The rule that a partial reading reports no
usage at all (`packages/adapter-codex/src/protocol.ts:34-38`) still applies to the required three.

### D9 — Rate limits are decoded by the adapter, not by core

`AgentEvent.rateLimits` is a raw `JsonObject` that `decodeRateLimits`
(`packages/core/src/telemetry.ts:252`) reads against Codex's window shape. Claude Code emits a
`rate_limit_event` with a different but equivalent shape:

```json
{
  "rate_limit_info": {
    "status": "allowed",
    "rateLimitType": "five_hour",
    "unifiedWindows": {
      "five_hour": { "utilization": 0.39, "resetsAt": 1788205800 },
      "seven_day": { "utilization": 0.43, "resetsAt": 1788566400 }
    }
  }
}
```

Change `AgentEvent.rateLimits` from `JsonObject | null` to `readonly RateLimitWindow[] | null` and
move decoding into each adapter, next to the normalization each already performs. The mapping is
direct: window key to `name`, `utilization × 100` to `usedPercent`, `resetsAt − now` to
`resetsInSeconds`, and the key itself yields `windowMinutes`. Core stops holding a shape only one
backend can produce.

### D10 — Host tools reach Claude Code over MCP

`HostToolSession` (`packages/core/src/domain/host-tools.ts`) is already transport-neutral: specs,
a host-supplied context, and an `execute` callback. Codex receives it through the App Server's
dynamic-tool protocol. Claude Code receives it as an MCP server the adapter runs over stdio,
declared with `--mcp-config` and `--strict-mcp-config`, with the tools allowed as
`mcp__sloppenheimer__<name>`. `execute` is unchanged on the far side.

This is the largest single cost in the adapter — the other pieces are ports of existing machinery;
this one is new code. It also buys a check Codex does not get: `system/init` reports the
`mcp_servers` it actually registered, so the adapter can assert the host-tool server came up
**before** the first turn and fail the launch loudly instead of running an agent whose tracker tools
silently do not exist.

### D11 — `agent.max_turns` keeps exactly one meaning

The Claude Code CLI has no `--max-turns` flag (that is an Agent SDK option), so there is no inner
budget to confuse with the host's outer loop. `agent.max_turns` continues to mean host turns, and
`runVerifiedAgent`'s loop is the only thing counting.

`--max-budget-usd` is the orthogonal bound, and `result.total_cost_usd` is reported per turn — worth
exposing in `runner.settings` and surfacing in the console, since Codex has no equivalent and cost
is the thing an operator running an unattended fleet actually wants bounded.

### D12 — Pin what the child inherits

A repository-owned workflow must not be able to pick up whatever the host operator happens to have
configured. The Claude adapter launches with:

- `--strict-mcp-config`, so only the host-tool server is reachable.
- `--setting-sources project` (or `--bare` for a fully hermetic child), so user- and local-level
  settings, hooks, and plugins do not load.
- `--permission-mode acceptEdits` as the default, matching Codex's `thread_sandbox: workspace-write`.
  `bypassPermissions` is never a default and should be rejected outright in `settings` validation
  unless a workflow opts in explicitly.
- The same environment filter Codex gets, with Claude's auth names preserved (D4).

`result.permission_denials` gives the host a post-hoc record of what the agent was refused, which
maps onto the `withheld` tool state the timeline already renders.

## Non-goals

- Running Codex and Claude Code concurrently against one workflow. One runner per workflow; a
  per-issue or per-label runner selection is a separate design if it is ever wanted.
- Renaming or generalizing the `@codex review` request in `handoff-decision.ts` and
  `handoff-reconciliation.ts`. That is a GitHub _code-review provider_ concept and is orthogonal to
  which agent authored the change — a Claude-authored PR can still be reviewed by Codex. The name
  collision is confusing and worth a follow-up issue, but changing it here would conflate two
  boundaries.
- Migrating `WORKFLOW.md` itself to Claude Code. The alias in D1 keeps it on Codex; switching
  Sloppenheimer's self-improvement loop to a different backend is a decision to take after the adapter has
  run against real issues.

## Message mapping

Verified against Claude Code 2.1.251 by capturing a real `--output-format stream-json` run.

| Claude Code message                                                                    | `AgentEvent`                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system` / `init`                                                                      | `lifecycle: session_started`; `threadId` from `session_id`; payload `{kind:'session'}`. Assert `mcp_servers` contains the host-tool server (D10). |
| `assistant` with `thinking` block                                                      | `{kind:'reasoning'}`                                                                                                                              |
| `assistant` with `text` block                                                          | `{kind:'message', role:'assistant'}`, redacted and bounded at ingest                                                                              |
| `assistant` with `tool_use` (`Bash`)                                                   | `{kind:'command', program, argumentCount, quality: qualityPhaseOf(command), state:'started'}`                                                     |
| `assistant` with `tool_use` (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`)                | `{kind:'file', path, change}`                                                                                                                     |
| `assistant` with any other `tool_use`                                                  | `{kind:'tool', name, state:'started', inputBytes}`                                                                                                |
| `user` with `tool_result`                                                              | matching tool/command `completed` or `failed`, `outputBytes` from the result content                                                              |
| `user` `tool_use_result` (`{type:'create'\|'update', filePath, structuredPatch}`)      | `{kind:'file'}` with `addedLines`/`deletedLines` counted from `structuredPatch`                                                                   |
| `rate_limit_event`                                                                     | `rateLimits` per D9                                                                                                                               |
| `result` (`subtype:'success'`, `is_error:false`)                                       | `lifecycle: turn_settled, outcome:'completed'`; `turnId` from `uuid`; `usage` per D8                                                              |
| `result` with `is_error:true` or an error subtype                                      | `lifecycle: turn_settled, outcome:'failed'`; `{kind:'error', severity:'error'}`                                                                   |
| host-initiated interruption                                                            | `lifecycle: turn_settled, outcome:'cancelled'`; `{kind:'cancellation'}`                                                                           |
| `system/thinking_tokens`, `active_goal`, `autocompact_state`, `post_turn_summary`, ... | no event (`{kind:'none'}`); tolerated and ignored, per the protocol-is-not-versioned rule                                                         |

Two notes on fidelity. `tool_use_result.structuredPatch` gives _exact_ added and deleted line counts
for file edits, which Codex does not supply — the `{kind:'file'}` payload gets better data from this
backend, not worse. And the stream carries a large tail of informational message types; the tolerant
decoding discipline in `packages/adapter-codex/src/protocol.ts` (unknown or misshapen fields degrade
to absence rather than failing the turn) applies unchanged and matters more here.

## Target structure

```
packages/core
  ports/agent-runner.ts        neutral config + settings; AgentLifecycle; no `semantics`
  domain/agent-runner.ts       registry + RegisteredAgentRunner (auth names, validate, revalidate)
  config/workflow.ts           RunnerConfig replaces CodexConfig; no backend enums
  telemetry.ts                 AgentEvent.lifecycle; RateLimitWindow[]; widened TokenCounts
packages/adapter-node
  agent-process/               promoted framing, spawn supervision, reap, redaction at ingest
packages/adapter-codex         unchanged behaviour; owns its enums and auth names
packages/adapter-claude        new
  agent-runner.ts              the port seam
  claude.ts                    session, turn loop, process supervision
  protocol.ts                  stream-json shapes, tolerant
  host-tools-mcp.ts            the MCP server carrying HostToolSession
src/agent-runners.ts           the registry, mirroring src/tracker-adapters.ts
src/config/workflow.ts         runner: {kind, settings}; codex: alias; preflight via the selection
src/cli.ts                     binds the registry, not a single layer
```

`src/agent-runners.ts` mirrors `src/tracker-adapters.ts` exactly: it is the only file that names a
concrete runner, and adding a third backend is one entry there and no change under `core/` or
`config/`.

## Phasing

**Phase 1 — neutralize core. No Claude code. Every existing test stays green.**
D1, D2, D3, D4, D6, plus the `AgentRunnerFactory` port and cell so a hot reload can replace the
runner the same way it replaces the tracker, and preflight routing through the selection rather than
`config.codex.command`. This is where the regression risk lives and it is independently reviewable
and independently valuable: it removes L1–L6 whether or not a second backend ever lands.

**Phase 2 — `packages/adapter-claude`.** Process supervision on the promoted scaffolding, the
protocol module, the message mapping above, the turn loop, workspace-identity rebinding at the same
boundaries Codex uses. Host tools deliberately absent: the runner works without them, and dispatch
already treats `hostTools` as optional.

**Phase 3 — host tools over MCP** (D10), with the `system/init` registration assertion.

**Phase 4 — observability and conformance.** Runner attribution on `AgentDetailSnapshot` and in the
console; D8 and D9 rendering; conformance-matrix rows that currently cite `codex.command` split into
per-runner rows; a `test:real-integration` profile for Claude alongside the Codex one.

## Testing

The load-bearing test for Phase 1 is not "Codex still works" — that passes even if the abstraction is
still leaky. It is a **deliberately alien fake runner**: a registered kind whose event names share no
substring with Codex's, whose settings validate against a different schema, and whose auth names are
different. Driven through the existing orchestrator suite it proves neutrality rather than
non-regression. Any literal Codex name left in core fails it.

Beyond that:

- Front-matter tests for `runner: {kind, settings}`, the `codex:` alias, and the both-declared error.
- Adapter-owned validation tests for each runner's settings, mirroring the existing
  `adapter-owned validation` tracker suite.
- A recorded stream-json fixture per mapped message type, decoded through the tolerant schemas,
  including malformed and unknown messages that must degrade to absence.
- Redaction tests proving no Claude message text is retained before passing the redactor, matching
  the rule already asserted for Codex.

## Open questions

1. **Continuation prompt.** Codex's continuation turns send a fixed "Continue working on the issue"
   string (`packages/adapter-codex/src/codex.ts`). Does that belong in each adapter, or is it
   workflow-level policy that should move into the prompt template? It is runner-independent, and
   duplicating it in the second adapter is the moment to decide.
2. **`--resume` versus a fresh process per attempt.** Retries currently relaunch. Claude Code can
   resume a session id across process restarts, which would preserve context across a retry — cheaper
   and better-informed, but it also carries failed context forward. Probably not for Phase 2, but it
   is a capability Codex does not offer and the retry policy should eventually have an opinion.
3. **Cost as a scheduling input.** `result.total_cost_usd` and `--max-budget-usd` make per-issue cost
   observable and boundable for the first time. Whether the scheduler should ever act on it (refuse
   dispatch, stop retrying) is out of scope here but is the obvious follow-on.
