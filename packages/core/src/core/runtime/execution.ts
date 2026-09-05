import { Effect, Fiber, FiberMap, type Scope } from 'effect'

import type { IssueId } from '../../domain/domain.js'

/**
 * Execution ownership: every long-lived fiber the running host forks, held in one keyed collection
 * whose scope is the orchestrator's own.
 *
 * A fiber is keyed by what it is doing and which issue it is doing it for, so replacement is the
 * collection's job rather than a step each call site remembers: forking under a key interrupts
 * whatever that key held, and a fiber that finishes takes itself out. Closing the orchestrator's
 * scope interrupts everything still in it and waits for the finalizers those interruptions run.
 *
 * This owns execution and nothing else. What is running, what is retrying and what is waiting to
 * be delivered are answered by `RuntimeState` in `core/state.ts`, which stays the one place
 * domain-visible metadata lives; a reader asking whether an issue has a worker asks the state,
 * never this.
 */

/**
 * What a keyed fiber is doing for its issue.
 *
 * `prune` is the pass that bounds what an issue keeps on disk, and it is a key of its own rather
 * than the tail of the `worker` that starts it: a continuation is dispatched one second after a
 * turn ends, and a pass sharing the worker's key would be interrupted by it on every attempt —
 * which is exactly the run of repeated attempts the cap exists for. Unlike every other key here,
 * it is never superseded; `run-workspace.ts` says why.
 */
export type ExecutionPurpose = 'worker' | 'retry' | 'delivery' | 'rebase' | 'prune' | 'recovery'

/** The fibers one orchestrator owns, keyed by purpose and issue. */
export type ExecutionOwner = FiberMap.FiberMap<string, void>

/**
 * The polling timer's key. It belongs to the host rather than to an issue, and there is one of it:
 * arming the next pass replaces the pass the previous interval had pending.
 */
const pollTimerKey = 'poll:timer'

const issueKey = (purpose: ExecutionPurpose, id: IssueId): string => `${purpose}:${id}`

/** Opens the collection, which the surrounding scope closes by interrupting everything in it. */
export const makeExecutionOwner = (): Effect.Effect<ExecutionOwner, never, Scope.Scope> =>
  FiberMap.make<string, void>()

/**
 * Forks `body` as the issue's fiber for this purpose, interrupting whatever the key held.
 *
 * The displaced fiber's interruption is signalled rather than awaited, because a caller replacing
 * a run's publication must not be made to wait on a git push whose child process has not closed —
 * and a timer's interruption is immediate either way.
 */
export const ownIssueFiber = (
  owner: ExecutionOwner,
  purpose: ExecutionPurpose,
  id: IssueId,
  body: Effect.Effect<void>,
): Effect.Effect<void> => Effect.asVoid(FiberMap.run(owner, issueKey(purpose, id), body))

/** Arms the polling timer, replacing whatever pass the previous interval had pending. */
export const ownPollTimer = (
  owner: ExecutionOwner,
  body: Effect.Effect<void>,
): Effect.Effect<void> => Effect.asVoid(FiberMap.run(owner, pollTimerKey, body))

/**
 * Interrupts the issue's fiber for this purpose and waits for it to finish, so a caller that goes
 * on to dispose of what the fiber was holding — a workspace, a repair identity — does so after the
 * fiber's own finalizers have run. A key holding nothing is nothing to interrupt.
 */
export const releaseIssueFiber = (
  owner: ExecutionOwner,
  purpose: ExecutionPurpose,
  id: IssueId,
): Effect.Effect<void> => FiberMap.remove(owner, issueKey(purpose, id))

/**
 * Interrupts the issue's fiber for this purpose without ever waiting for it.
 *
 * A publication is git: it can be inside a push whose child process has not closed, and awaiting
 * that interrupt on the event loop would block every issue the host is running — the very thing
 * running the attempt off the loop exists to prevent. The fiber leaves the collection when the
 * interruption it was sent completes.
 */
export const releaseIssueFiberFork = (
  owner: ExecutionOwner,
  purpose: ExecutionPurpose,
  id: IssueId,
): Effect.Effect<void> =>
  FiberMap.get(owner, issueKey(purpose, id)).pipe(
    Effect.flatMap(Fiber.interruptFork),
    Effect.ignore,
  )
