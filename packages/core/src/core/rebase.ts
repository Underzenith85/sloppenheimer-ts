/**
 * A host rebase's identity: what the host is doing to a pull request that fell behind the
 * protected base, and what its outcome does to the handoff.
 *
 * Kept beside `repair.ts` and apart from the per-observation state machine in
 * `handoff-decision.ts` for the same reason: the identity outlives a single pass -- the attempt
 * runs off the event loop and settles as an event of its own -- so the functions that begin and
 * end one belong together and away from the pass that consults them.
 *
 * A rebase is not a repair. No agent runs, the repair budget is untouched, and the identity is
 * in-memory only: a restart finds the branch either still behind, and rebases it again, or already
 * moved, and observes the new head
 * ([#274](https://github.com/Underzenith85/sloppenheimer-ts/issues/274)).
 */

import { Option } from 'effect'

import type { ExecutionSnapshot, HandoffEntry } from './state.js'

/**
 * What one rebase attempt amounted to, decided off the event loop and settled on it.
 *
 * `Conflicted` is the rebase itself refusing: the branch cannot be put on the base without a
 * decision nobody here can make. `Failed` is everything around it -- the lease, the remote, the
 * workspace -- which the next observation of the pull request retries from wherever the branch is.
 */
export type RebaseOutcome =
  | Readonly<{ _tag: 'Published'; headSha: string }>
  /** The branch already sat on the base as the remote has it now; the observation was stale. */
  | Readonly<{ _tag: 'NoChanges' }>
  | Readonly<{ _tag: 'Conflicted'; message: string }>
  | Readonly<{ _tag: 'Blocked'; message: string }>
  | Readonly<{ _tag: 'Failed'; message: string }>

/**
 * Whether the host is performing a rebase on this pull request right now. A rebase that has
 * published and is waiting for the provider to report its head is over as far as the branch is
 * concerned: the pass may observe the pull request again, and the claim may be released.
 */
export const rebaseInFlight = (handoff: HandoffEntry): boolean =>
  Option.exists(handoff.rebase, (rebase) => rebase.publishedHeadSha === null)

/**
 * The rebase owns the pull request from here until the attempt reports back. The execution it
 * records is the one the attempt is forked with, so a reload that moves the handoff on cannot
 * retire the instances the attempt is still using.
 */
export const rebaseStarted = (handoff: HandoffEntry, headSha: string): HandoffEntry => ({
  ...handoff,
  rebase: Option.some({ headSha, execution: handoff.execution, publishedHeadSha: null }),
  reason: 'Rebasing the pull request branch onto protected main',
})

/** The executions rebases in flight are still calling through, which a retirement must wait for. */
export const inFlightRebaseExecutions = (
  handoffs: Iterable<HandoffEntry>,
): readonly ExecutionSnapshot[] =>
  [...handoffs].flatMap((handoff) =>
    rebaseInFlight(handoff)
      ? Option.toArray(Option.map(handoff.rebase, (rebase) => rebase.execution))
      : [],
  )

/**
 * Folds the attempt's outcome into the handoff.
 *
 * A published rebase keeps its identity, with the head it pushed, until the provider reports that
 * head: the next observation may still carry the head the rebase replaced, and acting on that
 * would rebase the branch a second time against a lease the push already moved. Every other
 * outcome ends the identity. A conflict needs a human -- the provider said the branch was merely
 * behind, so what refused is the rebase itself, and a repair agent is given no more than a rebase
 * has. Anything else is retried from wherever the next observation finds the branch.
 */
export const rebaseSettled = (handoff: HandoffEntry, outcome: RebaseOutcome): HandoffEntry => {
  const released: HandoffEntry = { ...handoff, rebase: Option.none() }
  switch (outcome._tag) {
    case 'Published': {
      return {
        ...handoff,
        rebase: Option.map(handoff.rebase, (rebase) => ({
          ...rebase,
          publishedHeadSha: outcome.headSha,
        })),
        state: 'awaiting_checks',
        headSha: outcome.headSha,
        reason:
          'Rebased the pull request branch onto protected main; waiting for the pull request to report the new head',
      }
    }
    case 'NoChanges': {
      return {
        ...released,
        state: 'awaiting_checks',
        reason:
          'The pull request branch already sits on protected main; waiting for the pull request to report it',
      }
    }
    case 'Conflicted': {
      return {
        ...released,
        state: 'intervention_required',
        reason: `The pull request branch is behind protected main and could not be rebased onto it: ${outcome.message}`,
      }
    }
    case 'Blocked': {
      return {
        ...released,
        state: 'intervention_required',
        reason: `Rebased candidate is held before publication: ${outcome.message}`,
      }
    }
    case 'Failed': {
      return {
        ...released,
        reason: `Could not rebase the pull request branch onto protected main: ${outcome.message}`,
      }
    }
  }
}
