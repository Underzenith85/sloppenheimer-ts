import { Effect, Option, Queue, Ref } from 'effect'

import type { IssueId } from '../../domain/domain.js'
import { logInfo, logWarning } from '../../support/logging.js'
import type { SourceControlPort } from '../../ports/index.js'
import type { HandoffAction } from '../handoff-decision.js'
import { logContext } from '../policy.js'
import { rebaseInFlight, rebaseSettled, rebaseStarted, type RebaseOutcome } from '../rebase.js'
import { ownIssueFiber } from '../runtime/execution.js'
import type { OrchestratorContext, OrchestratorEvent } from '../runtime.js'
import type { HandoffEntry } from '../state.js'
import * as Transitions from '../transitions.js'
import { writeHandoff } from './repair-identity.js'

type RebaseAttempted = Extract<OrchestratorEvent, { _tag: 'RebaseAttempted' }>
type RebaseAction = Extract<HandoffAction, { _tag: 'Rebase' }>

/**
 * The host rebasing a pull request that fell behind the protected base, with no agent.
 *
 * The branch used to go back to a repair agent for this, and the agent had nothing to change: its
 * clean worktree was read as a repair that achieved nothing, and the pull request ended in
 * intervention for a state the host already knew how to fix. The rebase is what the publication
 * of a repair would have done anyway -- prepare from the exact pull-request head, put it on the
 * base, push under the expected-head lease -- performed here as a host action, spending no repair
 * budget and no agent slot ([#274](https://github.com/Underzenith85/sloppenheimer-ts/issues/274)).
 *
 * Like a delivery's publication it is git, and runs off the event loop: a fetch or a push waits on
 * a child process that may never close, and the loop is the only thing that can process the tick,
 * the worker exit or the operator pause that would otherwise be held behind it. What the attempt
 * did comes back as an event, because the state it settles is the loop's to write.
 */

/**
 * The attempt itself, inside a workspace leased for it alone. The preparation is the repair's:
 * the exact pull-request head, under the lease that refuses if the branch has moved since it was
 * observed.
 *
 * The workspace is released as completed whatever happened. Nothing in it is anyone's work -- it
 * holds the branch as the remote had it, and a rebase that failed left an aborted rebase behind --
 * so retaining it would keep one directory per attempt for nothing a later run could adopt.
 */
const runRebaseAttempt = (
  handoff: HandoffEntry,
  sourceControl: SourceControlPort,
  runId: number,
  headSha: string,
): Effect.Effect<RebaseOutcome> =>
  handoff.execution.workspaces
    .withLeasedWorkspace(
      { identifier: handoff.issue.identifier, runId },
      (workspace) =>
        sourceControl
          .prepare(handoff.issue, workspace, {
            _tag: 'Repair',
            branchName: handoff.branchName,
            expectedHeadSha: headSha,
          })
          .pipe(Effect.flatMap((prepared) => sourceControl.rebase(handoff.issue, prepared))),
      () => ({ _tag: 'Completed' }),
    )
    .pipe(
      Effect.match({
        onFailure: (error): RebaseOutcome =>
          error._tag === 'SourceControlError' && error.category === 'rebase_conflict'
            ? { _tag: 'Conflicted', message: error.message }
            : { _tag: 'Failed', message: error.message },
        onSuccess: (published): RebaseOutcome =>
          published._tag === 'Published'
            ? { _tag: 'Published', headSha: published.headSha }
            : { _tag: 'NoChanges' },
      }),
    )

/**
 * Starts the rebase an observation asked for. The handoff carries the attempt from here, which is
 * what keeps the next pass from observing the head the rebase is replacing and what keeps the
 * issue's claim from being released under it; the attempt reports back as `RebaseAttempted`.
 *
 * Staged rather than persisted, like every other write a reconciliation pass makes: the pass
 * flushes the store once at its end, and the identity is not persisted in any case.
 */
export const performRebase = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry,
  action: RebaseAction,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sourceControl = handoff.execution.sourceControl
    if (sourceControl === null) {
      // Unreachable by composition -- a handoff exists only where the host owns source control --
      // but the snapshot admits it, and nothing here could move the branch.
      yield* Ref.update(context.state, (current) =>
        Transitions.putHandoff(current, id, {
          ...handoff,
          reason: `The host composes no source control to rebase with. ${action.reason}`,
        }),
      )
      return
    }
    yield* Ref.update(context.state, (current) =>
      Transitions.putHandoff(current, id, rebaseStarted(handoff, action.headSha)),
    )
    const runId = yield* Ref.modify(context.state, Transitions.takeRunId)
    yield* logInfo('action=pull_request_rebase outcome=started', {
      ...logContext(handoff.issue),
      action: 'pull_request_rebase',
      outcome: 'started',
      pull_request_url: handoff.pullRequestUrl,
      head_sha: action.headSha,
      run_id: runId,
    })
    yield* ownIssueFiber(
      context.execution,
      'rebase',
      id,
      Effect.flatMap(runRebaseAttempt(handoff, sourceControl, runId, action.headSha), (outcome) =>
        Queue.offer(context.mailbox, {
          _tag: 'RebaseAttempted' as const,
          issueId: id,
          headSha: action.headSha,
          outcome,
        }),
      ).pipe(Effect.asVoid),
    )
  })

/**
 * What the loop owes the attempt that has reported back: the handoff, settled and persisted.
 *
 * A settlement is applied only while the handoff is still waiting on this attempt. One for a pull
 * request that has since merged or closed finds no handoff to settle, and one the handoff is not
 * waiting on -- started from a head it has already moved past -- settles nothing, which is what
 * makes an attempt that outlived its handoff harmless.
 */
export const onRebaseAttempted = (
  context: OrchestratorContext,
  event: RebaseAttempted,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(context.state)
    const handoff = current.handoffs.get(event.issueId)
    if (
      handoff === undefined ||
      !rebaseInFlight(handoff) ||
      !Option.exists(handoff.rebase, (rebase) => rebase.headSha === event.headSha)
    ) {
      return
    }
    const settled = rebaseSettled(handoff, event.outcome)
    yield* writeHandoff(context, event.issueId, settled)
    if (settled.state !== handoff.state) {
      yield* context.noteHandoffOutcome(
        event.issueId,
        settled,
        settled.state === 'intervention_required' ? 'intervention_required' : 'pull_request_open',
      )
    }
    const outcome = event.outcome
    const succeeded = outcome._tag === 'Published' || outcome._tag === 'NoChanges'
    yield* (succeeded ? logInfo : logWarning)(
      `action=pull_request_rebase outcome=${succeeded ? 'settled' : 'failed'}`,
      {
        ...logContext(handoff.issue),
        action: 'pull_request_rebase',
        outcome: succeeded ? 'settled' : 'failed',
        pull_request_url: handoff.pullRequestUrl,
        head_sha: event.headSha,
        published_head_sha: outcome._tag === 'Published' ? outcome.headSha : null,
        error: succeeded ? null : outcome.message,
      },
    )
  })
