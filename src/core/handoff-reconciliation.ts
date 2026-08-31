import { Effect, Option, Ref, type Scope } from 'effect'

import type { IssueId } from '../domain/domain.js'
import { logInfo } from '../support/logging.js'
import { dispatch } from './dispatch.js'
import {
  afterInspectionFailed,
  afterMerge,
  afterRepairDispatched,
  afterReviewRequested,
  afterThreadsResolved,
  awaitingSlot,
  observeHandoff,
  repairIssue,
  type HandoffAction,
} from './handoff-decision.js'
import { hasSlot, identifierIssueNumber, logContext } from './policy.js'
import type { CompletedEntry } from './state.js'
import type { OrchestratorContext } from './runtime.js'
import type { EffectiveWorkflow, HandoffEntry, RuntimeState } from './state.js'
import * as Transitions from './transitions.js'

/** Whether this handoff is the orchestrator's to act on at all in this pass. */
const skipped = (state: RuntimeState, id: IssueId, handoff: HandoffEntry): boolean => {
  if (state.running.has(id) || state.retries.has(id)) {
    return true
  }
  if (handoff.state === 'closed_without_merge') {
    return true
  }
  return Option.exists(identifierIssueNumber(handoff.issue.identifier), (issueNumber) =>
    state.pausedIssueNumbers.has(issueNumber),
  )
}

/**
 * What a merged handoff leaves behind. The runtime already recorded that the issue completed; this
 * keeps the title, link and instant alongside it so the console can answer what Symphony finished
 * and when, instead of publishing a bare count.
 *
 * A reported merge time wins over the observation's own: dating a restored handoff now would put
 * finished work back into the console's recent-activity window.
 */
const finishedWork = (
  id: IssueId,
  handoff: HandoffEntry,
  mergedAt: string | null,
): CompletedEntry => {
  const reported = mergedAt === null ? null : new Date(mergedAt)
  return {
    issueId: id,
    identifier: handoff.issue.identifier,
    title: handoff.issue.title,
    url: handoff.issue.url,
    outcome: 'merged',
    finishedAt: reported === null || Number.isNaN(reported.getTime()) ? new Date() : reported,
    pullRequestUrl: handoff.pullRequestUrl,
  }
}

const writeHandoff = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry,
): Effect.Effect<void> =>
  Ref.update(context.state, (current) => Transitions.putHandoff(current, id, handoff))

/**
 * Carries out the one call an observation asked for and folds its result back into the handoff.
 * Every branch ends with the handoff written, so the state after a pass reflects what actually
 * happened rather than what was proposed.
 */
const perform = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry,
  action: HandoffAction,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const codeReview = handoff.execution.codeReview
    if (codeReview === null) {
      yield* writeHandoff(context, id, handoff)
      return
    }
    switch (action._tag) {
      case 'None': {
        yield* writeHandoff(context, id, handoff)
        return
      }
      case 'RequestReview': {
        const requested = yield* codeReview
          .requestPullRequestReview(handoff.pullRequestNumber, action.headSha)
          .pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => null }))
        yield* writeHandoff(context, id, afterReviewRequested(handoff, action.headSha, requested))
        if (requested === null) {
          yield* logInfo('Codex review requested for pull request head', {
            ...logContext(handoff.issue),
            action: 'pull_request_review_request',
            outcome: 'completed',
            error: null,
            pull_request_url: handoff.pullRequestUrl,
            head_sha: action.headSha,
          })
        }
        return
      }
      case 'ResolveThreads': {
        const resolved = yield* codeReview
          .resolveReviewThreads(action.threadIds)
          .pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => null }))
        yield* writeHandoff(context, id, afterThreadsResolved(handoff, resolved))
        return
      }
      case 'Complete': {
        yield* writeHandoff(context, id, handoff)
        yield* context.noteHandoffOutcome(id, handoff, 'merged')
        const finished = finishedWork(id, handoff, action.mergedAt)
        yield* Ref.update(context.state, (current) =>
          Transitions.completeHandoff(current, id, finished),
        )
        return
      }
      case 'NoteClosed': {
        yield* writeHandoff(context, id, handoff)
        yield* context.noteHandoffOutcome(id, handoff, 'intervention_required')
        return
      }
      case 'Merge': {
        yield* writeHandoff(context, id, handoff)
        const merged = yield* codeReview
          .mergePullRequest(handoff.pullRequestNumber, action.headSha)
          .pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: 'Failed' as const, error }),
              onSuccess: (sha) => ({ _tag: 'Succeeded' as const, sha }),
            }),
          )
        const settled = afterMerge(handoff, merged._tag === 'Failed' ? merged.error.message : null)
        yield* writeHandoff(context, id, settled)
        if (merged._tag === 'Failed') {
          return
        }
        yield* context.noteHandoffOutcome(id, settled, 'merged')
        // This host performed the merge just now, so the instant is its own.
        const finished = finishedWork(id, settled, null)
        yield* Ref.update(context.state, (current) =>
          Transitions.completeHandoff(current, id, finished),
        )
        yield* logInfo('pull request merged', {
          ...logContext(handoff.issue),
          action: 'pull_request_merge',
          outcome: 'completed',
          error: null,
          pull_request_url: handoff.pullRequestUrl,
          merge_commit_sha: merged.sha,
        })
        return
      }
      case 'Repair': {
        const issue = repairIssue(handoff, action.headSha, action.reason)
        const current = yield* Ref.get(context.state)
        if (!hasSlot(current, issue, handoff.execution.workflow)) {
          yield* writeHandoff(context, id, awaitingSlot(handoff, action.reason))
          return
        }
        yield* writeHandoff(context, id, handoff)
        const effective: EffectiveWorkflow = {
          workflow: handoff.execution.workflow,
          tracker: handoff.execution.tracker,
          codeReview,
          workspaces: handoff.execution.workspaces,
          loadedAt: handoff.observedAt,
        }
        const started = yield* dispatch(context, issue, action.attempt, effective)
        yield* writeHandoff(
          context,
          id,
          afterRepairDispatched(handoff, started, action.headSha, action.reason),
        )
        return
      }
    }
  })

export const reconcileHandoffs = (
  context: OrchestratorContext,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const opening = yield* Ref.get(context.state)
    for (const id of opening.handoffs.keys()) {
      // Re-read: an earlier handoff in this pass may have taken the last agent slot, or dispatched
      // a repair for this very issue.
      const current = yield* Ref.get(context.state)
      const live = current.handoffs.get(id)
      if (live === undefined || skipped(current, id, live)) {
        continue
      }
      const codeReview = live.execution.codeReview
      if (codeReview === null) {
        continue
      }
      const observedAt = new Date()
      const inspected = yield* codeReview.inspectPullRequest(live.pullRequestNumber).pipe(
        Effect.match({
          onFailure: (error) => ({ _tag: 'Failed' as const, error }),
          onSuccess: (observation) => ({ _tag: 'Succeeded' as const, observation }),
        }),
      )
      if (inspected._tag === 'Failed') {
        yield* writeHandoff(
          context,
          id,
          afterInspectionFailed(live, observedAt, inspected.error.message),
        )
        continue
      }
      const decision = observeHandoff(live, inspected.observation, observedAt)
      yield* perform(context, id, decision.handoff, decision.action)
    }
    // One timeline entry per observed transition, not one per poll: an unchanged disposition is
    // not news, and the timeline is a bounded resource.
    const closing = yield* Ref.get(context.state)
    for (const [id, handoff] of closing.handoffs) {
      if (closing.details.get(id)?.handoff.pullRequest.state !== handoff.state) {
        yield* context.noteHandoffOutcome(
          id,
          handoff,
          handoff.state === 'intervention_required' ? 'intervention_required' : 'pull_request_open',
        )
      }
    }
    yield* context.persistHandoffs
  })
