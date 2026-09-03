import { Cause, Exit, Option } from 'effect'

import type { AgentError, SourceControlError, WorkspaceError } from '../domain/errors.js'
import type { WorkspaceRelease } from '../domain/workspace-lease.js'
import type { PostflightOutcome } from './postflight.js'

/**
 * What becomes of the run's workspace once the run has ended.
 *
 * A postflight that published, or that found nothing to publish, has read the whole worktree and
 * put everything it found into the repository, so the directory holds nothing that is not in it.
 * Every other ending — a delivery that failed, a composition with no source control to publish
 * through, a failure, a cancellation, an interrupted shutdown — leaves work that only the directory
 * holds, so the workspace stays as a recovery artifact under the reason it is being kept for. A
 * retained delivery republishes from exactly that directory, which is why a failed delivery's
 * reason names the failure.
 */
export const workspaceRelease = (
  exit: Exit.Exit<PostflightOutcome, AgentError | WorkspaceError | SourceControlError>,
): WorkspaceRelease =>
  Exit.match(exit, {
    onSuccess: (postflight): WorkspaceRelease => {
      switch (postflight._tag) {
        case 'Published':
        case 'NoChanges':
          return { _tag: 'Completed' }
        case 'DeliveryFailed':
          // The category, never the message: a lease record is a file on disk rather than a log
          // the redaction rules pass over.
          return { _tag: 'Retained', reason: `delivery failed: ${postflight.failure.category}` }
        case 'NotPerformed':
          return { _tag: 'Retained', reason: 'run ended without publishing its work' }
      }
    },
    onFailure: (cause): WorkspaceRelease => ({
      _tag: 'Retained',
      reason: Option.match(Cause.failureOption(cause), {
        onNone: () =>
          Cause.isInterrupted(cause)
            ? 'run cancelled before publication'
            : 'run ended abnormally before publication',
        // What failed, never what the failure said: an agent or hook failure carries an excerpt of
        // what the process wrote, and a lease record is a file on disk rather than a log the
        // redaction rules pass over.
        onSome: (error) => `run failed before publication: ${error._tag} ${error.category}`,
      }),
    }),
  })
