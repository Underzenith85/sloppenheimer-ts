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
  pruneRuns: withoutEntry(state.pruneRuns, id),
  workspaceRemovals: withCappedEntry(
    state.workspaceRemovals,
    id,
    state.nextRunId,
    recordedWorkspaceRemovals,
  ),
})

/**
 * Admits one pass per issue, and records what a refused one is owed. Answers whether the caller is
 * the pass: an issue with no entry gets one and is told to run; an issue that already has a pass
 * has this run recorded against it instead.
 *
 * Both halves are this one transition, and taking the owed run is the other, because the two are a
 * handoff: a pass that read no owed run and a caller that saw a fiber still in the collection are
 * both looking at an instant, and between those two instants a request can be written that nothing
 * consumes and a pass started that nothing knows about. The state says which passes are running,
 * as it says what is running everywhere else; the fiber collection only owns them.
 *
 * A pass reads the issue directory once, at its start, so a run that ends after that is invisible
 * to it and its request has to outlive the refusal. The newest asker wins: its workspace is the one
 * the next round must protect. One entry per issue with a pass in flight, taken when it ends.
 */
export const admitPrune = (
  state: RuntimeState,
  id: IssueId,
  runId: number,
): readonly [boolean, RuntimeState] =>
  state.pruneRuns.has(id)
    ? [false, { ...state, pruneRuns: withEntry(state.pruneRuns, id, runId) }]
    : [true, { ...state, pruneRuns: withEntry(state.pruneRuns, id, null) }]

/**
 * What a finishing pass is owed: the run that asked while it ran, or nothing — and nothing takes
 * the issue out of the running set in the same step, so the next caller is admitted rather than
 * recorded against a pass that has ended.
 */
export const takePruneRequest = (
  state: RuntimeState,
  id: IssueId,
): readonly [Option.Option<number>, RuntimeState] => {
  const owed = state.pruneRuns.get(id)
  return owed === undefined || owed === null
    ? [Option.none(), { ...state, pruneRuns: withoutEntry(state.pruneRuns, id) }]
    : [Option.some(owed), { ...state, pruneRuns: withEntry(state.pruneRuns, id, null) }]
}

/** Forgets that a pass is running, for one that ended without taking what it was owed. */
export const releasePruneRun = (state: RuntimeState, id: IssueId): RuntimeState => ({
  ...state,
  pruneRuns: withoutEntry(state.pruneRuns, id),
})

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
