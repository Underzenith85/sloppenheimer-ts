import { Effect } from 'effect'

import type { PreparedRepository, SourceControlPort } from '../ports/source-control.js'
import type { RunJournal } from './durable/run-journal.js'

/** Runs after session and command finalizers, while the workspace lease still excludes writers. */
export const settleCancelledCandidate = (
  sourceControl: SourceControlPort,
  prepared: PreparedRepository,
  journal: RunJournal | undefined,
): Effect.Effect<void> =>
  journal === undefined
    ? Effect.void
    : sourceControl.inspect(prepared).pipe(
        Effect.matchEffect({
          onFailure: () => journal.stopped(false),
          onSuccess: (inspection) => journal.stopped(inspection._tag === 'Clean'),
        }),
      )
