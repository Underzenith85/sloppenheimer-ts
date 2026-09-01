import { Option } from 'effect'

import type { IssueId } from '../../domain/domain.js'
import type { HandoffSnapshot } from '../../domain/handoff.js'
import { withEntry, withoutEntry, withMember, withoutMember } from '../../support/collections.js'
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
    // A repair whose delivery failed keeps that verdict across a restart: recovery must not read
    // the unchanged head it left behind as a repair that achieved nothing.
    repairPublication: Option.match(handoff.repair, {
      onNone: () => 'pending' as const,
      onSome: (repair) => repair.publication,
    }),
    repairPublishedHeadSha: Option.match(handoff.repair, {
      onNone: () => null,
      onSome: (repair) => repair.publishedHeadSha,
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

/** The sweep that precedes the first reconciliation has run. */
export const finishStartupSweep = (state: RuntimeState): RuntimeState => ({
  ...state,
  startupSweepFinished: true,
})

/**
 * Records what looking at one issue's workspace for unpublished work established.
 *
 * `examined` moves the issue out of what dispatch refuses and into what the scan will not repeat;
 * anything else leaves it owed a look, which is what dispatch consults. Stated per issue because
 * the set of candidates is not fixed: an issue that becomes active later arrives owed one.
 */
export const noteWorkspaceExamined = (
  state: RuntimeState,
  id: IssueId,
  examined: boolean,
): RuntimeState =>
  examined
    ? {
        ...state,
        examinedWorkspaces: withMember(state.examinedWorkspaces, id),
        unexaminedWorkspaces: withoutMember(state.unexaminedWorkspaces, id),
      }
    : {
        ...state,
        // Forgotten rather than merely flagged: what is on disk is unknown again, so the pass that
        // clears this has to look rather than read its own earlier answer.
        examinedWorkspaces: withoutMember(state.examinedWorkspaces, id),
        unexaminedWorkspaces: withMember(state.unexaminedWorkspaces, id),
      }

/**
 * Forgets what examining the workspaces established, because they are no longer those workspaces.
 *
 * The record is keyed by issue, and what it records is a fact about a directory: a reload that
 * moves the workspace root leaves every one of those answers describing files somewhere else. A
 * root switched back to one an earlier process used holds that process's retained work, and an
 * issue still marked examined would have the dispatch pass skip straight past it and give an agent
 * a workspace nobody has looked at.
 *
 * What is owed a look is not forgotten with it: an issue recorded unexamined is still owed one, and
 * the examination that answers clears it.
 */
export const forgetWorkspaceExaminations = (state: RuntimeState): RuntimeState => ({
  ...state,
  examinedWorkspaces: new Set(),
  // The sweep is owed again for the same reason it is owed at startup: reconciliation dispatches a
  // repair before any candidate fetch happens, so without one a repair would be the first thing
  // into a workspace under the new root that nothing has read.
  startupSweepFinished: false,
})

/**
 * A continuation is queued for this issue, so its workspace has an owner again.
 *
 * The cancellation that preceded this recorded the workspace as unread, because an interrupted run
 * leaves an unknown. A retry resolves that differently from an examination and just as well: the
 * same session is going back into the same workspace, so what is in there is its own work in
 * progress rather than something a later run would adopt as its own. The examination exists for
 * the case where nothing is coming back.
 */
export const noteWorkspaceContinued = (state: RuntimeState, id: IssueId): RuntimeState =>
  state.unexaminedWorkspaces.has(id) ? noteWorkspaceExamined(state, id, true) : state

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
