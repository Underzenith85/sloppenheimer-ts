import { Cause, Clock, Effect, Exit, Option } from 'effect'

import type { DurableWorkflow, Operation } from '../../domain/durable-workflow.js'
import type { WorkflowStoreError } from '../../domain/errors.js'
import { WorkflowStore } from '../../ports/workflow-store.js'
import { applyWorkflowEvent } from './controller.js'
import { transitionWorkflow, type WorkflowEvent } from './transition.js'

export type OperationResult = Omit<
  Extract<WorkflowEvent, { _tag: 'Settled' }>,
  '_tag' | 'operationId' | 'generation'
>

type ClaimedOperation = Readonly<{
  workflow: DurableWorkflow
  operation: Operation
  deadline: number
}>

/** Only the writer that advances Queued to Executing owns permission to launch the command. */
const claim = (
  issueId: string,
  operationId: string,
  generation: number,
): Effect.Effect<Option.Option<ClaimedOperation>, WorkflowStoreError, WorkflowStore> =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore
    const current = yield* store.get(issueId)
    if (Option.isNone(current)) {
      return Option.none()
    }
    const before = current.value
    if (before.status._tag !== 'Queued') {
      return Option.none()
    }
    const next = transitionWorkflow(
      before,
      { _tag: 'Started', operationId, generation },
      yield* Clock.currentTimeMillis,
    )
    if (next === before) {
      return Option.none()
    }
    yield* store.commit(next, before.revision)
    return next.status._tag === 'Executing'
      ? Option.some({
          workflow: next,
          operation: next.status.operation,
          deadline: next.status.deadline,
        })
      : Option.none()
  })

const outcomeOf = (
  operation: Operation,
  exit: Exit.Exit<Option.Option<OperationResult>, never>,
): OperationResult => {
  if (Exit.isSuccess(exit) && Option.isSome(exit.value)) {
    return exit.value.value
  }
  return {
    outcome: Exit.isFailure(exit) && Cause.isDie(exit.cause) ? 'crashed' : 'unknown',
    next: { _tag: 'Reconciling', operation },
    artifact: null,
    failureSignature: null,
  }
}

/**
 * Adapters report expected failures as typed outcomes; defects remain defects. Every invocation
 * gets its own scope, and settlement is committed only after its resources have finalized.
 * An interrupted or timed-out command may have changed the outside world: reconciliation, never
 * an automatic replay, is its next step. A store failure prevents further execution.
 *
 * The caller owns this effect in a keyed scope and interrupts it when durable intent changes.
 * This boundary does not poll tracker state or adopt workspaces.
 */
export const executeWorkflowOperation = <Requirements>(
  issueId: string,
  operationId: string,
  generation: number,
  execute: (
    workflow: DurableWorkflow,
    operation: Operation,
  ) => Effect.Effect<OperationResult, never, Requirements>,
): Effect.Effect<void, WorkflowStoreError, WorkflowStore | Requirements> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const claimed = yield* claim(issueId, operationId, generation)
      if (Option.isNone(claimed)) {
        return
      }
      const { workflow, operation, deadline } = claimed.value
      const remaining = Math.max(0, deadline - (yield* Clock.currentTimeMillis))
      const command =
        remaining === 0
          ? Effect.succeed(Option.none<OperationResult>())
          : restore(Effect.scoped(Effect.suspend(() => execute(workflow, operation)))).pipe(
              Effect.timeoutOption(remaining),
            )
      const exit = yield* Effect.exit(command)
      yield* applyWorkflowEvent(issueId, {
        _tag: 'Settled',
        operationId,
        generation,
        ...outcomeOf(operation, exit),
      })
      yield* exit
    }),
  )
