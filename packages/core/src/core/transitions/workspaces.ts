import { Option } from 'effect'

import type { IssueId } from '../../domain/domain.js'
import { withCappedEntry, withEntry, withoutEntry } from '../../support/collections.js'
import type { RetainedWorkspaceEntry, RuntimeState } from '../state.js'
import type { RetainedWorkspaceSnapshot } from '../runtime/types.js'

/**
 * What each issue is known to keep on disk. A measurement rather than a belief: the host counts an
 * issue's retained workspaces after a run of it ends, and forgets the count when it removes them.
 *
 * The two race, by construction: the count is taken off the loop once the run's exit is on its
 * way, and a poll may reach terminal cleanup before the count arrives. Every run number is below
 * the counter as it stands at any later instant, so a removal records the counter and a count from
 * a run older than the removal describes directories that are gone, and is refused. What a removal
 * records is bounded like every other collection here: it is worth keeping for as long as a pass
 * takes, and a host sees an unbounded number of terminal issues.
 */

/**
 * How many terminal removals are remembered. A removal is worth remembering only while a pass that
 * began before it could still report, and a long-lived host sees an unbounded stream of terminal
 * issues; the bound lives here rather than in `state.ts` because this is the rule that reads it.
 */
export const recordedWorkspaceRemovals = 500

/**
 * Records what an issue holds after a pass over its retained workspaces, unless a removal has
 * overtaken the run that counted them. An empty issue holds no row.
 */
export const recordRetainedWorkspaces = (
  state: RuntimeState,
  entry: RetainedWorkspaceEntry,
  runId: number,
): RuntimeState => {
  if ((state.workspaceRemovals.get(entry.issueId) ?? 0) > runId) {
    return state
  }
  return {
    ...state,
    retainedWorkspaces:
      entry.count === 0
        ? withoutEntry(state.retainedWorkspaces, entry.issueId)
        : withEntry(state.retainedWorkspaces, entry.issueId, entry),
  }
}

/**
 * The issue's workspaces are gone — a terminal cleanup took them — so nothing is retained, nothing
 * is owed a pass, and no count from a run that began before now may say otherwise.
 */
export const forgetRetainedWorkspaces = (state: RuntimeState, id: IssueId): RuntimeState => ({
  ...state,
  retainedWorkspaces: withoutEntry(state.retainedWorkspaces, id),
  pruneRequests: withoutEntry(state.pruneRequests, id),
  workspaceRemovals: withCappedEntry(
    state.workspaceRemovals,
    id,
    state.nextRunId,
    recordedWorkspaceRemovals,
  ),
})

/**
 * Records that a run ended while a pass for its issue was already running, so the pass runs again
 * for it once it finishes.
 *
 * A pass reads the issue directory once, at its start: a run that ends after that is invisible to
 * it, and dropping the request would leave that workspace outside the cap and the count until some
 * later run of the same issue happened to ask — which may be never. The newest asker wins, because
 * its workspace is the one the next pass must protect. The map holds one entry per issue with a
 * pass in flight, and the pass consumes it.
 */
export const requestPrune = (state: RuntimeState, id: IssueId, runId: number): RuntimeState => ({
  ...state,
  pruneRequests: withEntry(state.pruneRequests, id, runId),
})

/** Takes what a finishing pass is owed, so it runs once more for the run that asked while it ran. */
export const takePruneRequest = (
  state: RuntimeState,
  id: IssueId,
): readonly [Option.Option<number>, RuntimeState] => {
  const runId = state.pruneRequests.get(id)
  return runId === undefined
    ? [Option.none(), state]
    : [Option.some(runId), { ...state, pruneRequests: withoutEntry(state.pruneRequests, id) }]
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
