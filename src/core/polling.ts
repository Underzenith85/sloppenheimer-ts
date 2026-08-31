import { Deferred, Effect, Fiber, Option, Queue, Ref, type Scope } from 'effect'

import { cyclicIssueIdentifiers } from '../domain/dependencies.js'
import type { Issue, IssueId } from '../domain/domain.js'
import { classifyPullRequest } from '../domain/handoff.js'
import type { Workflow } from '../config/workflow.js'
import { logError, logInfo, logWarning } from '../support/logging.js'
import { recordAgentEvent, recordCancellation, recordHandoff } from '../telemetry.js'
import { dispatch } from './dispatch.js'
import {
  afterRepairDispatched,
  attributeRepairHead,
  gateReview,
  releaseRepair,
  repairIssue,
  repairLimit,
  settleRepair,
} from './handoff-decision.js'
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
import type { EffectiveWorkflow, HandoffEntry } from './state.js'
import * as Transitions from './transitions.js'
import {
  drainRetirements,
  installEffectiveWorkflow,
  revalidateCredentials,
} from './workflow-reload.js'

/** One handoff write, in the shape every repair-identity change in this module needs. */
const writeHandoff = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry,
): Effect.Effect<void> =>
  Ref.update(context.state, (current) => Transitions.putHandoff(current, id, handoff)).pipe(
    Effect.zipRight(context.persistHandoffs),
  )

/** Keeps a repair's baseline across an interruption that is not the repair ending. */
const settleHandoffRepair = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry | undefined,
): Effect.Effect<void> =>
  handoff === undefined || Option.isNone(handoff.repair)
    ? Effect.void
    : writeHandoff(context, id, settleRepair(handoff))

/** Ends a repair: whatever identity it was carrying goes with it. */
const releaseHandoffRepair = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry | undefined,
): Effect.Effect<void> =>
  handoff === undefined || Option.isNone(handoff.repair)
    ? Effect.void
    : writeHandoff(context, id, releaseRepair(handoff))

const markRepairWorkerStarted = (
  context: OrchestratorContext,
  id: IssueId,
  reason: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(context.state)
    const handoff = current.handoffs.get(id)
    if (handoff === undefined || Option.isNone(handoff.repair)) {
      return
    }
    yield* writeHandoff(context, id, {
      ...handoff,
      repair: Option.some({ ...handoff.repair.value, workerStarted: true }),
      reason,
    })
  })

/** What a due retry should dispatch: the issue, and the workflow it belongs to when it is a repair. */
type RepairRetry = Readonly<{
  issue: Issue
  effective: EffectiveWorkflow | undefined
  /** What the handoff should read once a worker really starts from this baseline. */
  runningReason: string
}>

/**
 * Settles the repair attempt that queued this retry, and re-baselines the next one.
 *
 * Every repair retry re-inspects the pull request first: a refused dispatch may be queued behind a
 * manual push, and a worker that pushed before it failed leaves a head that is its output and
 * nobody else's. Reconciliation skips a handoff whose retry is queued, so this is the only place
 * that head can be attributed; without it the next attempt's head would stand in for two. None
 * means the retry is abandoned, the handoff having been written with why.
 */
const prepareRepairRetry = (
  context: OrchestratorContext,
  id: IssueId,
  issue: Issue,
  handoff: HandoffEntry | undefined,
  attempt: Readonly<{ attempt: number }>,
): Effect.Effect<Option.Option<RepairRetry>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const plain: Option.Option<RepairRetry> = Option.some({
      issue,
      effective: undefined,
      runningReason: '',
    })
    if (handoff === undefined || Option.isNone(handoff.repair) || !handoff.repair.value.inFlight) {
      return plain
    }
    const repair = handoff.repair.value
    const codeReview = handoff.execution.codeReview
    if (codeReview === null) {
      yield* writeHandoff(context, id, releaseRepair(handoff))
      return Option.none()
    }
    const inspected = yield* codeReview.inspectPullRequest(handoff.pullRequestNumber).pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: 'Failed' as const, error }),
        onSuccess: (observation) => ({ _tag: 'Succeeded' as const, observation }),
      }),
    )
    if (inspected._tag === 'Failed') {
      yield* context.scheduleRetry(
        repair.issue,
        attempt.attempt + 1,
        `repair baseline refresh failed: ${inspected.error.message}`,
        false,
      )
      return Option.none()
    }
    if (inspected.observation.state !== 'open') {
      yield* writeHandoff(context, id, releaseRepair(handoff))
      return Option.none()
    }
    const observedHeadSha = inspected.observation.headSha
    // The attempt that queued this retry pushed and then failed, so that head is its output and
    // spends the budget here, where reconciliation cannot see it: a handoff whose retry is queued
    // is skipped by every pass. What the head costs is `attributeRepairHead`'s to say.
    const produced = repair.workerStarted && observedHeadSha !== repair.startedHeadSha
    const attribution = produced
      ? Option.some(attributeRepairHead(handoff, observedHeadSha))
      : Option.none()
    if (Option.isSome(attribution) && attribution.value._tag === 'Cycled') {
      yield* writeHandoff(context, id, attribution.value.handoff)
      return Option.none()
    }
    const attributed: HandoffEntry = Option.isSome(attribution)
      ? attribution.value.handoff
      : handoff
    // The same gate reconciliation applies before it repairs anything: a head this attempt just
    // pushed has no completed review yet, and repairing it would spend one of the budget with no
    // review feedback to work from. Standing down leaves the next pass to request that review.
    if (Option.isSome(gateReview(attributed, inspected.observation))) {
      yield* writeHandoff(context, id, releaseRepair(attributed))
      return Option.none()
    }
    const disposition = classifyPullRequest(inspected.observation)
    if (disposition.state !== 'repair_needed') {
      yield* writeHandoff(context, id, releaseRepair(attributed))
      return Option.none()
    }
    if (attributed.repairHeadShas.length >= repairLimit) {
      yield* writeHandoff(context, id, {
        ...releaseRepair(attributed),
        state: 'intervention_required',
        headSha: observedHeadSha,
        reason: `Repair limit reached. ${disposition.reason}`,
      })
      return Option.none()
    }
    // Built on the record this retry just refetched, not the one the handoff stored: the worker
    // gets current fields, and admission buckets the run by the state the issue is in now.
    const dispatchIssue = repairIssue(attributed, issue, observedHeadSha, disposition.reason)
    yield* writeHandoff(
      context,
      id,
      afterRepairDispatched(attributed, false, dispatchIssue, observedHeadSha, disposition.reason),
    )
    // A repair belongs to the workflow its pull request was handed off under, the way
    // reconciliation dispatches the first attempt. A reload between the refusal and this retry
    // must not re-render the repair through a template that drops the instructions.
    return Option.some({
      issue: dispatchIssue,
      runningReason: `Repair agent running. ${disposition.reason}`,
      effective: {
        workflow: handoff.execution.workflow,
        tracker: handoff.execution.tracker,
        codeReview,
        workspaces: handoff.execution.workspaces,
        loadedAt: handoff.observedAt,
      },
    })
  })

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
          const ended = yield* Ref.modify(context.state, (current) =>
            Transitions.endRun(current, event.issueId, event.runId),
          )
          if (Option.isNone(ended)) {
            break
          }
          const settled = yield* Ref.modify(context.state, (current) =>
            Transitions.applyPendingTelemetry(current, event.issueId, ended.value),
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
              repair: existing === undefined ? Option.none() : existing.repair,
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
          const due = yield* Ref.modify(context.state, (current) =>
            Transitions.takeDueRetry(current, event.issueId, event.attempt),
          )
          if (Option.isNone(due)) {
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
              due.value.issue,
              event.attempt + 1,
              `retry refresh failed: ${refreshResult.error.message}`,
              false,
            )
            break
          }
          const handoff = current.handoffs.get(event.issueId)
          const issue = refreshResult.issues.find((candidate) => candidate.id === event.issueId)
          if (issue === undefined) {
            // The handoff outlives an issue the tracker stopped reporting, so a head the worker
            // pushed is still the repair's to account for on the next inspection.
            yield* settleHandoffRepair(context, event.issueId, handoff)
            yield* Ref.update(context.state, (pending) =>
              Transitions.releaseClaim(pending, event.issueId),
            )
            break
          }
          if (stateIsIn(issue.state, effective.workflow.config.tracker.terminalStates)) {
            // The checkout to remove is the one the work ran in. A reload can replace the workspace
            // manager while the retry waits, and a repair retry dispatches into the handoff's
            // manager, so its cleanup has to reach there rather than the newer root.
            const workspaces = handoff?.execution.workspaces ?? effective.workspaces
            yield* workspaces.remove(issue.identifier).pipe(
              Effect.catchAll((error) =>
                logWarning('terminal workspace cleanup failed', {
                  ...logContext(issue),
                  action: 'workspace_cleanup',
                  outcome: 'failed',
                  error: error.message,
                }),
              ),
            )
            // The repair identity is deliberately left alone: the handoff outlives the issue, and
            // the next inspection is what resolves the baseline -- attributing a head the worker
            // pushed, or escalating a repair that changed nothing. Releasing it here would erase
            // that verdict and let reconciliation dispatch another repair for abandoned work.
            yield* Ref.update(context.state, (pending) =>
              Transitions.releaseClaim(pending, event.issueId),
            )
            break
          }
          if (
            !issueIsActive(issue, effective.workflow) ||
            !issueIsRoutable(issue, effective.workflow)
          ) {
            // The continuation cannot be routed right now, but that does not end the repair.
            yield* settleHandoffRepair(context, event.issueId, handoff)
            yield* Ref.update(context.state, (pending) =>
              Transitions.releaseClaim(pending, event.issueId),
            )
            break
          }
          const repaired = yield* prepareRepairRetry(context, event.issueId, issue, handoff, {
            attempt: event.attempt,
          })
          if (Option.isNone(repaired)) {
            break
          }
          // Admission is judged against the workflow the run will actually be dispatched under,
          // the way reconciliation admits the first repair, and against state re-read after the
          // refresh above, which awaited a pull-request inspection another dispatch could span.
          const admitting = yield* Ref.get(context.state)
          const admissionWorkflow = repaired.value.effective?.workflow ?? effective.workflow
          // Deferred with the refreshed repair identity, not the one this retry arrived with:
          // waiting for a slot is not a reason to re-run the attribution on the next attempt.
          if (!hasSlot(admitting, repaired.value.issue, admissionWorkflow)) {
            yield* context.scheduleRetry(
              repaired.value.issue,
              event.attempt + 1,
              'no available orchestrator slots',
              false,
            )
            break
          }
          // An ordinary worker continuation has no repair identity and establishes no baseline.
          const started = yield* dispatch(
            context,
            repaired.value.issue,
            event.attempt,
            repaired.value.effective,
          )
          if (started && repaired.value.effective !== undefined) {
            yield* markRepairWorkerStarted(context, event.issueId, repaired.value.runningReason)
          }
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
              yield* releaseHandoffRepair(context, id, retrying.handoffs.get(id))
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
