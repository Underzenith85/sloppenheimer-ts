import { Effect, Fiber, MutableRef, Option, Queue, Ref, type Scope } from 'effect'

import { renderPrompt } from '../config/workflow.js'
import type { Issue, Workspace } from '../domain/domain.js'
import { issueBranchName } from '../domain/handoff.js'
import { AgentError, type WorkspaceError } from '../domain/errors.js'
import { unsupportedHostTool, type HostToolSession } from '../domain/host-tools.js'
import { currentInstant } from '../support/clock.js'
import { logError, logInfo } from '../support/logging.js'
import { asSettled } from '../support/settled.js'
import type { AgentEvent } from '../telemetry.js'
import { captureExecutionSnapshot, issueIsActive, issueIsRoutable, logContext } from './policy.js'
import type { OrchestratorContext } from './runtime.js'
import type { EffectiveWorkflow, SessionPorts } from './state.js'
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
      yield* context.scheduleRetry(issue, (attempt ?? 0) + 1, preflight.error.message, false)
      return false
    }
    const effective = preflight.value
    if (effectiveOverride === undefined && effective !== base) {
      yield* installEffectiveWorkflow(context, base, effective)
    }
    const renderedPrompt = yield* renderPrompt(effective.workflow, issue, attempt).pipe(asSettled)
    if (renderedPrompt._tag === 'Failed') {
      yield* context.scheduleRetry(issue, (attempt ?? 0) + 1, renderedPrompt.error.message, false)
      return false
    }
    const execution = captureExecutionSnapshot(effective, renderedPrompt.value)
    const target: SourceControlTarget = sourceTarget ?? {
      _tag: 'Normal',
      branchName: issueBranchName(issue),
    }
    const runId = yield* Ref.modify(context.state, Transitions.takeRunId)
    /**
     * The ports this run reaches its provider through, in a cell the non-Effect world can read. A
     * host tool leaves Effect for a promise and so cannot take a turn on the state cell; adoption
     * writes the replacement here at the moment it rewrites the run's execution snapshot, which is
     * what keeps a live session current with the orchestrator.
     */
    const sessionPorts = MutableRef.make<SessionPorts>({
      tracker: execution.tracker,
      codeReview: execution.codeReview,
      sourceControl: execution.sourceControl,
    })
    const hostTools = makeHostToolSession(execution, issue, () => MutableRef.get(sessionPorts))
    const refreshIssue = (): Effect.Effect<Issue | null, AgentError> =>
      MutableRef.get(sessionPorts)
        .tracker.fetchIssuesByIds([issue.id])
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

    const runSession = (workspace: Workspace): Effect.Effect<void, AgentError | WorkspaceError> =>
      execution.workspaces.beforeRun(workspace).pipe(
        Effect.zipRight(
          context.ports.agentRunner.run({
            issue,
            workspace,
            workspaceRoot: execution.workspaceRoot,
            config: execution.agentRunner,
            prompt: execution.prompt,
            maxTurns: execution.maxTurns,
            secretEnvironmentNames: execution.secretEnvironmentNames,
            hostTools,
            refreshIssue,
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
    const worker = execution.workspaces.create(issue.identifier).pipe(
      Effect.flatMap((workspace) => {
        const sourceControl = MutableRef.get(sessionPorts).sourceControl
        if (sourceControl === null) {
          return runSession(workspace)
        }
        return sourceControl.prepare(issue, workspace, target).pipe(
          Effect.flatMap((prepared) =>
            runSession(workspace).pipe(
              Effect.zipRight(
                Effect.suspend(() => {
                  const publisher = MutableRef.get(sessionPorts).sourceControl ?? sourceControl
                  return publisher.publish(issue, prepared)
                }),
              ),
              Effect.tap((outcome) =>
                logInfo('host source-control publication completed', {
                  ...logContext(issue),
                  action: 'source_control_publish',
                  outcome: outcome._tag === 'Published' ? 'published' : 'no_changes',
                  branch: outcome.branchName,
                }),
              ),
              Effect.asVoid,
            ),
          ),
        )
      }),
      Effect.matchEffect({
        onFailure: (error) =>
          Queue.offer(context.mailbox, {
            _tag: 'WorkerExited',
            issueId: issue.id,
            runId,
            attempt,
            outcome: 'failed',
            error: error.message,
          }).pipe(Effect.asVoid),
        onSuccess: () =>
          Queue.offer(context.mailbox, {
            _tag: 'WorkerExited',
            issueId: issue.id,
            runId,
            attempt,
            outcome: 'normal',
            error: null,
          }).pipe(Effect.asVoid),
      }),
    )
    const fiber = yield* Effect.forkScoped(worker)
    const startedAt = yield* currentInstant
    yield* Ref.update(context.state, (current) =>
      Transitions.beginRun(current, {
        runId,
        issue,
        fiber,
        execution,
        sessionPorts,
        attempt,
        startedAt,
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
      }),
    )
    yield* logInfo('action=dispatch outcome=started', {
      ...logContext(issue),
      action: 'dispatch',
      outcome: 'started',
    })
    return true
  })
