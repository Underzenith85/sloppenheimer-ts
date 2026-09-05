/**
 * Every transition the scheduler makes, as a pure function of the state and the thing that
 * happened. No fibers, no ports, no clock: a caller supplies whatever it observed, and gets the
 * next state back.
 *
 * A transition the caller must then act on — a retry fiber to interrupt, a run entry to account for
 * — hands the value back beside the state rather than performing the effect itself, so the decision
 * stays separable from what carries it out. Those return `[value, nextState]`, which is the order
 * `Ref.modify` consumes and so the order a call site can hand straight to the cell. A lookup that
 * may find nothing answers with `Option`, because what it found is what decides the caller's next
 * branch — never with `null`, which this codebase keeps for data that is serialized.
 *
 * This module is the whole surface, grouped by what the transition is about:
 *
 * - `transitions/claims.ts` — taking responsibility for an issue, and giving it up.
 * - `transitions/runs.ts` — the live runs and the telemetry their callbacks buffer.
 * - `transitions/retries.ts` — the queued retries, and the operator's pause list.
 * - `transitions/deliveries.ts` — work waiting to reach the remote, and the retries queued for it.
 * - `transitions/handoffs.ts` — the pull requests being followed, and startup recovery's counters.
 * - `transitions/details.ts` — the detail records and the index consumers read them through.
 * - `transitions/scheduling.ts` — the tick debounce, refresh waiters, and the workflow in force.
 * - `transitions/ports.ts` — retiring replaced port instances and adopting live work onto new ones.
 * - `transitions/workspaces.ts` — what each issue is known to keep on disk.
 *
 * The groups are a reading order rather than a layering: `retries`, `deliveries` and `handoffs`
 * claim through `claims`, and nothing else here imports a sibling.
 */

export * from './transitions/claims.js'
export * from './transitions/deliveries.js'
export * from './transitions/details.js'
export * from './transitions/handoffs.js'
export * from './transitions/ports.js'
export * from './transitions/retries.js'
export * from './transitions/runs.js'
export * from './transitions/scheduling.js'
export * from './transitions/workspaces.js'
