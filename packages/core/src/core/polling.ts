import { Clock, Deferred, Effect, Fiber, Option, Queue, Ref, type Scope } from 'effect'

import type { Issue, IssueId } from '../domain/domain.js'
import type { Workflow } from '../config/workflow.js'
import { currentInstant } from '../support/clock.js'
import { logError, logInfo, logWarning } from '../support/logging.js'
import { asSettled } from '../support/settled.js'
import { recordAgentEvent, recordCancellation, recordHandoff } from '../telemetry.js'
import { dispatch } from './dispatch.js'
import { releaseRepair, settleRepair } from './handoff-decision.js'
import {
  applyHandoffObservation,
  reconcileHandoffs,
  repairPermission,
} from './handoff-reconciliation.js'
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
import type { HandoffEntry, RefreshOperation } from './state.js'
import * as Transitions from './transitions.js'
import {
  drainRetirements,
  installEffectiveWorkflow,
  revalidateCredentials,
} from './workflow-reload.js'

/**
 * One handoff write, persisted as it is made.
 *
 * The repair-identity changes in this module stand alone rather than arriving as a batch, so each
 * is durable before the next thing happens — unlike `stageHandoff` in `handoff-reconciliation.ts`,
 * where a whole pass is flushed once at its end.
 */
const writeHandoff = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry,
): Effect.Effect<void> =>
  Ref.update(context.state, (current) => Transitions.putHandoff(current, id, handoff)).pipe(
    Effect.zipRight(context.persistHandoffs),
  )

/** Ends a repair: whatever identity it was carrying goes with it. */
const releaseHandoffRepair = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: Option.Option<HandoffEntry>,
): Effect.Effect<void> =>
  Option.match(handoff, {
    onNone: () => Effect.void,
    onSome: (entry) =>
      Option.isNone(entry.repair) ? Effect.void : writeHandoff(context, id, releaseRepair(entry)),
  })

/**
 * One reconciliation pass, answering with the stages it reached. A caller that asked for this pass
 * — a refresh over the HTTP API — is told what it actually got: a pass whose validation failed
 * stops before dispatch, and saying otherwise would be reporting an intention rather than an event.
 */
export const poll = (
  context: OrchestratorContext,
): Effect.Effect<readonly RefreshOperation[], never, Scope.Scope> =>
  Effect.gen(function* () {
    const performed: RefreshOperation[] = []
    // A worker that ended since the last pass may have been the last holder of a replaced instance.
    yield* drainRetirements(context)
    let dispatchValidationFailed = false
    const opening = yield* Ref.get(context.state)
    const revalidated = yield* revalidateCredentials(context, opening.lastKnownGood).pipe(asSettled)
    if (revalidated._tag === 'Failed') {
      dispatchValidationFailed = true
      const observedAt = yield* currentInstant
      yield* Ref.update(context.state, (current) =>
        Transitions.setWorkflowReloadError(current, {
          message: revalidated.error.message,
          observedAt,
        }),
      )
      yield* logError('tracker credential validation failed; retaining last known good', {
        action: 'workflow_validation',
        outcome: 'failed',
        stage: 'credential_revalidation',
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
    performed.push('credential_revalidation')
    yield* context.hydrateRestoredHandoffs
    yield* context.recoverMissingHandoffs
    performed.push('handoff_recovery')
    const reloading = yield* Ref.get(context.state)
    const reloaded = yield* context.ports.workflowLoader.load(context.selectedWorkflowPath).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.gen(function* () {
            dispatchValidationFailed = true
            const observedAt = yield* currentInstant
            yield* Ref.update(context.state, (current) =>
              Transitions.setWorkflowReloadError(current, { message: error.message, observedAt }),
            )
            yield* logError('workflow validation failed; retaining last known good', {
              action: 'workflow_validation',
              outcome: 'failed',
              stage: 'reload',
              error: error.message,
              effective_fingerprint: reloading.lastKnownGood.workflow.fingerprint,
            })
            return null
          }),
        onSuccess: (loaded) => Effect.succeed<Workflow | null>(loaded),
      }),
    )
    if (reloaded !== null) {
      const before = yield* Ref.get(context.state)
      if (reloaded.fingerprint !== before.lastKnownGood.workflow.fingerprint) {
        const configured = yield* context.makeEffectiveWorkflow(reloaded).pipe(asSettled)
        if (configured._tag === 'Failed') {
          dispatchValidationFailed = true
          const observedAt = yield* currentInstant
          yield* Ref.update(context.state, (current) =>
            Transitions.setWorkflowReloadError(current, {
              message: configured.error.message,
              observedAt,
            }),
          )
          yield* logError('workflow port configuration failed; retaining last known good', {
            action: 'workflow_validation',
            outcome: 'failed',
            stage: 'port_configuration',
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
    performed.push('workflow_reload')
    yield* reconcileHandoffs(context, !dispatchValidationFailed)
    performed.push('handoff_reconciliation')
    yield* context.reconcile(!dispatchValidationFailed)
    performed.push('issue_reconciliation')
    if (dispatchValidationFailed) {
      return performed
    }
    yield* Ref.update(context.state, (current) => Transitions.setWorkflowReloadError(current, null))
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
    for (const issue of sortIssues(candidates)) {
      // Read afresh: a dispatch earlier in this pass may have taken the slot this one wanted.
      const current = yield* Ref.get(context.state)
      if (dispatchAdmission(current, issue, effective.workflow)._tag !== 'Admit') {
        continue
      }
      yield* dispatch(context, issue, null)
    }
    performed.push('dispatch')
    return performed
  })

export const eventLoop = (context: OrchestratorContext): Effect.Effect<never, never, Scope.Scope> =>
  Effect.gen(function* () {
    for (;;) {
      const event = yield* Queue.take(context.mailbox)
      switch (event._tag) {
        case 'Tick': {
          yield* Ref.update(context.state, Transitions.beginPoll)
          const performed = yield* poll(context)
          const waiters = yield* Ref.modify(context.state, Transitions.takeRefreshWaiters)
          yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, performed), {
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
          const ended = yield* Ref.modify(context.state, (current) =>
            Transitions.endRun(current, event.issueId, event.runId),
          )
          if (Option.isNone(ended)) {
            break
          }
          const settled = yield* Ref.modify(context.state, (current) =>
            Transitions.applyPendingTelemetry(current, event.issueId, ended.value),
          )
          const endedAt = yield* Clock.currentTimeMillis
          yield* Ref.update(context.state, (current) =>
            Transitions.accountEndedRun(current, settled, endedAt),
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
              settled.repairRun,
            )
            break
          }
          const codeReview = settled.execution.codeReview
          if (Option.isNone(codeReview)) {
            yield* context.scheduleRetry(settled.issue, 1, null, true, settled.repairRun)
            break
          }
          // Published before the tracker call, not after it: the worker is already out of the
          // running map, so an open detail panel would otherwise keep reading the previous
          // snapshot as running — and count it down to stalled — for as long as the handoff
          // request takes.
          const handingOffAt = yield* currentInstant
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
          const handoff = yield* codeReview.value
            .handoffCompletedWork(settled.issue)
            .pipe(asSettled)
          if (handoff._tag === 'Failed') {
            const failedAt = yield* currentInstant
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
              settled.repairRun,
            )
            break
          }
          const result = handoff.value
          if (result._tag === 'NoBranch') {
            const absentAt = yield* currentInstant
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
            yield* context.scheduleRetry(settled.issue, 1, null, true, settled.repairRun)
            break
          }
          const observedAt = yield* currentInstant
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
          const handedOffAt = yield* currentInstant
          const completedRepair = yield* Ref.modify(context.state, (current) => {
            // Carried over, not reset: the worker attempt number is not a repair count, and an
            // existing handoff already holds the heads that were actually observed.
            const existing = current.handoffs.get(event.issueId)
            const next = Transitions.putHandoff(current, event.issueId, {
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
              repair: existing === undefined ? Option.none() : existing.repair,
              reviewRequestedHeadSha: existing?.reviewRequestedHeadSha ?? null,
              reviewCompletedHeadSha: existing?.reviewCompletedHeadSha ?? null,
              observedAt: handedOffAt,
            })
            return [settled.repairRun, next] as const
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
          if (completedRepair) {
            yield* Ref.update(context.state, (current) =>
              Transitions.releaseClaim(current, event.issueId),
            )
          } else {
            yield* context.scheduleRetry(settled.issue, 1, null, true, false)
          }
          break
        }
        case 'RetryDue': {
          const due = yield* Ref.modify(context.state, (current) =>
            Transitions.takeDueRetry(current, event.issueId, event.attempt),
          )
          if (Option.isNone(due)) {
            break
          }
          const awaiting = yield* Ref.get(context.state)
          const awaitingHandoff = Option.fromNullable(awaiting.handoffs.get(event.issueId))
          if (Option.exists(awaitingHandoff, (entry) => Option.isNone(entry.repair))) {
            // Taking the due retry creates the boundary at which the handoff no longer has a
            // queued or running continuation. Observe that pull request before another worker can
            // take ownership, so checks, review, merge, or repair cannot be starved by an active
            // issue that keeps completing normal continuation turns.
            yield* reconcileHandoffs(context, true, Option.some(event.issueId))
            const reconciled = yield* Ref.get(context.state)
            if (
              !reconciled.handoffs.has(event.issueId) ||
              reconciled.running.has(event.issueId) ||
              reconciled.retries.has(event.issueId)
            ) {
              break
            }
          }
          const current = yield* Ref.get(context.state)
          const effective = current.lastKnownGood
          const handoff = Option.fromNullable(current.handoffs.get(event.issueId))
          const repairHandoff = due.value.repairRun
            ? Option.filter(handoff, (entry) =>
                Option.exists(entry.repair, (repair) => repair.inFlight),
              )
            : Option.none<HandoffEntry>()
          const refreshTracker = Option.match(repairHandoff, {
            onNone: () => effective.tracker,
            onSome: (entry) => entry.execution.tracker,
          })
          const refreshResult = yield* refreshTracker
            .fetchIssuesByIds([event.issueId])
            .pipe(asSettled)
          if (refreshResult._tag === 'Failed') {
            const scheduled = yield* context.scheduleRetry(
              due.value.issue,
              event.attempt + 1,
              `retry refresh failed: ${refreshResult.error.message}`,
              false,
              due.value.repairRun,
              refreshResult.error,
            )
            if (!scheduled && Option.isSome(repairHandoff)) {
              yield* writeHandoff(context, event.issueId, settleRepair(repairHandoff.value))
            }
            break
          }
          const issue = Option.fromNullable(
            refreshResult.value.find((candidate) => candidate.id === event.issueId),
          )
          if (Option.isSome(repairHandoff)) {
            const entry = repairHandoff.value
            const repair = entry.repair
            if (Option.isNone(repair)) {
              break
            }
            const codeReview = entry.execution.codeReview
            if (Option.isNone(codeReview)) {
              yield* releaseHandoffRepair(context, event.issueId, repairHandoff)
              break
            }
            const terminalIssue = Option.filter(issue, (record) =>
              stateIsIn(record.state, entry.execution.workflow.config.tracker.terminalStates),
            )
            if (Option.isSome(terminalIssue)) {
              yield* entry.execution.workspaces.remove(terminalIssue.value.identifier).pipe(
                Effect.catchAll((error) =>
                  logWarning('terminal workspace cleanup failed', {
                    ...logContext(terminalIssue.value),
                    action: 'workspace_cleanup',
                    outcome: 'failed',
                    error: error.message,
                  }),
                ),
              )
            }
            const inspected = yield* codeReview.value
              .inspectPullRequest(entry.pullRequestNumber)
              .pipe(asSettled)
            if (inspected._tag === 'Failed') {
              const scheduled = yield* context.scheduleRetry(
                repair.value.issue,
                event.attempt + 1,
                `repair baseline refresh failed: ${inspected.error.message}`,
                false,
                true,
                inspected.error,
              )
              if (!scheduled) {
                yield* writeHandoff(context, event.issueId, settleRepair(entry))
              }
              break
            }
            const settled = settleRepair(entry)
            const inspectedAt = yield* currentInstant
            yield* applyHandoffObservation(
              context,
              event.issueId,
              settled,
              inspected.value,
              inspectedAt,
              repairPermission(settled, { _tag: 'Succeeded', issue }),
              Option.some(event.attempt),
              true,
            )
            yield* context.persistHandoffs
            break
          }
          if (Option.isNone(issue)) {
            yield* Ref.update(context.state, (pending) =>
              Transitions.releaseClaim(pending, event.issueId),
            )
            break
          }
          if (stateIsIn(issue.value.state, effective.workflow.config.tracker.terminalStates)) {
            yield* effective.workspaces.remove(issue.value.identifier).pipe(
              Effect.catchAll((error) =>
                logWarning('terminal workspace cleanup failed', {
                  ...logContext(issue.value),
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
            !issueIsActive(issue.value, effective.workflow.config.tracker) ||
            !issueIsRoutable(issue.value, effective.workflow.config.tracker)
          ) {
            yield* Ref.update(context.state, (pending) =>
              Transitions.releaseClaim(pending, event.issueId),
            )
            break
          }
          const admitting = yield* Ref.get(context.state)
          if (!hasSlot(admitting, issue.value, effective.workflow)) {
            yield* context.scheduleRetry(
              issue.value,
              event.attempt + 1,
              'no available orchestrator slots',
              false,
              false,
            )
            break
          }
          yield* dispatch(context, issue.value, event.attempt)
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
              if (Option.isNone(retry)) {
                continue
              }
              yield* Fiber.interrupt(retry.value.fiber)
              // An operator pause is a decision to stop, not an interruption to recover from:
              // the repair identity goes with the run the operator ended.
              yield* releaseHandoffRepair(
                context,
                id,
                Option.fromNullable(retrying.handoffs.get(id)),
              )
              // Dropping the queued retry ends the agent, so its detail has to say so: without
              // this the record would publish as completed while still claiming to be waiting
              // to retry, and the retry it pointed at would never arrive.
              const cancelledAt = yield* currentInstant
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
