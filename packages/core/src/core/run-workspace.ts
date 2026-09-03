import { Cause, Effect, Exit, Option, Queue, Ref } from 'effect'

import type { Issue } from '../domain/domain.js'
import type { AgentError, SourceControlError, WorkspaceError } from '../domain/errors.js'
import type { WorkspaceRelease } from '../domain/workspace-lease.js'
import { logInfo, logWarning } from '../support/logging.js'
import { logContext } from './policy.js'
import type { PostflightOutcome } from './postflight.js'
import { ownIssueFiber } from './runtime/execution.js'
import type { RuntimeCells } from './runtime/types.js'
import type { ExecutionSnapshot } from './state.js'

/**
 * What a pass needs of the host: the state it reads its protected workspaces from, the mailbox it
 * reports its count through, and the collection that owns it. Stated as what it uses so that both
 * the worker's own context and the runtime cells a cancellation holds can supply it.
 */
type PruneCells = Pick<RuntimeCells, 'state' | 'mailbox' | 'execution'>

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
 * Bounds what the issue keeps now that a run has let go of its workspace: the newest few retained
 * workspaces stay, and what the pass left is reported for the snapshot.
 *
 * Forked under the issue's `prune` key rather than run where it was asked for. A pass over an
 * issue's retained checkouts is filesystem work of no bounded size, so neither the event loop nor
 * the worker's own tail may wait on it — and the worker's key is armed again by the continuation a
 * second later, which would interrupt a pass that shared it. Two passes for one issue supersede,
 * which is what the key gives: the later one reads the same directory and enforces the same cap.
 *
 * What the run itself leased is protected by the run identity rather than by a key read out of the
 * lease: an ending that never reached the session — a provisioning hook that failed — still leaves
 * a retained directory, and only the manager can name it. Named here is every *other* workspace
 * this process still means to publish from, which is a retained delivery's. Nothing here can fail
 * anything: the run it follows has already ended.
 */
export const pruneRetainedWorkspaces = (
  cells: PruneCells,
  issue: Issue,
  execution: ExecutionSnapshot,
  runId: number,
): Effect.Effect<void> =>
  ownIssueFiber(cells.execution, 'prune', issue.id, prunePass(cells, issue, execution, runId))

/** The pass itself, as the fiber that key owns runs it. */
const prunePass = (
  cells: PruneCells,
  issue: Issue,
  execution: ExecutionSnapshot,
  runId: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(cells.state)
    const delivery = state.deliveries.get(issue.id)
    const report = yield* execution.workspaces.prune(
      { identifier: issue.identifier, runId },
      new Set(delivery === undefined ? [] : [delivery.prepared.workspace.key]),
    )
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
    yield* Queue.offer(cells.mailbox, {
      _tag: 'RetainedWorkspacesObserved',
      issueId: issue.id,
      identifier: issue.identifier,
      runId,
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
