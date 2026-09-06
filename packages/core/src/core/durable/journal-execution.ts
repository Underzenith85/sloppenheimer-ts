import { Effect, Option } from 'effect'
import type { Issue } from '../../domain/domain.js'
import type { SourceControlTarget } from '../../ports/source-control.js'
import type { OrchestratorContext } from '../runtime/types.js'
import type { ExecutionSnapshot } from '../state.js'
import type { RunJournal } from './run-journal.js'

export const journalExecution = (
  context: OrchestratorContext,
  issue: Issue,
  target: SourceControlTarget,
  execution: ExecutionSnapshot,
): Effect.Effect<Option.Option<ExecutionSnapshot & Readonly<{ journal: RunJournal }>>> =>
  Effect.gen(function* () {
    const journal = yield* context.durable.start(
      issue,
      target,
      Option.isNone(execution.codeReview) ? 'continuation' : 'review',
      execution.workflow.config.verification !== undefined,
      'intervene',
    )
    if (Option.isNone(journal)) {
      return Option.none()
    }
    return Option.some({ ...execution, journal: journal.value })
  })
