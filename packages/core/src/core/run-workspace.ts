import { Cause, Effect, Exit, Option, Queue, Ref } from 'effect'

import type { Issue } from '../domain/domain.js'
import type { AgentError, SourceControlError, WorkspaceError } from '../domain/errors.js'
import type { WorkspaceRelease } from '../domain/workspace-lease.js'
import { logInfo, logWarning } from '../support/logging.js'
import { logContext } from './policy.js'
import type { PostflightOutcome } from './postflight.js'
import type { OrchestratorContext } from './runtime.js'
import type { ExecutionSnapshot } from './state.js'

/**
 * What becomes of a run's workspace once the run has ended, and of the older ones beside it.
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

/**
 * Bounds what the issue keeps once this run has let go of its workspace: the newest few retained
 * workspaces stay, and what the pass left is reported for the snapshot.
 *
 * It runs on the worker's own fiber, after the exit has been offered, because a pass over an
 * issue's retained checkouts is filesystem work of no bounded size and the loop must not wait on
 * it; and it reports through the mailbox, because the count it settles is the state's to write.
 * Protected from eviction is every workspace something in this process still means to publish
 * from — a retained delivery's — and the one this run has just released, which the exit being
 * handled may be turning into one. Nothing here can fail the run: it already ended.
 */
export const pruneRetainedWorkspaces = (
  context: OrchestratorContext,
  issue: Issue,
  execution: ExecutionSnapshot,
  released: Option.Option<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(context.state)
    const delivery = state.deliveries.get(issue.id)
    const protectedKeys = new Set<string>([
      ...(delivery === undefined ? [] : [delivery.prepared.workspace.key]),
      ...Option.toArray(released),
    ])
    const report = yield* execution.workspaces.prune(issue.identifier, protectedKeys)
    if (report.evicted > 0) {
      yield* logInfo('action=workspace_prune outcome=evicted', {
        ...logContext(issue),
        action: 'workspace_prune',
        outcome: 'evicted',
        evicted: report.evicted,
        retained: report.count,
        bytes: report.bytes,
      })
    }
    yield* Queue.offer(context.mailbox, {
      _tag: 'RetainedWorkspacesObserved',
      issueId: issue.id,
      identifier: issue.identifier,
      count: report.count,
      bytes: report.bytes,
    })
  }).pipe(
    Effect.catchAll((error) =>
      logWarning('action=workspace_prune outcome=failed', {
        ...logContext(issue),
        action: 'workspace_prune',
        outcome: 'failed',
        error: error.message,
      }),
    ),
  )
