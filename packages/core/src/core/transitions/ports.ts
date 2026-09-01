import { Option } from 'effect'

import { withEntry } from '../../support/collections.js'
import type {
  EffectiveWorkflow,
  ExecutionSnapshot,
  PendingRetirement,
  RuntimeState,
} from '../state.js'

/**
 * What happens to port instances a reload replaced: the retirements still waiting on a live run,
 * and the adoption that moves running work and in-flight handoffs onto the replacements.
 */

export const noteRetirement = (
  state: RuntimeState,
  retirement: PendingRetirement,
): RuntimeState => ({
  ...state,
  pendingRetirements: [...state.pendingRetirements, retirement],
})

/** Takes the whole pending list; the caller returns whatever is still held. */
export const takeRetirements = (
  state: RuntimeState,
): readonly [readonly PendingRetirement[], RuntimeState] => [
  state.pendingRetirements,
  { ...state, pendingRetirements: [] },
]

export const holdRetirements = (
  state: RuntimeState,
  held: readonly PendingRetirement[],
): RuntimeState => ({ ...state, pendingRetirements: [...state.pendingRetirements, ...held] })

export const noteSupersededPorts = (
  state: RuntimeState,
  runId: number,
  instances: readonly unknown[],
): RuntimeState => ({
  ...state,
  supersededPorts: withEntry(state.supersededPorts, runId, [
    ...(state.supersededPorts.get(runId) ?? []),
    ...instances,
  ]),
})

/** Forgets the ports of runs that have ended: nothing can still be calling through them. */
export const pruneSupersededPorts = (state: RuntimeState): RuntimeState => {
  const live = new Set([...state.running.values()].map((entry) => entry.runId))
  const next = new Map(state.supersededPorts)
  for (const runId of state.supersededPorts.keys()) {
    if (!live.has(runId)) {
      next.delete(runId)
    }
  }
  return next.size === state.supersededPorts.size ? state : { ...state, supersededPorts: next }
}

/**
 * Moves live work onto replacement ports. A running worker and an in-flight handoff each hold the
 * instances their run started with, so a rebuilt tracker reaches them only here.
 *
 * The instances a run is losing are returned per run, so the caller can record what may still have
 * a call in flight against it before the replacement takes over.
 */
export const adoptExecutions = (
  state: RuntimeState,
  previous: EffectiveWorkflow,
  next: EffectiveWorkflow,
): RuntimeState => {
  const adopted = (execution: ExecutionSnapshot): ExecutionSnapshot => ({
    ...execution,
    tracker: next.tracker,
    codeReview:
      execution.codeReview === previous.codeReview ? next.codeReview : execution.codeReview,
    sourceControl:
      execution.sourceControl === previous.sourceControl
        ? next.sourceControl
        : execution.sourceControl,
    secretEnvironmentNames: [...next.tracker.secretEnvironmentNames],
  })
  let updated = state
  for (const [id, entry] of state.running) {
    if (entry.execution.tracker !== previous.tracker) {
      continue
    }
    // Recorded before the swap: this run's own fibers may still be awaiting a call that read
    // these, and nothing else will remember they were ever in use.
    updated = noteSupersededPorts(updated, entry.runId, [
      entry.execution.tracker,
      ...Option.toArray(entry.execution.codeReview),
      ...(entry.execution.sourceControl === null ? [] : [entry.execution.sourceControl]),
    ])
    updated = {
      ...updated,
      running: withEntry(updated.running, id, {
        ...entry,
        execution: adopted(entry.execution),
      }),
    }
  }
  for (const [id, entry] of state.handoffs) {
    if (entry.execution.tracker !== previous.tracker) {
      continue
    }
    updated = {
      ...updated,
      handoffs: withEntry(updated.handoffs, id, { ...entry, execution: adopted(entry.execution) }),
    }
  }
  return updated
}
