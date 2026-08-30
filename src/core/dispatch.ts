import { Effect, Fiber, Queue, type Scope } from 'effect'

import { renderPrompt } from '../config/workflow.js'
import type { Issue } from '../domain/domain.js'
import { AgentError } from '../errors.js'
import { unsupportedHostTool, type HostToolSession } from '../host-tools.js'
import { mergeSparseObject, toJsonObject } from '../support/json.js'
import { logError, logInfo } from '../support/logging.js'
import type { EffectiveWorkflow, ExecutionSnapshot, OrchestratorContext } from './runtime.js'
import { adoptPorts, revalidateCredentials } from './workflow-reload.js'

export const makeHostToolSession = (
  execution: Pick<ExecutionSnapshot, 'tracker' | 'codeReview'>,
  issue: Issue,
): HostToolSession => {
  const codeReview = execution.codeReview
  return Object.freeze({
    specs: Object.freeze([...execution.tracker.toolSpecs, ...(codeReview?.toolSpecs ?? [])]),
    context: Object.freeze({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      nativeRef:
        issue.nativeRef === null ? null : toJsonObject(issue.nativeRef, 'session.issue.nativeRef'),
    }),
    execute: (name, argumentsValue, context) => {
      if (execution.tracker.toolSpecs.some((spec) => spec.name === name)) {
        return execution.tracker.executeTool(name, argumentsValue, context)
      }
      if (codeReview?.toolSpecs.some((spec) => spec.name === name) === true) {
        return codeReview.executeTool(name, argumentsValue, context)
      }
      return unsupportedHostTool(name)
    },
  })
}

export const dispatch = (
  context: OrchestratorContext,
  issue: Issue,
  attempt: number | null,
  effectiveOverride?: EffectiveWorkflow,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (context.state.running.has(issue.id)) {
      return
    }
    context.state.claimed.add(issue.id)
    const retry = context.state.retries.get(issue.id)
    if (retry !== undefined) {
      yield* Fiber.interrupt(retry.fiber)
      context.state.retries.delete(issue.id)
    }

    const base = effectiveOverride ?? context.lastKnownGood
    // Opened before preflight, not after the worker starts: a dispatch that fails validation or
    // prompt rendering schedules a retry, and that retry's published link has to resolve to the
    // reason it failed rather than to "no active session".
    context.detailRecordValue(issue, attempt, base.workflow.config.tracker.requiredLabels)
    const preflight = yield* revalidateCredentials(context, base).pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: 'Failed' as const, error }),
        onSuccess: (value) => ({ _tag: 'Succeeded' as const, value }),
      }),
    )
    if (preflight._tag === 'Failed') {
      yield* logError('action=dispatch outcome=failed', {
        ...context.logContextValue(issue),
        action: 'dispatch',
        outcome: 'failed',
        error: preflight.error.message,
      })
      yield* context.scheduleRetryEffect(issue, (attempt ?? 0) + 1, preflight.error.message, false)
      return
    }
    const effective = preflight.value
    if (effectiveOverride === undefined && effective !== context.lastKnownGood) {
      const previous = context.lastKnownGood
      context.lastKnownGood = effective
      adoptPorts(context, previous, effective)
    }
    const renderedPrompt = yield* renderPrompt(effective.workflow, issue, attempt).pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: 'Failed' as const, error }),
        onSuccess: (prompt) => ({ _tag: 'Succeeded' as const, prompt }),
      }),
    )
    if (renderedPrompt._tag === 'Failed') {
      yield* context.scheduleRetryEffect(
        issue,
        (attempt ?? 0) + 1,
        renderedPrompt.error.message,
        false,
      )
      return
    }
    const execution = context.captureExecutionSnapshotValue(effective, renderedPrompt.prompt)
    const hostTools = makeHostToolSession(execution, issue)
    const runId = context.nextRunId
    context.nextRunId += 1
    const refreshIssue = (): Effect.Effect<Issue | null, AgentError> => {
      const running = context.state.running.get(issue.id)
      const tracker = running?.runId === runId ? running.execution.tracker : execution.tracker
      return tracker.fetchIssuesByIds([issue.id]).pipe(
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
    }

    const worker = execution.workspaces.create(issue.identifier).pipe(
      Effect.flatMap((workspace) =>
        execution.workspaces.beforeRun(workspace).pipe(
          Effect.zipRight(
            context.dependencies.runAgent({
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
                context.issueIsActiveInSnapshotValue(refreshed, execution) &&
                context.issueIsRoutableInSnapshotValue(refreshed, execution),
              onEvent: (update) => {
                if (update.usage !== null) {
                  const previous = context.pendingUsage.get(issue.id)
                  context.pendingUsage.set(issue.id, {
                    inputTokens: Math.max(previous?.inputTokens ?? 0, update.usage.inputTokens),
                    outputTokens: Math.max(previous?.outputTokens ?? 0, update.usage.outputTokens),
                    totalTokens: Math.max(previous?.totalTokens ?? 0, update.usage.totalTokens),
                  })
                }
                if (update.rateLimits !== null) {
                  context.pendingRateLimits = mergeSparseObject(
                    context.pendingRateLimits,
                    update.rateLimits,
                  )
                }
                if (
                  update.event === 'session_started' ||
                  update.event === 'turn_started' ||
                  update.event === 'turn/completed' ||
                  update.event === 'turn/failed' ||
                  update.event === 'turn/terminated'
                ) {
                  const queued = context.pendingLifecycle.get(issue.id) ?? []
                  queued.push(update)
                  context.pendingLifecycle.set(issue.id, queued)
                }
                context.offerFromCallbackValue({ _tag: 'AgentUpdate', issueId: issue.id, update })
              },
            }),
          ),
          Effect.ensuring(execution.workspaces.afterRun(workspace)),
        ),
      ),
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
    context.state.running.set(issue.id, {
      runId,
      issue,
      fiber,
      execution,
      attempt,
      startedAt: new Date(),
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
    yield* logInfo('action=dispatch outcome=started', {
      ...context.logContextValue(issue),
      action: 'dispatch',
      outcome: 'started',
    })
  })
