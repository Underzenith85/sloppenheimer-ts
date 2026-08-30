import { Deferred, Effect, Fiber, Queue, type Scope } from 'effect'

import { cyclicIssueIdentifiers } from '../domain/dependencies.js'
import type { Issue } from '../domain/domain.js'
import type { Workflow } from '../config/workflow.js'
import { mergeSparseObject } from '../support/json.js'
import { logError, logInfo, logWarning } from '../support/logging.js'
import { recordAgentEvent, recordCancellation, recordHandoff } from '../telemetry.js'
import { dispatch } from './dispatch.js'
import { hydrateRestoredHandoffs, reconcileHandoffs } from './handoff-reconciliation.js'
import type { OrchestratorContext } from './runtime.js'
import { publishDetails } from './snapshot.js'
import { adoptPorts, drainRetirements, revalidateCredentials } from './workflow-reload.js'

export const poll = (context: OrchestratorContext): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    // A worker that ended since the last pass may have been the last holder of a replaced instance.
    yield* drainRetirements(context)
    const revalidated = yield* revalidateCredentials(context, context.lastKnownGood).pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: 'Failed' as const, error }),
        onSuccess: (value) => ({ _tag: 'Succeeded' as const, value }),
      }),
    )
    if (revalidated._tag === 'Failed') {
      yield* logError('tracker credential validation failed; retaining last known good', {
        error: revalidated.error.message,
        effective_fingerprint: context.lastKnownGood.workflow.fingerprint,
      })
    } else if (revalidated.value !== context.lastKnownGood) {
      const previous = context.lastKnownGood
      context.lastKnownGood = revalidated.value
      yield* adoptPorts(context, previous, revalidated.value)
      yield* logInfo('tracker credential refreshed from the environment', {
        tracker_kind: revalidated.value.workflow.tracker.kind,
        secret_environment_name: revalidated.value.workflow.tracker.provider.tokenEnvironmentName,
      })
    }
    yield* hydrateRestoredHandoffs(context)
    yield* context.recoverMissingHandoffsEffect()
    yield* reconcileHandoffs(context)
    yield* context.reconcileEffect()
    const reloaded = yield* context.ports.workflowLoader.load(context.selectedWorkflowPath).pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          context.workflowReloadError = { message: error.message, observedAt: new Date() }
          return logError('workflow validation failed; retaining last known good', {
            error: error.message,
            effective_fingerprint: context.lastKnownGood.workflow.fingerprint,
          }).pipe(Effect.as<Workflow | null>(null))
        },
        onSuccess: (loaded) => Effect.succeed<Workflow | null>(loaded),
      }),
    )
    if (reloaded !== null) {
      context.workflowReloadError = null
      if (reloaded.fingerprint !== context.lastKnownGood.workflow.fingerprint) {
        const configured = yield* context.makeEffectiveWorkflowEffect(reloaded).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: 'Failed' as const, error }),
            onSuccess: (value) => ({ _tag: 'Succeeded' as const, value }),
          }),
        )
        if (configured._tag === 'Failed') {
          context.workflowReloadError = {
            message: configured.error.message,
            observedAt: new Date(),
          }
          yield* logError('workflow port configuration failed; retaining last known good', {
            error: configured.error.message,
            effective_fingerprint: context.lastKnownGood.workflow.fingerprint,
          })
        } else {
          const previous = context.lastKnownGood
          context.lastKnownGood = configured.value
          yield* adoptPorts(context, previous, configured.value)
          yield* logInfo('workflow reloaded', {
            path: reloaded.path,
            fingerprint: reloaded.fingerprint,
          })
        }
      }
    }
    const effective = context.lastKnownGood
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
    for (const issue of context.sortIssuesValue(candidates)) {
      if (
        !context.startupRecoveryFinished ||
        context.state.claimed.has(issue.id) ||
        (context.identifierIssueNumberValue(issue.identifier) !== null &&
          context.state.pausedIssueNumbers.has(
            context.identifierIssueNumberValue(issue.identifier) ?? -1,
          )) ||
        cyclicIdentifiers.has(issue.identifier) ||
        !context.issueIsActiveValue(issue, effective.workflow) ||
        !context.issueIsRoutableValue(issue, effective.workflow) ||
        !context.stateHasSlotValue(issue, context.state, effective.workflow)
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
          context.pollRunning = true
          yield* poll(context)
          const waiters = context.currentRefreshWaiters.splice(0)
          yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), {
            discard: true,
          })
          if (context.followUpRequested) {
            context.followUpRequested = false
            context.currentRefreshWaiters.push(...context.nextRefreshWaiters.splice(0))
            context.pollRunning = false
            yield* Queue.offer(context.mailbox, { _tag: 'Tick' })
            break
          }
          context.pollRunning = false
          context.tickQueued = false
          yield* context.scheduleNextTickEffect()
          break
        }
        case 'AgentUpdate': {
          const entry = context.state.running.get(event.issueId)
          if (entry !== undefined) {
            yield* context.applyLifecycleUpdateEffect(entry, event.update)
            const queued = context.pendingLifecycle.get(event.issueId)
            if (queued !== undefined) {
              const index = queued.indexOf(event.update)
              if (index >= 0) {
                queued.splice(index, 1)
              }
              if (queued.length === 0) {
                context.pendingLifecycle.delete(event.issueId)
              }
            }
            if (event.update.usage !== null) {
              entry.lastReportedTokens = event.update.usage
              entry.tokens = {
                inputTokens: Math.max(entry.tokens.inputTokens, event.update.usage.inputTokens),
                outputTokens: Math.max(entry.tokens.outputTokens, event.update.usage.outputTokens),
                totalTokens: Math.max(entry.tokens.totalTokens, event.update.usage.totalTokens),
              }
            }
            if (event.update.rateLimits !== null) {
              context.state.rateLimits = mergeSparseObject(
                context.state.rateLimits,
                event.update.rateLimits,
              )
              if (context.pendingRateLimits === event.update.rateLimits) {
                context.pendingRateLimits = null
              }
            }
          }
          const record = context.state.details.get(event.issueId)
          // Only a live run contributes to the timeline: output from a worker the orchestrator
          // has already ended belongs to no attempt.
          if (entry !== undefined && record !== undefined) {
            recordAgentEvent(record, event.update)
          }
          break
        }
        case 'WorkerExited': {
          const entry = context.endRunningValue(event.issueId, event.runId)
          if (entry === null) {
            break
          }
          context.applyPendingTelemetryValue(event.issueId, entry)
          context.accountEndedRuntimeValue(entry, Date.now())
          const record = context.state.details.get(event.issueId)
          if (entry.sessionId !== null) {
            yield* (event.outcome === 'normal' ? logInfo : logError)(
              event.outcome === 'normal'
                ? 'action=session outcome=completed'
                : 'action=session outcome=failed',
              {
                ...context.sessionLogContextValue(entry),
                action: 'session',
                outcome: event.outcome === 'normal' ? 'completed' : 'failed',
                error: event.error,
              },
            )
          }
          if (event.outcome === 'normal') {
            const codeReview = entry.execution.codeReview
            if (codeReview === null) {
              yield* context.scheduleRetryEffect(entry.issue, 1, null, true)
              break
            }
            // Published before the tracker call, not after it: the worker is already out of the
            // running map, so an open detail panel would otherwise keep reading the previous
            // snapshot as running — and count it down to stalled — for as long as the handoff
            // request takes.
            if (record !== undefined) {
              recordHandoff(record, new Date(), {
                step: 'remote_branch',
                status: 'pending',
                message: 'Looking for a pushed branch to hand off',
              })
            }
            publishDetails(context)
            const handoff = yield* codeReview.handoffCompletedWork(entry.issue).pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: 'Failed' as const, error }),
                onSuccess: (result) => ({ _tag: 'Succeeded' as const, result }),
              }),
            )
            if (handoff._tag === 'Failed') {
              if (record !== undefined) {
                recordHandoff(record, new Date(), {
                  step: 'remote_branch',
                  status: 'failed',
                  message: handoff.error.message,
                  outcome: 'failed',
                })
              }
              yield* context.scheduleRetryEffect(
                entry.issue,
                (event.attempt ?? 0) + 1,
                `handoff failed: ${handoff.error.message}`,
                false,
              )
              break
            }
            if (handoff.result._tag === 'NoBranch') {
              if (record !== undefined) {
                recordHandoff(record, new Date(), {
                  step: 'remote_branch',
                  status: 'absent',
                  message: `No remote branch ${handoff.result.branchName} exists yet; continuing the session`,
                  remoteBranch: handoff.result.branchName,
                  outcome: 'no_branch',
                })
              }
              yield* context.scheduleRetryEffect(entry.issue, 1, null, true)
              break
            }
            if (record !== undefined) {
              const observedAt = new Date()
              recordHandoff(record, observedAt, {
                step: 'remote_branch',
                status: 'observed',
                message: `Remote branch ${handoff.result.branchName} is present`,
                remoteBranch: handoff.result.branchName,
              })
              recordHandoff(record, observedAt, {
                step: 'pull_request',
                status: 'observed',
                message: handoff.result.created
                  ? 'Opened a pull request for the completed work'
                  : 'Reused the pull request already open for this branch',
                pullRequest: {
                  status: handoff.result.created ? 'created' : 'reused',
                  number: handoff.result.pullRequestNumber,
                  url: handoff.result.pullRequestUrl,
                  state: 'awaiting_checks',
                },
                outcome: 'pull_request_open',
              })
              recordHandoff(record, observedAt, {
                step: 'dispatch_label',
                status: record.handoff.dispatchLabels.status,
                message: record.handoff.dispatchLabels.reason,
              })
            }
            // Carried over, not reset: the worker attempt number is not a repair count, and an
            // existing handoff already holds the heads that were actually observed.
            const existingHandoff = context.state.handoffs.get(event.issueId)
            context.state.handoffs.set(event.issueId, {
              issue: existingHandoff?.issue ?? entry.issue,
              execution: entry.execution,
              pullRequestNumber: handoff.result.pullRequestNumber,
              pullRequestUrl: handoff.result.pullRequestUrl,
              branchName: handoff.result.branchName,
              state: 'awaiting_checks',
              headSha: existingHandoff?.headSha ?? null,
              reason: 'Awaiting the first protected-branch observation',
              repairHeadShas: existingHandoff?.repairHeadShas ?? [],
              repairObservedHeadShas: existingHandoff?.repairObservedHeadShas ?? [],
              repairStartedHeadSha: existingHandoff?.repairStartedHeadSha ?? null,
              repairBaselineRestored: existingHandoff?.repairBaselineRestored ?? false,
              reviewRequestedHeadSha: existingHandoff?.reviewRequestedHeadSha ?? null,
              reviewCompletedHeadSha: existingHandoff?.reviewCompletedHeadSha ?? null,
              observedAt: new Date(),
            })
            yield* context.persistHandoffsEffect()
            yield* logInfo('worker handed off pull request', {
              ...context.logContextValue(entry.issue),
              action: 'pull_request_handoff',
              outcome: 'completed',
              error: null,
              branch: handoff.result.branchName,
              pull_request_url: handoff.result.pullRequestUrl,
            })
          } else {
            yield* context.scheduleRetryEffect(
              entry.issue,
              (event.attempt ?? 0) + 1,
              event.error,
              false,
            )
          }
          break
        }
        case 'RetryDue': {
          const retry = context.state.retries.get(event.issueId)
          if (retry?.attempt !== event.attempt) {
            break
          }
          context.state.retries.delete(event.issueId)
          const effective = context.lastKnownGood
          const refreshResult = yield* effective.tracker.fetchIssuesByIds([event.issueId]).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: 'Failed' as const, error }),
              onSuccess: (issues) => ({ _tag: 'Succeeded' as const, issues }),
            }),
          )
          if (refreshResult._tag === 'Failed') {
            yield* context.scheduleRetryEffect(
              retry.issue,
              event.attempt + 1,
              `retry refresh failed: ${refreshResult.error.message}`,
              false,
            )
            break
          }
          const issue = refreshResult.issues.find((candidate) => candidate.id === event.issueId)
          if (issue === undefined) {
            context.state.claimed.delete(event.issueId)
            break
          }
          if (
            context.stateIsInValue(issue.state, effective.workflow.config.tracker.terminalStates)
          ) {
            yield* effective.workspaces.remove(issue.identifier).pipe(
              Effect.catchAll((error) =>
                logWarning('terminal workspace cleanup failed', {
                  ...context.logContextValue(issue),
                  action: 'workspace_cleanup',
                  outcome: 'failed',
                  error: error.message,
                }),
              ),
            )
            context.state.claimed.delete(event.issueId)
            break
          }
          if (
            !context.issueIsActiveValue(issue, effective.workflow) ||
            !context.issueIsRoutableValue(issue, effective.workflow)
          ) {
            context.state.claimed.delete(event.issueId)
            break
          }
          if (!context.stateHasSlotValue(issue, context.state, effective.workflow)) {
            yield* context.scheduleRetryEffect(
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
            context.state.pausedIssueNumbers.add(event.issueNumber)
            for (const [id, entry] of context.state.running) {
              if (
                context.identifierIssueNumberValue(entry.issue.identifier) === event.issueNumber
              ) {
                yield* context.cancelRunningEffect(id, false, 'the operator paused the issue')
              }
            }
            for (const [id, retry] of context.state.retries) {
              if (
                context.identifierIssueNumberValue(retry.issue.identifier) === event.issueNumber
              ) {
                yield* Fiber.interrupt(retry.fiber)
                context.state.retries.delete(id)
                context.state.claimed.delete(id)
                // Dropping the queued retry ends the agent, so its detail has to say so: without
                // this the record would publish as completed while still claiming to be waiting
                // to retry, and the retry it pointed at would never arrive.
                const record = context.state.details.get(id)
                if (record !== undefined) {
                  recordCancellation(record, new Date(), 'the operator paused the issue', true)
                }
              }
            }
          } else {
            context.state.pausedIssueNumbers.delete(event.issueNumber)
          }
          yield* Deferred.succeed(event.reply, undefined)
          break
        }
      }
      // Every mutation of runtime state is followed by exactly one publication, so a consumer
      // never sees an index that disagrees with the scheduler it was derived from.
      publishDetails(context)
    }
  })
