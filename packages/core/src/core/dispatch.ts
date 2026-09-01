import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  MutableRef,
  Option,
  Queue,
  Ref,
  type Scope,
} from 'effect'

import { renderPrompt } from '../config/workflow.js'
import type { Issue, Workspace } from '../domain/domain.js'
import { issueBranchName } from '../domain/handoff.js'
import { AgentError, type SourceControlError, type WorkspaceError } from '../domain/errors.js'
import type { WorkspaceRelease } from '../domain/workspace-lease.js'
import { unsupportedHostTool, type HostToolSession } from '../domain/host-tools.js'
import { currentInstant } from '../support/clock.js'
import { logError, logInfo } from '../support/logging.js'
import { asSettled } from '../support/settled.js'
import type { AgentEvent } from '../telemetry.js'
import { captureExecutionSnapshot, issueIsActive, issueIsRoutable, logContext } from './policy.js'
import { postflightLogOutcome, runPostflight, type PostflightOutcome } from './postflight.js'
import type { OrchestratorContext } from './runtime.js'
import type { EffectiveWorkflow, ExecutionSnapshot, RunningEntry, SessionPorts } from './state.js'
import type { SourceControlTarget } from '../ports/index.js'
import * as Transitions from './transitions.js'
import { installEffectiveWorkflow, revalidateCredentials } from './workflow-reload.js'

/**
 * The tool surface advertised to one session.
 *
 * The specs are fixed at dispatch — a rebuilt adapter of the same kind advertises the same tools —
 * but every invocation resolves the port through `current`, so a session that outlives a credential
 * rotation calls the instance the orchestrator adopted rather than the one it was dispatched with.
 */
export const makeHostToolSession = (
  execution: Pick<SessionPorts, 'tracker' | 'codeReview'>,
  issue: Issue,
  current: () => Pick<SessionPorts, 'tracker' | 'codeReview'> = () => execution,
): HostToolSession =>
  Object.freeze({
    specs: Object.freeze([
      ...execution.tracker.toolSpecs,
      ...Option.match(execution.codeReview, {
        onNone: () => [],
        onSome: (codeReview) => codeReview.toolSpecs,
      }),
    ]),
    context: Object.freeze({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      nativeRef: issue.nativeRef,
    }),
    execute: (name, argumentsValue, context) => {
      const ports = current()
      if (ports.tracker.toolSpecs.some((spec) => spec.name === name)) {
        return ports.tracker.executeTool(name, argumentsValue, context)
      }
      const codeReview = ports.codeReview
      if (
        Option.isSome(codeReview) &&
        codeReview.value.toolSpecs.some((spec) => spec.name === name)
      ) {
        return codeReview.value.executeTool(name, argumentsValue, context)
      }
      return unsupportedHostTool(name)
    },
  })

/**
 * Whether an update reports a lifecycle transition the run has to be told about, as the runner that
 * emitted it says so. This used to match one backend's own method names, which meant a second
 * runner's session would start, run and finish with none of these ever queued.
 */
const isLifecycleEvent = (update: AgentEvent): boolean => update.lifecycle !== null

/** Everything one dispatched session is launched with, in one value its parts can be built from. */
type SessionLaunch = Readonly<{
  context: OrchestratorContext
  issue: Issue
  attempt: number | null
  runId: number
  execution: ExecutionSnapshot
  /**
   * The ports this run reaches its provider through, in a cell the non-Effect world can read. A
   * host tool leaves Effect for a promise and so cannot take a turn on the state cell; adoption
   * writes the replacement here at the moment it rewrites the run's execution snapshot, which is
   * what keeps a live session current with the orchestrator.
   */
  sessionPorts: MutableRef.MutableRef<SessionPorts>
  hostTools: HostToolSession
  target: SourceControlTarget
  /** Whether this worker was dispatched to repair an existing pull request. */
  repairRun: boolean
}>

/** Re-reads the issue through whichever tracker instance the run holds at the moment it asks. */
const refreshIssueThrough =
  (launch: SessionLaunch): (() => Effect.Effect<Issue | null, AgentError>) =>
  () =>
    MutableRef.get(launch.sessionPorts)
      .tracker.fetchIssuesByIds([launch.issue.id])
      .pipe(
        Effect.map((issues) => issues[0] ?? null),
        Effect.mapError(
          (error) =>
            new AgentError({
              category: 'protocol_error',
              message: `issue refresh failed: ${error.message}`,
              cause: error,
            }),
        ),
      )

/** One agent session, inside the workspace hooks that bracket it. */
const runSession = (
  launch: SessionLaunch,
  workspace: Workspace,
): Effect.Effect<void, AgentError | WorkspaceError> => {
  const { context, issue, execution } = launch
  return execution.workspaces.beforeRun(workspace).pipe(
    Effect.zipRight(
      context.ports.agentRunner.run({
        issue,
        workspace,
        workspaceRoot: execution.workspaceRoot,
        config: execution.agentRunner,
        prompt: execution.prompt,
        maxTurns: execution.maxTurns,
        secretEnvironmentNames: execution.secretEnvironmentNames,
        hostTools: launch.hostTools,
        refreshIssue: refreshIssueThrough(launch),
        isRoutable: (refreshed) =>
          issueIsActive(refreshed, execution) && issueIsRoutable(refreshed, execution),
        // The runner reports progress from a plain callback. Recording what the update owes
        // the run and enqueueing it are one step, so an exit cannot overtake a report the
        // callback has already made.
        onEvent: (update) => {
          context.runFromCallback(
            Ref.update(context.state, (current) => {
              let next = current
              if (update.usage !== null) {
                next = Transitions.recordPendingUsage(next, issue.id, update.usage)
              }
              if (update.rateLimits !== null) {
                next = Transitions.recordPendingRateLimits(next, update.rateLimits)
              }
              if (isLifecycleEvent(update)) {
                next = Transitions.queuePendingLifecycle(next, issue.id, update)
              }
              return next
            }).pipe(
              Effect.zipRight(
                Queue.offer(context.mailbox, {
                  _tag: 'AgentUpdate',
                  issueId: issue.id,
                  update,
                }),
              ),
              Effect.asVoid,
            ),
          )
        },
      }),
    ),
    Effect.ensuring(execution.workspaces.afterRun(workspace)),
    Effect.asVoid,
  )
}

/**
/**
 * The postflight-bracketed body of one run, inside the workspace the run leases.
 *
 * The postflight is reported rather than raised. A turn that ended and a change that reached the
 * remote are separate outcomes, so a publication that failed leaves the body succeeding with a
 * `DeliveryFailed` postflight, and only the agent protocol itself can fail a run.
 */
const runWithSourceControl = (
  launch: SessionLaunch,
  workspace: Workspace,
): Effect.Effect<PostflightOutcome, AgentError | WorkspaceError | SourceControlError> => {
  const { context, issue, runId, sessionPorts, target } = launch
  const sourceControl = MutableRef.get(sessionPorts).sourceControl
  if (sourceControl === null) {
    return runSession(launch, workspace).pipe(
      Effect.as<PostflightOutcome>({ _tag: 'NotPerformed' }),
    )
  }
  return sourceControl.prepare(issue, workspace, target).pipe(
    Effect.flatMap((prepared) =>
      runSession(launch, workspace).pipe(
        Effect.zipRight(
          Effect.gen(function* () {
            const publisher = MutableRef.get(sessionPorts).sourceControl ?? sourceControl
            // Announced *and applied* before the first git call: from here the run is the host's
            // work, and the silence on the agent protocol that follows is not a stalled agent.
            // Offering alone would only enqueue it — a poll already in flight would still read a
            // run nothing had marked and retire the publication as a stalled agent, which is the
            // one thing this marker exists to prevent.
            const applied = yield* Deferred.make<void>()
            yield* Queue.offer(context.mailbox, {
              _tag: 'PostflightStarted' as const,
              issueId: issue.id,
              runId,
              applied,
            })
            yield* Deferred.await(applied)
            return yield* runPostflight(publisher, issue, prepared)
          }),
        ),
        Effect.tap((outcome) =>
          (outcome._tag === 'DeliveryFailed' ? logError : logInfo)(
            'host source-control postflight settled',
            {
              ...logContext(issue),
              action: 'source_control_postflight',
              outcome: postflightLogOutcome(outcome),
              branch: target.branchName,
              error: outcome._tag === 'DeliveryFailed' ? outcome.failure.message : null,
            },
          ),
        ),
      ),
    ),
  )
}

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
const workspaceRelease = (
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
 * The whole of one run as a fiber body: the workspace this run leases for itself, the host-owned
 * preparation and postflight that bracket the session when the host owns the repository, and the
 * `WorkerExited` that reports how it ended. Every exit path offers that event, so a run can never
 * end unobserved, and every exit path releases the lease — including the interruption that a
 * cancellation or a shutdown ends the run with.
 */
const makeWorker = (launch: SessionLaunch): Effect.Effect<void> => {
  const { context, issue, attempt, runId, execution } = launch
  return execution.workspaces
    .withLeasedWorkspace(
      { identifier: issue.identifier, runId },
      (workspace) => runWithSourceControl(launch, workspace),
      workspaceRelease,
    )
    .pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Queue.offer(context.mailbox, {
            _tag: 'WorkerExited',
            issueId: issue.id,
            runId,
            attempt,
            outcome: 'failed',
            error: error.message,
            postflight: { _tag: 'NotPerformed' },
          }).pipe(Effect.asVoid),
        onSuccess: (postflight) =>
          Queue.offer(context.mailbox, {
            _tag: 'WorkerExited',
            issueId: issue.id,
            runId,
            attempt,
            outcome: 'normal',
            error: null,
            postflight,
          }).pipe(Effect.asVoid),
      }),
    )
}

/** What a started session is before it has reported anything: everything else arrives later. */
const startingRun = (
  launch: SessionLaunch,
  fiber: Fiber.Fiber<void>,
  startedAt: Date,
): RunningEntry => ({
  runId: launch.runId,
  issue: launch.issue,
  fiber,
  execution: launch.execution,
  sessionPorts: launch.sessionPorts,
  attempt: launch.attempt,
  repairRun: launch.repairRun,
  startedAt,
  postflightStartedAt: null,
  lastEventAt: null,
  lastEvent: null,
  lastMessage: null,
  processId: null,
  threadId: null,
  turnId: null,
  sessionId: null,
  turnCount: 0,
  turnActive: false,
  tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  lastReportedTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
})

/** Resolves to whether a session actually started, so a caller can tie state to a real dispatch. */
export const dispatch = (
  context: OrchestratorContext,
  issue: Issue,
  attempt: number | null,
  effectiveOverride?: EffectiveWorkflow,
  sourceTarget?: SourceControlTarget,
): Effect.Effect<boolean, never, Scope.Scope> =>
  Effect.gen(function* () {
    const before = yield* Ref.get(context.state)
    if (before.running.has(issue.id)) {
      return false
    }
    // Claiming and taking the queued retry are one transition: the issue must never be seen as
    // claimed-but-still-retrying, and the timer that would fire is interrupted here.
    const displacedRetry = yield* Ref.modify(context.state, (current) =>
      Transitions.takeRetry(Transitions.claimIssue(current, issue), issue.id),
    )
    if (Option.isSome(displacedRetry)) {
      yield* Fiber.interrupt(displacedRetry.value.fiber)
    }

    const base = effectiveOverride ?? before.lastKnownGood
    const target: SourceControlTarget = sourceTarget ?? {
      _tag: 'Normal',
      branchName: issueBranchName(issue),
    }
    const repairRun = target._tag === 'Repair'
    // Opened before preflight, not after the worker starts: a dispatch that fails validation or
    // prompt rendering schedules a retry, and that retry's published link has to resolve to the
    // reason it failed rather than to "no active session".
    yield* context.detailRecord(issue, attempt, base.workflow.config.tracker.requiredLabels)
    const preflight = yield* revalidateCredentials(context, base).pipe(asSettled)
    if (preflight._tag === 'Failed') {
      yield* logError('action=dispatch outcome=failed', {
        ...logContext(issue),
        action: 'dispatch',
        outcome: 'failed',
        error: preflight.error.message,
      })
      yield* context.scheduleRetry(
        issue,
        (attempt ?? 0) + 1,
        preflight.error.message,
        false,
        repairRun,
      )
      return false
    }
    const effective = preflight.value
    if (effectiveOverride === undefined && effective !== base) {
      yield* installEffectiveWorkflow(context, base, effective)
    }
    const renderedPrompt = yield* renderPrompt(effective.workflow, issue, attempt).pipe(asSettled)
    if (renderedPrompt._tag === 'Failed') {
      yield* context.scheduleRetry(
        issue,
        (attempt ?? 0) + 1,
        renderedPrompt.error.message,
        false,
        repairRun,
      )
      return false
    }
    const execution = captureExecutionSnapshot(effective, renderedPrompt.value)
    const runId = yield* Ref.modify(context.state, Transitions.takeRunId)
    const sessionPorts = MutableRef.make<SessionPorts>({
      tracker: execution.tracker,
      codeReview: execution.codeReview,
      sourceControl: execution.sourceControl,
    })
    const launch: SessionLaunch = {
      context,
      issue,
      attempt,
      runId,
      execution,
      sessionPorts,
      hostTools: makeHostToolSession(execution, issue, () => MutableRef.get(sessionPorts)),
      target,
      repairRun,
    }
    const fiber = yield* Effect.forkScoped(makeWorker(launch))
    const startedAt = yield* currentInstant
    yield* Ref.update(context.state, (current) =>
      Transitions.beginRun(current, startingRun(launch, fiber, startedAt)),
    )
    yield* logInfo('action=dispatch outcome=started', {
      ...logContext(issue),
      action: 'dispatch',
      outcome: 'started',
    })
    return true
  })
