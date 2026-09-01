import type { Issue, IssueId } from '../../domain/domain.js'
import { withEntry, withMember, withoutMember } from '../../support/collections.js'
import { rememberedIdentifiers, type CompletedEntry, type RuntimeState } from '../state.js'

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
