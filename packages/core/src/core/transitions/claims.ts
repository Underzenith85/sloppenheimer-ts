import type { Issue, IssueId } from '../../domain/domain.js'
import { withEntry, withMember, withoutMember } from '../../support/collections.js'
import {
  publishedCompletedWork,
  rememberedIdentifiers,
  type CompletedEntry,
  type CompletedSnapshot,
  type RuntimeState,
} from '../state.js'

/**
 * The claim lifecycle: which issues this orchestrator has taken responsibility for, and what they
 * finished as.
 */

/**
 * Remembers an issue's identifier so a detail request for it can be answered after its record has
 * gone. Bounded, oldest first.
 */
export const noteIssue = (state: RuntimeState, issue: Issue): RuntimeState => {
  const identifiers = withEntry(state.identifiers, issue.id, issue.identifier)
  if (identifiers.size <= rememberedIdentifiers) {
    return { ...state, identifiers }
  }
  const next = new Map(identifiers)
  const oldest = next.keys().next()
  if (!oldest.done) {
    next.delete(oldest.value)
  }
  return { ...state, identifiers: next }
}

/** Takes responsibility for an issue: nothing else dispatches it while the claim stands. */
export const claimIssue = (state: RuntimeState, issue: Issue): RuntimeState =>
  noteIssue({ ...state, claimed: withMember(state.claimed, issue.id) }, issue)

export const releaseClaim = (state: RuntimeState, id: IssueId): RuntimeState => ({
  ...state,
  claimed: withoutMember(state.claimed, id),
})

/**
 * The issue is finished with: what it finished as is filed, and the claim is given up in the same
 * step. Nothing else may complete an issue while still holding it.
 */
export const completeIssue = (
  state: RuntimeState,
  id: IssueId,
  finished: CompletedEntry,
): RuntimeState => ({
  ...state,
  completed: withEntry(state.completed, id, finished),
  claimed: withoutMember(state.claimed, id),
})

/**
 * Everything this host can say it finished, newest first: what it merged itself, followed by what
 * an earlier host merged and this one restored.
 *
 * A restored completion is dropped the moment this host completes the same issue again, so a
 * republished record never outlives the live one it describes.
 */
export const completionSnapshots = (state: RuntimeState): readonly CompletedSnapshot[] => {
  const live = [...state.completed.values()].map((entry): CompletedSnapshot => ({
    issueId: entry.issueId,
    identifier: entry.identifier,
    title: entry.title,
    url: entry.url,
    outcome: entry.outcome,
    finishedAt: entry.finishedAt.toISOString(),
    pullRequestUrl: entry.pullRequestUrl,
  }))
  const restored = state.restoredCompletions.filter(
    (completion) => !state.completed.has(completion.issueId),
  )
  return [...live, ...restored].sort(
    (left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt),
  )
}

/**
 * What the snapshot publishes and the completion store persists. Bounded rather than complete: a
 * host that has merged thousands of issues owes the console the recent ones, and owes its
 * successor no more than the console would show.
 */
export const publishedCompletions = (state: RuntimeState): readonly CompletedSnapshot[] =>
  completionSnapshots(state).slice(0, publishedCompletedWork)
