import { Option } from 'effect'

import type { IssueId } from '../../domain/domain.js'
import type { HandoffSnapshot } from '../../domain/handoff.js'
import { withEntry, withoutEntry, withMember } from '../../support/collections.js'
import type { CompletedEntry, HandoffEntry, HandoffRecoveryCounts, RuntimeState } from '../state.js'
import { claimIssue, completeIssue } from './claims.js'

/**
 * The pull requests this orchestrator is still following, what the store is asked to persist for
 * them, and the counters startup recovery reports through.
 */

export const putHandoff = (state: RuntimeState, id: IssueId, entry: HandoffEntry): RuntimeState => {
  const claimed = claimIssue(state, entry.issue)
  return { ...claimed, handoffs: withEntry(claimed.handoffs, id, entry) }
}

export const removeHandoff = (state: RuntimeState, id: IssueId): RuntimeState => ({
  ...state,
  handoffs: withoutEntry(state.handoffs, id),
})

/** The pull request is finished with: the handoff goes, and the issue is completed and released. */
export const completeHandoff = (
  state: RuntimeState,
  id: IssueId,
  finished: CompletedEntry,
): RuntimeState => completeIssue(removeHandoff(state, id), id, finished)

/**
 * What the store is asked to persist: the handoffs still waiting for hydration, followed by the
 * live ones. A restored handoff that has not been hydrated is still this orchestrator's to keep.
 */
export const handoffSnapshots = (state: RuntimeState): readonly HandoffSnapshot[] => [
  ...state.pendingRestoredHandoffs,
  ...[...state.handoffs.values()].map((handoff) => ({
    issueId: handoff.issue.id,
    identifier: handoff.issue.identifier,
    pullRequestUrl: handoff.pullRequestUrl,
    branchName: handoff.branchName,
    state: handoff.state,
    headSha: handoff.headSha,
    reason: handoff.reason,
    repairAttempts: handoff.repairHeadShas.length,
    repairHeadShas: [...handoff.repairHeadShas],
    repairObservedHeadShas: [...handoff.repairObservedHeadShas],
    repairStartedHeadSha: Option.match(handoff.repair, {
      onNone: () => null,
      onSome: (repair) => repair.startedHeadSha,
    }),
    // Persisted beside the baseline: a refused dispatch owns a baseline without ever having run,
    // so recovery must not read the next head change as that repair's output.
    repairWorkerStarted: Option.match(handoff.repair, {
      onNone: () => false,
      onSome: (repair) => repair.workerStarted,
    }),
    reviewRequestedHeadSha: handoff.reviewRequestedHeadSha,
    reviewCompletedHeadSha: handoff.reviewCompletedHeadSha,
    observedAt: handoff.observedAt.toISOString(),
  })),
]

/**
 * Startup recovery's counters, as the console publishes them, and the restored handoffs still
 * waiting to be hydrated against a live tracker.
 */
export const noteRecovery = (
  state: RuntimeState,
  counted: Partial<HandoffRecoveryCounts>,
): RuntimeState => ({
  ...state,
  recoveryCounts: {
    loaded: state.recoveryCounts.loaded + (counted.loaded ?? 0),
    recovered: state.recoveryCounts.recovered + (counted.recovered ?? 0),
    skipped: state.recoveryCounts.skipped + (counted.skipped ?? 0),
    failed: state.recoveryCounts.failed + (counted.failed ?? 0),
  },
})

export const resolveRecovery = (state: RuntimeState, id: IssueId): RuntimeState => ({
  ...state,
  recoveryResolved: withMember(state.recoveryResolved, id),
})

export const finishStartupRecovery = (state: RuntimeState): RuntimeState => ({
  ...state,
  startupRecoveryFinished: true,
})

export const setHandoffStoreError = (
  state: RuntimeState,
  error: RuntimeState['handoffStoreError'],
): RuntimeState => ({ ...state, handoffStoreError: error })

export const dropRestoredHandoffs = (
  state: RuntimeState,
  hydrated: ReadonlySet<string>,
): RuntimeState => ({
  ...state,
  pendingRestoredHandoffs: state.pendingRestoredHandoffs.filter(
    (handoff) => !hydrated.has(handoff.issueId),
  ),
})
