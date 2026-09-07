/**
 * A publication without a live coder borrows an ordinary worker slot only while resolving files.
 * Its parent retains the workspace lease and publication identity. The worker is supervised under
 * the usual cancellation key, and its finalizers finish before the parent can continue Git.
 */
import { Clock, Deferred, Effect, Exit, MutableRef, Ref, Schedule } from 'effect'
import { SourceControlError } from '../domain/errors.js'
import type { Issue } from '../domain/domain.js'
import type { PreparedRepository, ResolvePublicationConflict } from '../ports/source-control.js'
import { currentInstant } from '../support/clock.js'
import { makeHostToolSession, startingRun, type SessionLaunch } from './dispatch.js'
import { hasSlot } from './policy.js'
import { publicationEligibility } from './publication-eligibility.js'
import { resolvePublicationConflict } from './publication-conflict.js'
import { ownIssueFiber, releaseIssueFiber } from './runtime/execution.js'
import type { OrchestratorContext } from './runtime.js'
import type { ExecutionSnapshot, SessionPorts, RuntimeState } from './state.js'
import * as Transitions from './transitions.js'

const held = (message: string): SourceControlError =>
  new SourceControlError({
    category: 'conflict_repair_failed',
    message,
    retryable: false,
    worktreePreserved: true,
  })

const reserveSlot = (launch: SessionLaunch): Effect.Effect<void, SourceControlError> =>
  Effect.gen(function* () {
    yield* publicationEligibility(launch.context.state, launch.issue, launch.execution)
    const now = yield* Clock.currentTimeMillis
    const durable = (yield* launch.context.durable.snapshot).find(
      (record) => record.issueId === launch.issue.id,
    )
    if (durable === undefined || now >= durable.budgetDeadline) {
      return yield* Effect.fail(
        held('Publication conflict exceeded its workflow deadline while waiting for capacity'),
      )
    }
    const startedAt = yield* currentInstant
    return yield* Ref.modify(launch.context.state, (state): readonly [boolean, RuntimeState] => {
      if (
        state.running.has(launch.issue.id) ||
        !hasSlot(state, launch.issue, launch.execution.workflow)
      ) {
        return [false, state]
      }
      return [
        true,
        Transitions.beginRun(state, {
          ...startingRun(launch, startedAt),
          phase: { _tag: 'Postflight', startedAt },
        }),
      ]
    })
  }).pipe(
    Effect.repeat({ schedule: Schedule.spaced('1 second'), until: (reserved) => reserved }),
    Effect.asVoid,
  )

const runOwnedRepair = (
  launch: SessionLaunch,
  action: Effect.Effect<void, SourceControlError>,
): Effect.Effect<void, SourceControlError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const completed = yield* Deferred.make<Exit.Exit<void, SourceControlError>>()
      const accountedByWorker = yield* Ref.make(false)
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const account = yield* Ref.get(accountedByWorker)
          const endedAt = yield* currentInstant
          yield* Ref.update(launch.context.state, (state) => {
            const [entry, next] = Transitions.endRun(state, launch.issue.id, launch.runId)
            return account && entry._tag === 'Some'
              ? Transitions.accountEndedRun(next, entry.value, endedAt.getTime())
              : next
          })
        }),
      )
      yield* reserveSlot(launch)
      yield* Effect.acquireRelease(
        ownIssueFiber(
          launch.context.execution,
          'worker',
          launch.issue.id,
          action.pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Ref.set(accountedByWorker, true).pipe(
                Effect.zipRight(Deferred.succeed(completed, exit)),
              ),
            ),
            Effect.asVoid,
            Effect.onInterrupt(() =>
              Deferred.succeed(
                completed,
                Exit.fail(held('Publication conflict repair was cancelled')),
              ),
            ),
          ),
        ),
        () => releaseIssueFiber(launch.context.execution, 'worker', launch.issue.id),
      )
      const outcome = yield* Deferred.await(completed)
      return yield* outcome
    }),
  )

export const retainedConflictResolver =
  (
    context: OrchestratorContext,
    issue: Issue,
    execution: ExecutionSnapshot,
    prepared: PreparedRepository,
  ): ResolvePublicationConflict =>
  (conflict) =>
    Effect.gen(function* () {
      yield* execution.journal?.publication.conflicted?.(conflict) ?? Effect.void
      const runId = yield* Ref.modify(context.state, Transitions.takeRunId)
      const sessionPorts = MutableRef.make<SessionPorts>({
        tracker: execution.tracker,
        codeReview: execution.codeReview,
        sourceControl: execution.sourceControl,
      })
      const launch: SessionLaunch = {
        context,
        issue,
        execution,
        runId,
        sessionPorts,
        attempt: null,
        hostTools: makeHostToolSession(execution, issue, () => MutableRef.get(sessionPorts)),
        target: prepared.target,
        repairRun: prepared.target._tag === 'Repair',
      }
      yield* runOwnedRepair(
        launch,
        resolvePublicationConflict(launch, prepared.workspace)(conflict),
      )
    })
