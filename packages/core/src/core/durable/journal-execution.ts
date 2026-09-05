import { Effect, Option, Ref } from 'effect'
import type { Issue } from '../../domain/domain.js'
import type { SourceControlTarget } from '../../ports/source-control.js'
import type { OrchestratorContext } from '../runtime/types.js'
import type { ExecutionSnapshot } from '../state.js'
import * as Transitions from '../transitions.js'

export const journalExecution = (
  context: OrchestratorContext,
  issue: Issue,
  target: SourceControlTarget,
  execution: ExecutionSnapshot,
): Effect.Effect<Option.Option<ExecutionSnapshot>> =>
  Effect.gen(function* () {
    if (context.durable === undefined) {
      return Option.some(execution)
    }
    const journal = yield* context.durable.start(
      issue,
      target,
      Option.isNone(execution.codeReview) ? 'continuation' : 'review',
    )
    if (Option.isNone(journal)) {
      yield* Ref.update(context.state, (current) => Transitions.releaseClaim(current, issue.id))
      return Option.none()
    }
    return Option.some({ ...execution, journal: journal.value })
  })
