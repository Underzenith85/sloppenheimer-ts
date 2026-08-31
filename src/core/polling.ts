import { Deferred, Effect, Fiber, Queue, Ref, type Scope } from 'effect'

import { cyclicIssueIdentifiers } from '../domain/dependencies.js'
import type { Issue } from '../domain/domain.js'
import type { Workflow } from '../config/workflow.js'
import { logError, logInfo, logWarning } from '../support/logging.js'
import { recordAgentEvent, recordCancellation, recordHandoff } from '../telemetry.js'
import { dispatch } from './dispatch.js'
import { reconcileHandoffs } from './handoff-reconciliation.js'
import {
  dispatchAdmission,
  hasSlot,
  issueIsActive,
  issueIsRoutable,
  issuesForNumber,
  logContext,
  sessionLogContext,
  sortIssues,
  stateIsIn,
} from './policy.js'
import type { OrchestratorContext } from './runtime.js'
import * as Transitions from './transitions.js'
import {
  drainRetirements,
  installEffectiveWorkflow,
  revalidateCredentials,
} from './workflow-reload.js'

export const poll = (context: OrchestratorContext): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    // A worker that ended since the last pass may have been the last holder of a replaced instance.
    yield* drainRetirements(context)
    const opening = yield* Ref.get(context.state)
    const revalidated = yield* revalidateCredentials(context, opening.lastKnownGood).pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: 'Failed' as const, error }),
        onSuccess: (value) => ({ _tag: 'Succeeded' as const, value }),
      }),
    )
    if (revalidated._tag === 'Failed') {
      yield* logError('tracker credential validation failed; retaining last known good', {
        error: revalidated.error.message,
        effective_fingerprint: opening.lastKnownGood.workflow.fingerprint,
      })
    } else if (revalidated.value !== opening.lastKnownGood) {
      yield* installEffectiveWorkflow(context, opening.lastKnownGood, revalidated.value)
      yield* logInfo('tracker credential refreshed from the environment', {
        tracker_kind: revalidated.value.workflow.tracker.kind,
        secret_environment_names:
          revalidated.value.workflow.tracker.secretEnvironmentNames.join(', '),
      })
    }
    yield* context.hydrateRestoredHandoffs
    yield* context.recoverMissingHandoffs
    yield* reconcileHandoffs(context)
    yield* context.reconcile
    const reloading = yield* Ref.get(context.state)
    const reloaded = yield* context.ports.workflowLoader.load(context.selectedWorkflowPath).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.gen(function* () {
            const observedAt = new Date()
            yield* Ref.update(context.state, (current) =>
              Transitions.setWorkflowReloadError(current, { message: error.message, observedAt }),
            )
            yield* logError('workflow validation failed; retaining last known good', {
              error: error.message,
              effective_fingerprint: reloading.lastKnownGood.workflow.fingerprint,
            })
            return null
          }),
        onSuccess: (loaded) => Effect.succeed<Workflow | null>(loaded),
      }),
    )
    if (reloaded !== null) {
      yield* Ref.update(context.state, (current) =>
        Transitions.setWorkflowReloadError(current, null),
      )
      const before = yield* Ref.get(context.state)
      if (reloaded.fingerprint !== before.lastKnownGood.workflow.fingerprint) {
        const configured = yield* context.makeEffectiveWorkflow(reloaded).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: 'Failed' as const, error }),
            onSuccess: (value) => ({ _tag: 'Succeeded' as const, value }),
          }),
        )
        if (configured._tag === 'Failed') {
          const observedAt = new Date()
          yield* Ref.update(context.state, (current) =>
            Transitions.setWorkflowReloadError(current, {
              message: configured.error.message,
              observedAt,
            }),
          )
          yield* logError('workflow port configuration failed; retaining last known good', {
            error: configured.error.message,
            effective_fingerprint: before.lastKnownGood.workflow.fingerprint,
          })
        } else {
          yield* installEffectiveWorkflow(context, before.lastKnownGood, configured.value)
          yield* logInfo('workflow reloaded', {
            path: reloaded.path,
            fingerprint: reloaded.fingerprint,
          })
        }
      }
    }
    const dispatching = yield* Ref.get(context.state)
    const effective = dispatching.lastKnownGood
    const requiredLabels = effective.workflow.config.tracker.requiredLabels
    const candidates = yield* effective.tracker
      .fetchIssuesByStates(
        effective.workflow.config.tracker.activeStates,
        // No required labels means every candidate is in scope, so hydrate every candidate's
        // blockers. An empty list is reserved for callers that want no hydration at all.
        requiredLabels.length === 0 ? null : requiredLabels,
      )
      .pipe(
        Effect.catchAll((error) =>
          logError('candidate fetch failed', { error: error.message }).pipe(
            Effect.as<readonly Issue[]>([]),
          ),
        ),
      )
    const cyclicIdentifiers = cyclicIssueIdentifiers(candidates)
    for (const issue of sortIssues(candidates)) {
      // Read afresh: a dispatch earlier in this pass may have taken the slot this one wanted.
      const current = yield* Ref.get(context.state)
      if (
        dispatchAdmission(current, issue, effective.workflow, cyclicIdentifiers)._tag !== 'Admit'
      ) {
        continue
      }
      yield* dispatch(context, issue, null)
    }
  })

export const eventLoop = (context: OrchestratorContext): Effect.Effect<never, never, Scope.Scope> =>
  Effect.gen(function* () {
    for (;;) {
      const event = yield* Queue.take(context.mailbox)
      switch (event._tag) {
        case 'Tick': {
          yield* Ref.update(context.state, Transitions.beginPoll)
          yield* poll(context)
          const waiters = yield* Ref.modify(context.state, Transitions.takeRefreshWaiters)
          yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), {
            discard: true,
          })
          const finished = yield* Ref.modify(context.state, Transitions.finishPoll)
          if (finished.followUp) {
            yield* Ref.update(context.state, Transitions.promoteRefreshWaiters)
            yield* Queue.offer(context.mailbox, { _tag: 'Tick' })
            break
          }
          yield* context.scheduleNextTick
          break
        }
        case 'AgentUpdate': {
          const observed = yield* Ref.get(context.state)
          const entry = observed.running.get(event.issueId)
          if (entry !== undefined) {
            const applied = yield* context.applyLifecycleUpdate(entry, event.update)
            yield* Ref.update(context.state, (current) => {
              const settled = Transitions.dropPendingLifecycle(
                Transitions.updateRun(current, event.issueId, () =>
                  event.update.usage === null
                    ? applied
                    : {
                        ...applied,
                        lastReportedTokens: event.update.usage,
                        tokens: {
                          inputTokens: Math.max(
                            applied.tokens.inputTokens,
                            event.update.usage.inputTokens,
                          ),
                          outputTokens: Math.max(
                            applied.tokens.outputTokens,
                            event.update.usage.outputTokens,
                          ),
                          totalTokens: Math.max(
                            applied.tokens.totalTokens,
                            event.update.usage.totalTokens,
                          ),
                        },
                      },
                ),
                event.issueId,
                event.update,
              )
              if (event.update.rateLimits === null) {
                return settled
              }
              return Transitions.clearPendingRateLimits(
                Transitions.mergeRateLimits(settled, event.update.rateLimits),
                event.update.rateLimits,
              )
            })
            // Only a live run contributes to the timeline: output from a worker the orchestrator
            // has already ended belongs to no attempt.
            yield* Ref.update(context.state, (current) =>
              Transitions.updateDetail(current, event.issueId, (record) =>
                recordAgentEvent(record, event.update),
              ),
            )
          }
          break
        }
        case 'WorkerExited': {
          const entry = yield* Ref.modify(context.state, (current) =>
            Transitions.endRun(current, event.issueId, event.runId),
          )
          if (entry === null) {
            break
          }
          const settled = yield* Ref.modify(context.state, (current) =>
            Transitions.applyPendingTelemetry(current, event.issueId, entry),
          )
          yield* Ref.update(context.state, (current) =>
            Transitions.accountEndedRun(current, settled, Date.now()),
          )
          if (settled.sessionId !== null) {
            yield* (event.outcome === 'normal' ? logInfo : logError)(
              event.outcome === 'normal'
                ? 'action=session outcome=completed'
                : 'action=session outcome=failed',
              {
                ...sessionLogContext(settled),
                action: 'session',
                outcome: event.outcome === 'normal' ? 'completed' : 'failed',
                error: event.error,
              },
            )
          }
          if (event.outcome !== 'normal') {
            yield* context.scheduleRetry(
              settled.issue,
              (event.attempt ?? 0) + 1,
              event.error,
              false,
            )
            break
          }
          const codeReview = settled.execution.codeReview
          if (codeReview === null) {
            yield* context.scheduleRetry(settled.issue, 1, null, true)
            break
          }
          // Published before the tracker call, not after it: the worker is already out of the
          // running map, so an open detail panel would otherwise keep reading the previous
          // snapshot as running — and count it down to stalled — for as long as the handoff
          // request takes.
          const handingOffAt = new Date()
          yield* Ref.update(context.state, (current) =>
            Transitions.updateDetail(current, event.issueId, (record) =>
              recordHandoff(record, handingOffAt, {
                step: 'remote_branch',
                status: 'pending',
                message: 'Looking for a pushed branch to hand off',
              }),
            ),
          )
          yield* context.publish
          const handoff = yield* codeReview.handoffCompletedWork(settled.issue).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: 'Failed' as const, error }),
              onSuccess: (result) => ({ _tag: 'Succeeded' as const, result }),
            }),
          )
          if (handoff._tag === 'Failed') {
            const failedAt = new Date()
            yield* Ref.update(context.state, (current) =>
              Transitions.updateDetail(current, event.issueId, (record) =>
                recordHandoff(record, failedAt, {
                  step: 'remote_branch',
                  status: 'failed',
                  message: handoff.error.message,
                  outcome: 'failed',
                }),
              ),
            )
            yield* context.scheduleRetry(
              settled.issue,
              (event.attempt ?? 0) + 1,
              `handoff failed: ${handoff.error.message}`,
              false,
            )
            break
          }
          const result = handoff.result
          if (result._tag === 'NoBranch') {
            const absentAt = new Date()
            yield* Ref.update(context.state, (current) =>
              Transitions.updateDetail(current, event.issueId, (record) =>
                recordHandoff(record, absentAt, {
                  step: 'remote_branch',
                  status: 'absent',
                  message: `No remote branch ${result.branchName} exists yet; continuing the session`,
                  remoteBranch: result.branchName,
                  outcome: 'no_branch',
                }),
              ),
            )
            yield* context.scheduleRetry(settled.issue, 1, null, true)
            break
          }
          const observedAt = new Date()
          yield* Ref.update(context.state, (current) =>
            Transitions.updateDetail(current, event.issueId, (record) => {
              const branchObserved = recordHandoff(record, observedAt, {
                step: 'remote_branch',
                status: 'observed',
                message: `Remote branch ${result.branchName} is present`,
                remoteBranch: result.branchName,
              })
              const opened = recordHandoff(branchObserved, observedAt, {
                step: 'pull_request',
                status: 'observed',
                message: result.created
                  ? 'Opened a pull request for the completed work'
                  : 'Reused the pull request already open for this branch',
                pullRequest: {
                  status: result.created ? 'created' : 'reused',
                  number: result.pullRequestNumber,
                  url: result.pullRequestUrl,
                  state: 'awaiting_checks',
                },
                outcome: 'pull_request_open',
              })
              return recordHandoff(opened, observedAt, {
                step: 'dispatch_label',
                status: opened.handoff.dispatchLabels.status,
                message: opened.handoff.dispatchLabels.reason,
              })
            }),
          )
          const handedOffAt = new Date()
          yield* Ref.update(context.state, (current) => {
            // Carried over, not reset: the worker attempt number is not a repair count, and an
            // existing handoff already holds the heads that were actually observed.
            const existing = current.handoffs.get(event.issueId)
            return Transitions.putHandoff(current, event.issueId, {
              issue: existing?.issue ?? settled.issue,
              execution: settled.execution,
              pullRequestNumber: result.pullRequestNumber,
              pullRequestUrl: result.pullRequestUrl,
              branchName: result.branchName,
              state: 'awaiting_checks',
              headSha: existing?.headSha ?? null,
              reason: 'Awaiting the first protected-branch observation',
              repairHeadShas: existing?.repairHeadShas ?? [],
              repairObservedHeadShas: existing?.repairObservedHeadShas ?? [],
              repairStartedHeadSha: existing?.repairStartedHeadSha ?? null,
              repairBaselineRestored: existing?.repairBaselineRestored ?? false,
              reviewRequestedHeadSha: existing?.reviewRequestedHeadSha ?? null,
              reviewCompletedHeadSha: existing?.reviewCompletedHeadSha ?? null,
              observedAt: handedOffAt,
            })
          })
          yield* context.persistHandoffs
          yield* logInfo('worker handed off pull request', {
            ...logContext(settled.issue),
            action: 'pull_request_handoff',
            outcome: 'completed',
            error: null,
            branch: result.branchName,
            pull_request_url: result.pullRequestUrl,
          })
          break
        }
        case 'RetryDue': {
          const retry = yield* Ref.modify(context.state, (current) =>
            Transitions.takeDueRetry(current, event.issueId, event.attempt),
          )
          if (retry === null) {
            break
          }
          const current = yield* Ref.get(context.state)
          const effective = current.lastKnownGood
          const refreshResult = yield* effective.tracker.fetchIssuesByIds([event.issueId]).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: 'Failed' as const, error }),
              onSuccess: (issues) => ({ _tag: 'Succeeded' as const, issues }),
            }),
          )
          if (refreshResult._tag === 'Failed') {
            yield* context.scheduleRetry(
              retry.issue,
              event.attempt + 1,
              `retry refresh failed: ${refreshResult.error.message}`,
              false,
            )
            break
          }
          const issue = refreshResult.issues.find((candidate) => candidate.id === event.issueId)
          if (issue === undefined) {
            yield* Ref.update(context.state, (pending) =>
              Transitions.releaseClaim(pending, event.issueId),
            )
            break
          }
          if (stateIsIn(issue.state, effective.workflow.config.tracker.terminalStates)) {
            yield* effective.workspaces.remove(issue.identifier).pipe(
              Effect.catchAll((error) =>
                logWarning('terminal workspace cleanup failed', {
                  ...logContext(issue),
                  action: 'workspace_cleanup',
                  outcome: 'failed',
                  error: error.message,
                }),
              ),
            )
            yield* Ref.update(context.state, (pending) =>
              Transitions.releaseClaim(pending, event.issueId),
            )
            break
          }
          if (
            !issueIsActive(issue, effective.workflow) ||
            !issueIsRoutable(issue, effective.workflow)
          ) {
            yield* Ref.update(context.state, (pending) =>
              Transitions.releaseClaim(pending, event.issueId),
            )
            break
          }
          if (!hasSlot(current, issue, effective.workflow)) {
            yield* context.scheduleRetry(
              issue,
              event.attempt + 1,
              'no available orchestrator slots',
              false,
            )
            break
          }
          // A worker retry is a continuation, not a repair, so it establishes no repair baseline.
          // Repairs are baselined only where they are dispatched as repairs, in reconciliation,
          // from a head observed in the same pass.
          yield* dispatch(context, issue, event.attempt)
          break
        }
        case 'SetIssuePaused': {
          if (event.paused) {
            yield* Ref.update(context.state, (current) =>
              Transitions.pauseIssueNumber(current, event.issueNumber),
            )
            const paused = yield* Ref.get(context.state)
            for (const id of issuesForNumber(paused.running, event.issueNumber)) {
              yield* context.cancelRunning(id, false, 'the operator paused the issue')
            }
            const retrying = yield* Ref.get(context.state)
            for (const id of issuesForNumber(retrying.retries, event.issueNumber)) {
              const retry = yield* Ref.modify(context.state, (current) =>
                Transitions.takeRetry(current, id),
              )
              if (retry === null) {
                continue
              }
              yield* Fiber.interrupt(retry.fiber)
              // Dropping the queued retry ends the agent, so its detail has to say so: without
              // this the record would publish as completed while still claiming to be waiting
              // to retry, and the retry it pointed at would never arrive.
              const cancelledAt = new Date()
              yield* Ref.update(context.state, (current) =>
                Transitions.updateDetail(Transitions.releaseClaim(current, id), id, (record) =>
                  recordCancellation(record, cancelledAt, 'the operator paused the issue', true),
                ),
              )
            }
          } else {
            yield* Ref.update(context.state, (current) =>
              Transitions.resumeIssueNumber(current, event.issueNumber),
            )
          }
          yield* Deferred.succeed(event.reply, undefined)
          break
        }
      }
      // Every transition of runtime state is followed by exactly one publication, so a consumer
      // never sees an index that disagrees with the scheduler it was derived from.
      yield* context.publish
    }
  })
