/**
 * Canonical agent session telemetry.
 *
 * One pipeline carries everything an operator can see about a live agent: the selected runner's
 * adapter normalizes each protocol message into a bounded, already-redacted
 * {@link AgentEventPayload} and states what that message means for the session's lifecycle, and the
 * orchestrator folds those payloads — plus the scheduling facts only it knows, such as retries,
 * cancellations, and pull-request handoff — into an actor-owned {@link AgentDetailRecord}. The
 * record is never read directly by a consumer; the actor publishes exact, immutable
 * {@link AgentDetailSnapshot} values built from it.
 *
 * This module is that pipeline's whole public surface, in the order it runs:
 *
 * - `telemetry/events.ts` — what a runner's adapter produces.
 * - `telemetry/snapshot.ts` — the read model a consumer receives, and the retention limits.
 * - `telemetry/record.ts` — the actor-owned record everything is folded into.
 * - `telemetry/agent-event.ts` — the fold for one agent event.
 * - `telemetry/lifecycle.ts` — the folds for the scheduling facts no agent event reports.
 * - `telemetry/detail.ts` — building the published snapshot from the record.
 *
 * `telemetry/folding.ts` holds the folds those recorders share and is deliberately not re-exported:
 * an observation is recorded by naming what was observed, never by appending to the timeline
 * directly.
 */

export * from './telemetry/agent-event.js'
export * from './telemetry/detail.js'
export * from './telemetry/events.js'
export * from './telemetry/lifecycle.js'
export * from './telemetry/record.js'
export * from './telemetry/snapshot.js'
