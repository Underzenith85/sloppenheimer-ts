/**
 * A repair's identity: what it is dispatched against, and what it carries while it lives.
 *
 * Kept apart from the per-observation state machine in `handoff-decision.ts`, which reads these
 * rather than owning them. A repair identity outlives a single observation — it survives a refused
 * dispatch, the retry that follows one, and a restart — so the functions that create, annotate and
 * end one belong together and away from the pass that consults them.
 */

import { Option } from 'effect'

import type { Issue } from '../domain/domain.js'
import type { HandoffEntry, RepairPublication } from './state.js'

/**
 * The issue a repair agent is dispatched against: a tracker record, plus what it has to fix.
 *
 * The record is passed in rather than read from the handoff, because a queued retry has refetched
 * the issue since the handoff stored it. Dispatching the stale one would hand the worker stale
 * fields and bucket the run by a state the issue has left, which is how admission counts it.
 */
export const repairIssue = (
  handoff: HandoffEntry,
  issue: Issue,
  headSha: string | null,
  reason: string,
): Issue => ({
  ...issue,
  description: `${issue.description ?? ''}\n\n## Pull request repair\n\nPR: ${handoff.pullRequestUrl}\nHead: ${headSha}\n\n${reason}`,
})

export const awaitingSlot = (handoff: HandoffEntry, reason: string): HandoffEntry => ({
  ...handoff,
  reason: `Waiting for an agent slot. ${reason}`,
})

/**
 * A repair owns its baseline from the decision to repair, including a dispatch that was refused and
 * the retry that follows it: the retry has to render the same repair rather than the bare tracker
 * issue. The budget is still spent only by an observed new head, never by dispatching.
 */
export const afterRepairDispatched = (
  handoff: HandoffEntry,
  started: boolean,
  issue: Issue,
  headSha: string,
  reason: string,
): HandoffEntry => ({
  ...handoff,
  repair: Option.some({
    issue,
    startedHeadSha: headSha,
    inFlight: true,
    workerStarted: started,
    publication: 'pending',
    publishedHeadSha: null,
  }),
  repairObservedHeadShas: handoff.repairObservedHeadShas.includes(headSha)
    ? handoff.repairObservedHeadShas
    : [...handoff.repairObservedHeadShas, headSha],
  reason: started ? `Repair agent running. ${reason}` : `Repair agent waiting to retry. ${reason}`,
})

/**
 * Keeps a repair's baseline across an interruption that is not the repair ending.
 *
 * A worker that started may have pushed immediately before it stopped, and this baseline is the
 * only thing that can attribute that head to the repair rather than to nobody; the next handoff
 * inspection attributes it and drops the baseline. A dispatch refused before any worker started
 * produced nothing, so it has no output to keep.
 */
export const settleRepair = (handoff: HandoffEntry): HandoffEntry =>
  Option.match(handoff.repair, {
    onNone: () => handoff,
    onSome: (repair) => ({
      ...handoff,
      repair: repair.workerStarted ? Option.some({ ...repair, inFlight: false }) : Option.none(),
    }),
  })

/**
 * Records what the host's postflight made of a repair's workspace.
 *
 * A handoff with no repair in flight is left alone: the verdict belongs to the repair that
 * produced it, and a normal continuation turn's publication is not one.
 */
export const notePublication = (
  handoff: HandoffEntry,
  publication: RepairPublication,
  publishedHeadSha: string | null = null,
): HandoffEntry =>
  Option.match(handoff.repair, {
    onNone: () => handoff,
    onSome: (repair) => ({
      ...handoff,
      repair: Option.some({
        ...repair,
        publication,
        // Kept from the last publication that produced one: a delivery that fails after a
        // successful push has not un-pushed it.
        publishedHeadSha: publishedHeadSha ?? repair.publishedHeadSha,
      }),
    }),
  })

/** The repair is over: whatever it was carrying goes with it. */
export const releaseRepair = (handoff: HandoffEntry): HandoffEntry =>
  Option.isNone(handoff.repair) ? handoff : { ...handoff, repair: Option.none() }
