import { Effect, type Scope } from 'effect'

import type { Issue } from '../domain/domain.js'
import { classifyPullRequest } from '../domain/handoff.js'
import { logInfo } from '../support/logging.js'
import { dispatch } from './dispatch.js'
import type { EffectiveWorkflow, OrchestratorContext } from './runtime.js'

export const hydrateRestoredHandoffs = (context: OrchestratorContext): Effect.Effect<void> =>
  context.hydrateRestoredHandoffsEffect()

export const reconcileHandoffs = (
  context: OrchestratorContext,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    for (const [id, handoff] of context.state.handoffs) {
      if (context.state.running.has(id) || context.state.retries.has(id)) {
        continue
      }
      if (handoff.state === 'closed_without_merge') {
        continue
      }
      const interventionRequired = handoff.state === 'intervention_required'
      const handoffIssueNumber = context.identifierIssueNumberValue(handoff.issue.identifier)
      if (handoffIssueNumber !== null && context.state.pausedIssueNumbers.has(handoffIssueNumber)) {
        continue
      }
      const codeReview = handoff.execution.codeReview
      if (codeReview === null) {
        continue
      }
      const inspected = yield* codeReview.inspectPullRequest(handoff.pullRequestNumber).pipe(
        Effect.match({
          onFailure: (error) => ({ _tag: 'Failed' as const, error }),
          onSuccess: (observation) => ({ _tag: 'Succeeded' as const, observation }),
        }),
      )
      handoff.observedAt = new Date()
      if (inspected._tag === 'Failed') {
        handoff.reason = inspected.error.message
        continue
      }
      // Intervention was requested, so no further repair is dispatched -- but the pull request is
      // still inspected every poll. An unchanged open head keeps the state and reason as they are;
      // a corrected head, a manual merge, or a close falls through and is acted on normally.
      if (
        interventionRequired &&
        inspected.observation.state === 'open' &&
        inspected.observation.headSha === handoff.headSha
      ) {
        continue
      }
      // A repair agent has finished: attribute the head it produced before anything else reads it.
      if (inspected.observation.state === 'open' && handoff.repairStartedHeadSha !== null) {
        const repairedHeadSha = inspected.observation.headSha
        if (repairedHeadSha !== handoff.repairStartedHeadSha) {
          if (handoff.repairObservedHeadShas.includes(repairedHeadSha)) {
            handoff.repairStartedHeadSha = null
            handoff.repairBaselineRestored = false
            handoff.state = 'intervention_required'
            handoff.headSha = repairedHeadSha
            handoff.reason =
              'Repair agent returned the pull request to an already observed repair head.'
            continue
          }
          handoff.repairHeadShas.push(repairedHeadSha)
          handoff.repairObservedHeadShas.push(repairedHeadSha)
          handoff.repairStartedHeadSha = null
          handoff.repairBaselineRestored = false
        } else if (handoff.repairBaselineRestored) {
          // The baseline outlived the process that dispatched the repair, so an unchanged head is
          // an interrupted repair, not a completed no-op. Drop the baseline and let the normal
          // repair path retry; no head was observed, so the budget is untouched.
          handoff.repairStartedHeadSha = null
          handoff.repairBaselineRestored = false
        } else {
          const unchangedDisposition = classifyPullRequest(inspected.observation)
          handoff.repairStartedHeadSha = null
          if (unchangedDisposition.state === 'repair_needed') {
            handoff.state = 'intervention_required'
            handoff.headSha = repairedHeadSha
            handoff.reason = `Repair agent completed without changing the pull request head. ${unchangedDisposition.reason}`
            continue
          }
        }
      }
      if (inspected.observation.state === 'open') {
        const observedHeadSha = inspected.observation.headSha
        const codexReview = inspected.observation.codexReview
        if (handoff.reviewRequestedHeadSha !== observedHeadSha) {
          handoff.reviewCompletedHeadSha = null
          // Adoption keys off the reviewed commit itself, so a review of some other commit whose
          // abbreviation happens to match cannot pass for a review of this head.
          if (
            codexReview !== null &&
            codexReview !== undefined &&
            codexReview.reviewedHeadSha === observedHeadSha
          ) {
            handoff.reviewRequestedHeadSha = observedHeadSha
            handoff.state = 'awaiting_checks'
            if (codexReview.status === 'completed') {
              handoff.reviewCompletedHeadSha = observedHeadSha
              handoff.reason =
                'Codex review completed for the current head; waiting for review state to settle'
            } else {
              handoff.reason = 'Waiting for Codex review of the current head to complete'
            }
            continue
          }
          const requested = yield* codeReview
            .requestPullRequestReview(handoff.pullRequestNumber, observedHeadSha)
            .pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: 'Failed' as const, error }),
                onSuccess: () => ({ _tag: 'Succeeded' as const }),
              }),
            )
          handoff.state = 'awaiting_checks'
          if (requested._tag === 'Failed') {
            handoff.reason = `Could not request Codex review for the current head: ${requested.error.message}`
            continue
          }
          handoff.reviewRequestedHeadSha = observedHeadSha
          handoff.reason = 'Codex review requested for the current head'
          yield* logInfo('Codex review requested for pull request head', {
            ...context.logContextValue(handoff.issue),
            action: 'pull_request_review_request',
            outcome: 'completed',
            error: null,
            pull_request_url: handoff.pullRequestUrl,
            head_sha: observedHeadSha,
          })
          continue
        }
        if (
          codexReview?.status !== 'completed' ||
          codexReview.reviewedHeadSha !== observedHeadSha
        ) {
          handoff.reviewCompletedHeadSha = null
          handoff.state = 'awaiting_checks'
          handoff.reason = 'Waiting for Codex review of the current head to complete'
          continue
        }
        if (handoff.reviewCompletedHeadSha !== observedHeadSha) {
          handoff.reviewCompletedHeadSha = observedHeadSha
          handoff.state = 'awaiting_checks'
          handoff.reason =
            'Codex review completed for the current head; waiting for review state to settle'
          continue
        }
      }
      const unresolvedThreadIds = inspected.observation.reviewThreads
        .filter(
          (thread) => !thread.resolved && thread.commentHeadSha !== inspected.observation.headSha,
        )
        .map((thread) => thread.id)
      const repairedHeadIsVerified =
        handoff.repairHeadShas.length > 0 &&
        inspected.observation.mergeable === true &&
        inspected.observation.mergeState !== 'dirty' &&
        inspected.observation.mergeState !== 'behind' &&
        inspected.observation.checks.every(
          (check) =>
            check.status === 'completed' &&
            check.conclusion !== null &&
            ['success', 'neutral', 'skipped'].includes(check.conclusion),
        )
      if (unresolvedThreadIds.length > 0 && repairedHeadIsVerified) {
        const resolved = yield* codeReview.resolveReviewThreads(unresolvedThreadIds).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: 'Failed' as const, error }),
            onSuccess: () => ({ _tag: 'Succeeded' as const }),
          }),
        )
        handoff.state = 'awaiting_checks'
        handoff.reason =
          resolved._tag === 'Failed'
            ? resolved.error.message
            : 'Verified repair head; waiting for resolved review state'
        continue
      }
      const disposition = classifyPullRequest(inspected.observation)
      handoff.state = disposition.state
      handoff.headSha = inspected.observation.headSha
      handoff.reason = 'reason' in disposition ? disposition.reason : null
      if (disposition.state === 'merged') {
        context.noteHandoffOutcomeValue(id, handoff, 'merged')
        context.state.handoffs.delete(id)
        context.state.completed.add(id)
        context.state.claimed.delete(id)
        continue
      }
      if (disposition.state === 'closed_without_merge') {
        context.noteHandoffOutcomeValue(id, handoff, 'intervention_required')
        continue
      }
      if (disposition.state === 'ready_to_merge') {
        handoff.state = 'merging'
        const merged = yield* codeReview
          .mergePullRequest(handoff.pullRequestNumber, disposition.headSha)
          .pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: 'Failed' as const, error }),
              onSuccess: (sha) => ({ _tag: 'Succeeded' as const, sha }),
            }),
          )
        if (merged._tag === 'Failed') {
          handoff.state = 'awaiting_checks'
          handoff.reason = merged.error.message
          continue
        }
        handoff.state = 'merged'
        context.noteHandoffOutcomeValue(id, handoff, 'merged')
        context.state.handoffs.delete(id)
        context.state.completed.add(id)
        context.state.claimed.delete(id)
        yield* logInfo('pull request merged', {
          ...context.logContextValue(handoff.issue),
          action: 'pull_request_merge',
          outcome: 'completed',
          error: null,
          pull_request_url: handoff.pullRequestUrl,
          merge_commit_sha: merged.sha,
        })
        continue
      }
      if (disposition.state === 'repair_needed') {
        if (handoff.repairHeadShas.length >= 3) {
          handoff.state = 'intervention_required'
          handoff.reason = `Repair limit reached. ${disposition.reason}`
          continue
        }
        const repairIssue: Issue = {
          ...handoff.issue,
          description: `${handoff.issue.description ?? ''}\n\n## Pull request repair\n\nPR: ${handoff.pullRequestUrl}\nHead: ${inspected.observation.headSha}\n\n${disposition.reason}`,
        }
        if (!context.stateHasSlotValue(repairIssue, context.state, handoff.execution.workflow)) {
          handoff.reason = `Waiting for an agent slot. ${disposition.reason}`
          continue
        }
        const effective: EffectiveWorkflow = {
          workflow: handoff.execution.workflow,
          tracker: handoff.execution.tracker,
          codeReview,
          workspaces: handoff.execution.workspaces,
          loadedAt: handoff.observedAt,
        }
        // The budget is spent by an observed head, not by dispatching: record the baseline only
        // once a session really started, so a refused dispatch costs nothing.
        const started = yield* dispatch(
          context,
          repairIssue,
          handoff.repairHeadShas.length + 1,
          effective,
        )
        if (started) {
          const baselineHeadSha = inspected.observation.headSha
          handoff.repairStartedHeadSha = baselineHeadSha
          if (
            baselineHeadSha !== null &&
            !handoff.repairObservedHeadShas.includes(baselineHeadSha)
          ) {
            handoff.repairObservedHeadShas.push(baselineHeadSha)
          }
          handoff.repairBaselineRestored = false
          handoff.reason = `Repair agent running. ${disposition.reason}`
        }
      }
    }
    // One timeline entry per observed transition, not one per poll: an unchanged disposition is
    // not news, and the timeline is a bounded resource.
    for (const [id, handoff] of context.state.handoffs) {
      if (context.state.details.get(id)?.handoff.pullRequest.state !== handoff.state) {
        context.noteHandoffOutcomeValue(
          id,
          handoff,
          handoff.state === 'intervention_required' ? 'intervention_required' : 'pull_request_open',
        )
      }
    }
    yield* context.persistHandoffsEffect()
  })
