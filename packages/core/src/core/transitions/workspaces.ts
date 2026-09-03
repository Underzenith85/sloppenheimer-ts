import type { IssueId } from '../../domain/domain.js'
import { withEntry, withoutEntry } from '../../support/collections.js'
import type { RetainedWorkspaceEntry, RuntimeState } from '../state.js'
import type { RetainedWorkspaceSnapshot } from '../runtime/types.js'

/**
 * What each issue is known to keep on disk. A measurement rather than a belief: the host counts an
 * issue's retained workspaces after a run of it ends, and forgets the count when it removes them.
 */

/** Records what an issue holds after a pass over its retained workspaces. An empty issue holds no row. */
export const recordRetainedWorkspaces = (
  state: RuntimeState,
  entry: RetainedWorkspaceEntry,
): RuntimeState => ({
  ...state,
  retainedWorkspaces:
    entry.count === 0
      ? withoutEntry(state.retainedWorkspaces, entry.issueId)
      : withEntry(state.retainedWorkspaces, entry.issueId, entry),
})

/** The issue's workspaces are gone — a terminal cleanup took them — so nothing is retained. */
export const forgetRetainedWorkspaces = (state: RuntimeState, id: IssueId): RuntimeState => {
  const retainedWorkspaces = withoutEntry(state.retainedWorkspaces, id)
  return retainedWorkspaces === state.retainedWorkspaces ? state : { ...state, retainedWorkspaces }
}

/** Every issue holding retained workspaces, largest first so the growth is at the top. */
export const retainedWorkspaceSnapshots = (
  state: RuntimeState,
): readonly RetainedWorkspaceSnapshot[] =>
  [...state.retainedWorkspaces.values()]
    .map((entry) => ({
      issueId: entry.issueId,
      identifier: entry.identifier,
      count: entry.count,
      bytes: entry.bytes,
      observedAt: entry.observedAt.toISOString(),
    }))
    .sort(
      (left, right) =>
        right.bytes - left.bytes ||
        right.count - left.count ||
        left.identifier.localeCompare(right.identifier),
    )
