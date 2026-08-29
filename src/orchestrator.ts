import { resolve } from 'node:path'
import chokidar from 'chokidar'
import { Deferred, Effect, Fiber, Queue, type Scope } from 'effect'

import { runAgent, type AgentEvent } from './codex.js'
import { cyclicIssueIdentifiers, unresolvedBlockers } from './dependencies.js'
import { issueId, normalizeState, type Issue, type IssueId, type TokenTotals } from './domain.js'
import { AgentError, type WorkflowError } from './errors.js'
import { classifyPullRequest, type HandoffSnapshot } from './handoff.js'
import { loadHandoffs, saveHandoffs } from './handoff-store.js'
import { makeGitHubTracker, type TrackerAdapter } from './tracker.js'
import { sameTrackerProvider } from './tracker-config.js'
import { loadWorkflow, preflightWorkflow, renderPrompt, type Workflow } from './workflow.js'
import { makeWorkspaceManager, type WorkspaceManager } from './workspace.js'

type RunningEntry = {
  runId: number
  issue: Issue
  fiber: Fiber.RuntimeFiber<void>
  execution: ExecutionSnapshot
  attempt: number | null
  startedAt: Date
  lastEventAt: Date | null
  lastEvent: string | null
  processId: number | null
  tokens: Omit<TokenTotals, 'secondsRunning'>
}

type RetryEntry = {
  issue: Issue
  attempt: number
  dueAt: number
  error: string | null
  fiber: Fiber.RuntimeFiber<void>
}

type HandoffEntry = {
  issue: Issue
  execution: ExecutionSnapshot
  pullRequestNumber: number
  pullRequestUrl: string
  branchName: string
  state: HandoffSnapshot['state']
  headSha: string | null
  reason: string | null
  repairAttempts: number
  observedAt: Date
}

export type RunningSnapshot = Readonly<{
  issueId: IssueId
  identifier: string
  title: string
  url: string | null
  attempt: number | null
  startedAt: string
  lastEventAt: string | null
  lastEvent: string | null
  processId: number | null
  tokens: Omit<TokenTotals, 'secondsRunning'>
  workerHost: 'local'
}>

export type RetrySnapshot = Readonly<{
  issueId: IssueId
  identifier: string
  title: string
  url: string | null
  attempt: number
  dueAt: string
  error: string | null
  workerHost: 'local'
}>

export type OrchestratorSnapshot = Readonly<{
  generatedAt: string
  workflowPath: string
  effectiveWorkflow: Readonly<{
    fingerprint: string
    loadedAt: string
  }>
  workflowReloadError: Readonly<{
    message: string
    observedAt: string
  }> | null
  pollingIntervalMs: number
  maxConcurrentAgents: number
  counts: Readonly<{ running: number; retrying: number; completed: number }>
  pausedIssueNumbers: readonly number[]
  handoffs: readonly HandoffSnapshot[]
  running: readonly RunningSnapshot[]
  retrying: readonly RetrySnapshot[]
  totals: TokenTotals
  rateLimits: Readonly<Record<string, string | number | boolean | null>> | null
}>

export type OrchestratorControl = Readonly<{
  snapshot: Effect.Effect<OrchestratorSnapshot>
  refresh: Effect.Effect<void>
  setIssuePaused: (issueNumber: number, paused: boolean) => Effect.Effect<void>
}>

type OrchestratorEvent =
  | Readonly<{ _tag: 'Tick' }>
  | Readonly<{ _tag: 'AgentUpdate'; issueId: IssueId; update: AgentEvent }>
  | Readonly<{
      _tag: 'WorkerExited'
      issueId: IssueId
      runId: number
      attempt: number | null
      outcome: 'normal' | 'failed'
      error: string | null
    }>
  | Readonly<{ _tag: 'RetryDue'; issueId: IssueId; attempt: number }>
  | Readonly<{
      _tag: 'SetIssuePaused'
      issueNumber: number
      paused: boolean
      reply: Deferred.Deferred<void>
    }>

type RuntimeState = {
  running: Map<IssueId, RunningEntry>
  claimed: Set<IssueId>
  retries: Map<IssueId, RetryEntry>
  completed: Set<IssueId>
  pausedIssueNumbers: Set<number>
  handoffs: Map<IssueId, HandoffEntry>
  totals: TokenTotals
  rateLimits: Readonly<Record<string, string | number | boolean | null>> | null
}

type EffectiveWorkflow = Readonly<{
  workflow: Workflow
  tracker: TrackerAdapter
  workspaces: WorkspaceManager
  loadedAt: Date
}>

type ExecutionSnapshot = Readonly<{
  workflow: Workflow
  tracker: TrackerAdapter
  requiredLabels: readonly string[]
  activeStates: readonly string[]
  terminalStates: readonly string[]
  secretEnvironmentNames: readonly string[]
  workspaces: WorkspaceManager
  workspaceRoot: string
  prompt: string
  codex: Workflow['config']['codex']
  maxTurns: number
  stallTimeoutMs: number
}>

type WorkflowReloadError = Readonly<{
  message: string
  observedAt: Date
}>

type WorkflowWatcher = Readonly<{
  close: () => Promise<void>
}>

export type OrchestratorDependencies = Readonly<{
  loadWorkflow: typeof loadWorkflow
  makeTracker: (workflow: Workflow) => TrackerAdapter
  makeWorkspaces: (workflow: Workflow) => WorkspaceManager
  runAgent: typeof runAgent
  watchWorkflow: (path: string, onChange: () => void) => WorkflowWatcher
  /** Environment used by dispatch preflight validation of secret indirection. */
  environment: NodeJS.ProcessEnv
}>

const defaultDependencies: OrchestratorDependencies = {
  loadWorkflow,
  makeTracker: (workflow) => makeGitHubTracker(workflow.tracker.provider),
  makeWorkspaces: (workflow) =>
    makeWorkspaceManager(workflow.config.workspaceRoot, workflow.config.hooks),
  runAgent,
  watchWorkflow: (path, onChange) => {
    const watcher = chokidar.watch(path, {
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      ignoreInitial: true,
    })
    watcher.on('change', onChange)
    return watcher
  },
  environment: process.env,
}

const initialState = (): RuntimeState => ({
  running: new Map(),
  claimed: new Set(),
  retries: new Map(),
  completed: new Set(),
  pausedIssueNumbers: new Set(),
  handoffs: new Map(),
  totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
  rateLimits: null,
})

export const retryDelayMs = (attempt: number, maximumMs: number): number =>
  Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), maximumMs)

export const sortIssues = (issues: readonly Issue[]): readonly Issue[] =>
  [...issues].sort((left, right) => {
    const leftPriority =
      left.priority !== null && left.priority >= 1 && left.priority <= 4 ? left.priority : 5
    const rightPriority =
      right.priority !== null && right.priority >= 1 && right.priority <= 4 ? right.priority : 5
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority
    }
    const leftCreated = left.createdAt?.getTime() ?? Number.POSITIVE_INFINITY
    const rightCreated = right.createdAt?.getTime() ?? Number.POSITIVE_INFINITY
    if (leftCreated !== rightCreated) {
      return leftCreated - rightCreated
    }
    return left.identifier.localeCompare(right.identifier)
  })

const stateIsIn = (state: string, configured: readonly string[]): boolean => {
  const normalized = normalizeState(state)
  return configured.some((candidate) => normalizeState(candidate) === normalized)
}

export const issueIsRoutable = (issue: Issue, workflow: Workflow): boolean => {
  if (!issue.dispatchable) {
    return false
  }
  if (unresolvedBlockers(issue, workflow.config.tracker.terminalStates).length > 0) {
    return false
  }
  const labels = new Set(issue.labels.map((label) => label.trim().toLowerCase()))
  return workflow.config.tracker.requiredLabels.every(
    (label) => label.length > 0 && labels.has(label),
  )
}

const issueIsActiveInSnapshot = (issue: Issue, snapshot: ExecutionSnapshot): boolean =>
  stateIsIn(issue.state, snapshot.activeStates) && !stateIsIn(issue.state, snapshot.terminalStates)

const issueIsRoutableInSnapshot = (issue: Issue, snapshot: ExecutionSnapshot): boolean => {
  if (!issue.dispatchable) {
    return false
  }
  if (unresolvedBlockers(issue, snapshot.terminalStates).length > 0) {
    return false
  }
  const labels = new Set(issue.labels.map((label) => label.trim().toLowerCase()))
  return snapshot.requiredLabels.every((label) => label.length > 0 && labels.has(label))
}

const captureExecutionSnapshot = (
  effective: EffectiveWorkflow,
  prompt: string,
): ExecutionSnapshot =>
  Object.freeze({
    workflow: effective.workflow,
    tracker: effective.tracker,
    requiredLabels: Object.freeze([...effective.workflow.config.tracker.requiredLabels]),
    activeStates: Object.freeze([...effective.workflow.config.tracker.activeStates]),
    terminalStates: Object.freeze([...effective.workflow.config.tracker.terminalStates]),
    secretEnvironmentNames: Object.freeze([...effective.tracker.secretEnvironmentNames]),
    workspaces: effective.workspaces,
    workspaceRoot: effective.workflow.config.workspaceRoot,
    prompt,
    codex: Object.freeze({ ...effective.workflow.config.codex }),
    maxTurns: effective.workflow.config.agent.maxTurns,
    stallTimeoutMs: effective.workflow.config.codex.stallTimeoutMs,
  })

const issueIsActive = (issue: Issue, workflow: Workflow): boolean =>
  stateIsIn(issue.state, workflow.config.tracker.activeStates) &&
  !stateIsIn(issue.state, workflow.config.tracker.terminalStates)

const stateHasSlot = (issue: Issue, state: RuntimeState, workflow: Workflow): boolean => {
  if (state.running.size >= workflow.config.agent.maxConcurrentAgents) {
    return false
  }
  const normalized = normalizeState(issue.state)
  const limit =
    workflow.config.agent.maxConcurrentAgentsByState.get(normalized) ??
    workflow.config.agent.maxConcurrentAgents
  const used = [...state.running.values()].filter(
    (entry) => normalizeState(entry.issue.state) === normalized,
  ).length
  return used < limit
}

const logContext = (issue: Issue): Readonly<Record<string, string>> => ({
  issue_id: issue.id,
  issue_identifier: issue.identifier,
})

const identifierIssueNumber = (identifier: string): number | null => {
  const match = /#(\d+)$/u.exec(identifier)
  return match?.[1] === undefined ? null : Number(match[1])
}

export const startOrchestrator = (
  selectedWorkflowPath = resolve(process.cwd(), 'WORKFLOW.md'),
  dependencies: OrchestratorDependencies = defaultDependencies,
): Effect.Effect<OrchestratorControl, WorkflowError, Scope.Scope> =>
  Effect.gen(function* () {
    const makeEffectiveWorkflow = (workflow: Workflow): EffectiveWorkflow => ({
      workflow,
      tracker: dependencies.makeTracker(workflow),
      workspaces: dependencies.makeWorkspaces(workflow),
      loadedAt: new Date(),
    })
    let lastKnownGood = makeEffectiveWorkflow(
      yield* dependencies.loadWorkflow(selectedWorkflowPath),
    )
    const cleanupTerminalWorkspaces = (effective: EffectiveWorkflow): Effect.Effect<void> =>
      Effect.gen(function* () {
        const terminalGroups = yield* Effect.forEach(
          effective.workflow.config.tracker.terminalStates,
          (state) =>
            effective.tracker
              .fetchIssuesByStates([state], null, { hydrateDependencies: false })
              .pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    Effect.logWarning('startup terminal issue fetch failed; continuing', {
                      state,
                      error: error.message,
                    }).pipe(Effect.as<readonly Issue[]>([])),
                  onSuccess: (issues) => Effect.succeed(issues),
                }),
              ),
          { concurrency: 1 },
        )
        const terminalIssues = [
          ...new Map(terminalGroups.flat().map((issue) => [issue.id, issue])).values(),
        ]
        for (const issue of terminalIssues) {
          const workspaceExists = yield* effective.workspaces.exists(issue.identifier).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.logWarning('startup workspace inspection failed; continuing', {
                  ...logContext(issue),
                  error: error.message,
                }).pipe(Effect.as<boolean | null>(null)),
              onSuccess: (exists) => Effect.succeed<boolean | null>(exists),
            }),
          )
          if (workspaceExists !== true) {
            continue
          }
          const refreshed = yield* effective.tracker
            .fetchIssuesByIds([issue.id], { hydrateDependencies: false })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.logWarning('startup terminal issue recheck failed; continuing', {
                    ...logContext(issue),
                    error: error.message,
                  }).pipe(Effect.as<readonly Issue[] | null>(null)),
                onSuccess: (issues) => Effect.succeed<readonly Issue[] | null>(issues),
              }),
            )
          const current = refreshed?.find((candidate) => candidate.id === issue.id)
          if (
            current === undefined ||
            !stateIsIn(current.state, effective.workflow.config.tracker.terminalStates)
          ) {
            continue
          }
          yield* effective.workspaces.remove(current.identifier).pipe(
            Effect.catchAll((error) =>
              Effect.logWarning('startup terminal workspace cleanup failed; continuing', {
                ...logContext(current),
                error: error.message,
              }),
            ),
          )
        }
      })
    yield* cleanupTerminalWorkspaces(lastKnownGood)
    let workflowReloadError: WorkflowReloadError | null = null
    const state = initialState()
    const handoffStorePath = resolve(
      lastKnownGood.workflow.config.workspaceRoot,
      '.symphony',
      'handoffs.json',
    )
    let pendingRestoredHandoffs = yield* loadHandoffs(handoffStorePath)
    for (const pending of pendingRestoredHandoffs) {
      state.claimed.add(issueId(pending.issueId))
    }
    const handoffSnapshots = (): readonly HandoffSnapshot[] => [
      ...pendingRestoredHandoffs,
      ...[...state.handoffs.values()].map((handoff) => ({
        issueId: handoff.issue.id,
        identifier: handoff.issue.identifier,
        pullRequestUrl: handoff.pullRequestUrl,
        branchName: handoff.branchName,
        state: handoff.state,
        headSha: handoff.headSha,
        reason: handoff.reason,
        repairAttempts: handoff.repairAttempts,
        observedAt: handoff.observedAt.toISOString(),
      })),
    ]
    const persistHandoffs = (): Effect.Effect<void> =>
      saveHandoffs(handoffStorePath, handoffSnapshots())
    const hydrateRestoredHandoffs = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (pendingRestoredHandoffs.length === 0) {
          return
        }
        const fetched = yield* lastKnownGood.tracker
          .fetchIssuesByIds(pendingRestoredHandoffs.map((handoff) => issueId(handoff.issueId)))
          .pipe(
            Effect.match({
              onFailure: () => null,
              onSuccess: (issues) => issues,
            }),
          )
        if (fetched === null) {
          return
        }
        const hydrated = new Set<string>()
        for (const restored of pendingRestoredHandoffs) {
          const issue = fetched.find((candidate) => candidate.id === restored.issueId)
          const numberMatch = /\/pulls?\/(\d+)(?:\/)?$/u.exec(restored.pullRequestUrl)
          const pullRequestNumber = Number(numberMatch?.[1])
          if (issue === undefined || !Number.isSafeInteger(pullRequestNumber)) {
            continue
          }
          state.handoffs.set(issue.id, {
            issue,
            execution: captureExecutionSnapshot(lastKnownGood, ''),
            pullRequestNumber,
            pullRequestUrl: restored.pullRequestUrl,
            branchName: restored.branchName,
            state: restored.state,
            headSha: restored.headSha,
            reason: restored.reason,
            repairAttempts: restored.repairAttempts,
            observedAt: new Date(restored.observedAt),
          })
          state.claimed.add(issue.id)
          hydrated.add(restored.issueId)
        }
        pendingRestoredHandoffs = pendingRestoredHandoffs.filter(
          (handoff) => !hydrated.has(handoff.issueId),
        )
      })
    yield* hydrateRestoredHandoffs()
    const mailbox = yield* Queue.unbounded<OrchestratorEvent>()
    let nextRunId = 1
    let tickQueued = false
    let pollRunning = false
    let followUpRequested = false
    let pollTimer: Fiber.RuntimeFiber<void> | null = null
    const currentRefreshWaiters: Deferred.Deferred<void>[] = []
    const nextRefreshWaiters: Deferred.Deferred<void>[] = []

    const offerFromCallback = (event: OrchestratorEvent): void => {
      Effect.runFork(Queue.offer(mailbox, event))
    }

    const requestTick = (source: 'startup' | 'timer' | 'change'): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (tickQueued) {
          if (pollRunning && source === 'change') {
            followUpRequested = true
          }
          return Effect.void
        }
        tickQueued = true
        return Queue.offer(mailbox, { _tag: 'Tick' }).pipe(Effect.asVoid)
      })

    const requestRefresh = Effect.suspend(() =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<void>()
        if (pollRunning) {
          nextRefreshWaiters.push(reply)
        } else {
          currentRefreshWaiters.push(reply)
        }
        yield* requestTick('change')
        yield* Deferred.await(reply)
      }),
    )

    const watcher = yield* Effect.acquireRelease(
      Effect.sync(() =>
        dependencies.watchWorkflow(selectedWorkflowPath, () => {
          Effect.runFork(requestTick('change'))
        }),
      ),
      (instance) => Effect.promise(() => instance.close()),
    )
    void watcher

    const scheduleNextTick = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        if (pollTimer !== null) {
          yield* Fiber.interrupt(pollTimer)
        }
        const intervalMs = lastKnownGood.workflow.config.pollingIntervalMs
        pollTimer = yield* Effect.forkScoped(
          Effect.sleep(intervalMs).pipe(Effect.zipRight(requestTick('timer')), Effect.asVoid),
        )
      })

    const scheduleRetry = (
      issue: Issue,
      attempt: number,
      error: string | null,
      continuation: boolean,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const existing = state.retries.get(issue.id)
        if (existing !== undefined) {
          yield* Fiber.interrupt(existing.fiber)
        }
        const delay = continuation
          ? 1_000
          : retryDelayMs(attempt, lastKnownGood.workflow.config.agent.maxRetryBackoffMs)
        const dueAt = Date.now() + delay
        const fiber = yield* Effect.forkScoped(
          Effect.sleep(delay).pipe(
            Effect.zipRight(Queue.offer(mailbox, { _tag: 'RetryDue', issueId: issue.id, attempt })),
            Effect.asVoid,
          ),
        )
        state.retries.set(issue.id, { issue, attempt, dueAt, error, fiber })
        state.claimed.add(issue.id)
        yield* Effect.logInfo('retry scheduled', {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          attempt,
          due_at: new Date(dueAt).toISOString(),
          error,
        })
      })

    /**
     * Re-runs dispatch preflight validation and, when the referenced secret has been rotated in the
     * environment without the workflow file changing, rebuilds the tracker from the revalidated
     * provider so no later request uses the superseded credential.
     */
    const revalidateCredentials = (
      effective: EffectiveWorkflow,
    ): Effect.Effect<EffectiveWorkflow, WorkflowError> =>
      preflightWorkflow(effective.workflow, dependencies.environment).pipe(
        Effect.map((validated) => {
          if (sameTrackerProvider(validated, effective.workflow.tracker)) {
            return effective
          }
          const workflow: Workflow = { ...effective.workflow, tracker: validated }
          return { ...effective, workflow, tracker: dependencies.makeTracker(workflow) }
        }),
      )

    /** Moves live workers and handoffs off a superseded tracker instance. */
    const adoptTracker = (previous: TrackerAdapter, next: TrackerAdapter): void => {
      for (const entry of [...state.running.values(), ...state.handoffs.values()]) {
        if (entry.execution.tracker === previous) {
          entry.execution = Object.freeze({
            ...entry.execution,
            tracker: next,
            secretEnvironmentNames: Object.freeze([...next.secretEnvironmentNames]),
          })
        }
      }
    }

    const dispatch = (
      issue: Issue,
      attempt: number | null,
      effectiveOverride?: EffectiveWorkflow,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        if (state.running.has(issue.id)) {
          return
        }
        state.claimed.add(issue.id)
        const retry = state.retries.get(issue.id)
        if (retry !== undefined) {
          yield* Fiber.interrupt(retry.fiber)
          state.retries.delete(issue.id)
        }

        const base = effectiveOverride ?? lastKnownGood
        const preflight = yield* revalidateCredentials(base).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: 'Failed' as const, error }),
            onSuccess: (value) => ({ _tag: 'Succeeded' as const, value }),
          }),
        )
        if (preflight._tag === 'Failed') {
          yield* Effect.logError('dispatch preflight failed', {
            ...logContext(issue),
            error: preflight.error.message,
          })
          yield* scheduleRetry(issue, (attempt ?? 0) + 1, preflight.error.message, false)
          return
        }
        const effective = preflight.value
        if (effectiveOverride === undefined && effective !== lastKnownGood) {
          const previousTracker = lastKnownGood.tracker
          lastKnownGood = effective
          adoptTracker(previousTracker, effective.tracker)
        }
        const renderedPrompt = yield* renderPrompt(effective.workflow, issue, attempt).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: 'Failed' as const, error }),
            onSuccess: (prompt) => ({ _tag: 'Succeeded' as const, prompt }),
          }),
        )
        if (renderedPrompt._tag === 'Failed') {
          yield* scheduleRetry(issue, (attempt ?? 0) + 1, renderedPrompt.error.message, false)
          return
        }
        const execution = captureExecutionSnapshot(effective, renderedPrompt.prompt)
        const runId = nextRunId
        nextRunId += 1
        const refreshIssue = (): Effect.Effect<Issue | null, AgentError> => {
          const running = state.running.get(issue.id)
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
                dependencies.runAgent({
                  issue,
                  workspace,
                  workspaceRoot: execution.workspaceRoot,
                  config: execution.codex,
                  prompt: execution.prompt,
                  maxTurns: execution.maxTurns,
                  secretEnvironmentNames: execution.secretEnvironmentNames,
                  refreshIssue,
                  isRoutable: (refreshed) =>
                    issueIsActiveInSnapshot(refreshed, execution) &&
                    issueIsRoutableInSnapshot(refreshed, execution),
                  onEvent: (update) => {
                    offerFromCallback({ _tag: 'AgentUpdate', issueId: issue.id, update })
                  },
                }),
              ),
              Effect.ensuring(execution.workspaces.afterRun(workspace)),
            ),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Queue.offer(mailbox, {
                _tag: 'WorkerExited',
                issueId: issue.id,
                runId,
                attempt,
                outcome: 'failed',
                error: error.message,
              }).pipe(Effect.asVoid),
            onSuccess: () =>
              Queue.offer(mailbox, {
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
        state.running.set(issue.id, {
          runId,
          issue,
          fiber,
          execution,
          attempt,
          startedAt: new Date(),
          lastEventAt: null,
          lastEvent: null,
          processId: null,
          tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        })
        yield* Effect.logInfo('worker dispatched', logContext(issue))
      })

    const reconcileHandoffs = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        for (const [id, handoff] of state.handoffs) {
          const handoffIssueNumber = identifierIssueNumber(handoff.issue.identifier)
          if (handoffIssueNumber !== null && state.pausedIssueNumbers.has(handoffIssueNumber)) {
            continue
          }
          const inspected = yield* handoff.execution.tracker
            .inspectPullRequest(handoff.pullRequestNumber)
            .pipe(
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
          const unresolvedThreadIds = inspected.observation.reviewThreads
            .filter((thread) => !thread.resolved)
            .map((thread) => thread.id)
          const repairedHeadIsVerified =
            handoff.repairAttempts > 0 &&
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
            const resolved = yield* handoff.execution.tracker
              .resolveReviewThreads(unresolvedThreadIds)
              .pipe(
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
            state.handoffs.delete(id)
            state.completed.add(id)
            state.claimed.delete(id)
            continue
          }
          if (disposition.state === 'ready_to_merge') {
            handoff.state = 'merging'
            const merged = yield* handoff.execution.tracker
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
            state.handoffs.delete(id)
            state.completed.add(id)
            state.claimed.delete(id)
            yield* Effect.logInfo('pull request merged', {
              ...logContext(handoff.issue),
              pull_request_url: handoff.pullRequestUrl,
              merge_commit_sha: merged.sha,
            })
            continue
          }
          if (disposition.state === 'repair_needed') {
            if (handoff.repairAttempts >= 3) {
              handoff.state = 'intervention_required'
              handoff.reason = `Repair limit reached. ${disposition.reason}`
              continue
            }
            state.handoffs.delete(id)
            const repairIssue: Issue = {
              ...handoff.issue,
              description: `${handoff.issue.description ?? ''}\n\n## Pull request repair\n\nPR: ${handoff.pullRequestUrl}\nHead: ${inspected.observation.headSha}\n\n${disposition.reason}`,
            }
            if (!stateHasSlot(repairIssue, state, handoff.execution.workflow)) {
              handoff.reason = `Waiting for an agent slot. ${disposition.reason}`
              continue
            }
            const effective: EffectiveWorkflow = {
              workflow: handoff.execution.workflow,
              tracker: handoff.execution.tracker,
              workspaces: handoff.execution.workspaces,
              loadedAt: handoff.observedAt,
            }
            yield* dispatch(repairIssue, handoff.repairAttempts + 1, effective)
          }
        }
        yield* persistHandoffs()
      })

    const endRunning = (id: IssueId, expectedRunId: number | null): RunningEntry | null => {
      const entry = state.running.get(id)
      if (entry === undefined || (expectedRunId !== null && entry.runId !== expectedRunId)) {
        return null
      }
      state.running.delete(id)
      return entry
    }

    const accountEndedRuntime = (entry: RunningEntry, now: number): void => {
      const seconds = Math.max(now - entry.startedAt.getTime(), 0) / 1_000
      state.totals = {
        inputTokens: state.totals.inputTokens + entry.tokens.inputTokens,
        outputTokens: state.totals.outputTokens + entry.tokens.outputTokens,
        totalTokens: state.totals.totalTokens + entry.tokens.totalTokens,
        secondsRunning: state.totals.secondsRunning + seconds,
      }
    }

    const cancelRunning = (
      id: IssueId,
      cleanupWorkspace: boolean,
    ): Effect.Effect<RunningEntry | null, never> =>
      Effect.gen(function* () {
        const entry = endRunning(id, null)
        if (entry === null) {
          return null
        }
        accountEndedRuntime(entry, Date.now())
        state.claimed.delete(id)
        yield* Fiber.interrupt(entry.fiber)
        if (cleanupWorkspace) {
          yield* entry.execution.workspaces.remove(entry.issue.identifier).pipe(
            Effect.catchAll((error) =>
              Effect.logWarning('terminal workspace cleanup failed', {
                ...logContext(entry.issue),
                error: error.message,
              }),
            ),
          )
        }
        return entry
      })

    const reconcile = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        if (state.running.size === 0) {
          return
        }
        const now = Date.now()
        for (const [id, entry] of state.running) {
          const execution = entry.execution
          const stallTimeout = execution.stallTimeoutMs
          const activeAt = entry.lastEventAt?.getTime() ?? entry.startedAt.getTime()
          if (stallTimeout > 0 && now - activeAt > stallTimeout) {
            const ended = yield* cancelRunning(id, false)
            if (ended !== null) {
              yield* scheduleRetry(ended.issue, (ended.attempt ?? 0) + 1, 'agent stalled', false)
            }
          }
        }
        if (state.running.size === 0) {
          return
        }
        for (const [id, entry] of state.running) {
          const execution = entry.execution
          const refreshResult = yield* execution.tracker.fetchIssuesByIds([id]).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: 'Failed' as const, error }),
              onSuccess: (issues) => ({ _tag: 'Succeeded' as const, issues }),
            }),
          )
          if (refreshResult._tag === 'Failed') {
            yield* Effect.logWarning('reconciliation failed; keeping worker running', {
              ...logContext(entry.issue),
              error: refreshResult.error.message,
            })
            continue
          }
          const issue = refreshResult.issues.find((candidate) => candidate.id === id)
          if (issue === undefined) {
            yield* cancelRunning(id, false)
            continue
          }
          const terminal = stateIsIn(issue.state, execution.terminalStates)
          if (terminal || !issueIsActiveInSnapshot(issue, execution)) {
            yield* cancelRunning(id, terminal)
          } else {
            entry.issue = issue
          }
        }
      })

    const poll = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const revalidated = yield* revalidateCredentials(lastKnownGood).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: 'Failed' as const, error }),
            onSuccess: (value) => ({ _tag: 'Succeeded' as const, value }),
          }),
        )
        if (revalidated._tag === 'Failed') {
          yield* Effect.logError(
            'tracker credential validation failed; retaining last known good',
            {
              error: revalidated.error.message,
              effective_fingerprint: lastKnownGood.workflow.fingerprint,
            },
          )
        } else if (revalidated.value !== lastKnownGood) {
          const previousTracker = lastKnownGood.tracker
          lastKnownGood = revalidated.value
          adoptTracker(previousTracker, revalidated.value.tracker)
          yield* Effect.logInfo('tracker credential refreshed from the environment', {
            tracker_kind: revalidated.value.workflow.tracker.kind,
            secret_environment_name:
              revalidated.value.workflow.tracker.provider.tokenEnvironmentName,
          })
        }
        yield* hydrateRestoredHandoffs()
        yield* reconcileHandoffs()
        yield* reconcile()
        const reloaded = yield* dependencies.loadWorkflow(selectedWorkflowPath).pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              workflowReloadError = { message: error.message, observedAt: new Date() }
              return Effect.logError('workflow validation failed; retaining last known good', {
                error: error.message,
                effective_fingerprint: lastKnownGood.workflow.fingerprint,
              }).pipe(Effect.as<Workflow | null>(null))
            },
            onSuccess: (loaded) => Effect.succeed<Workflow | null>(loaded),
          }),
        )
        if (reloaded !== null) {
          workflowReloadError = null
          if (reloaded.fingerprint !== lastKnownGood.workflow.fingerprint) {
            lastKnownGood = makeEffectiveWorkflow(reloaded)
            yield* Effect.logInfo('workflow reloaded', {
              path: reloaded.path,
              fingerprint: reloaded.fingerprint,
            })
          }
        }
        const effective = lastKnownGood
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
              Effect.logError('candidate fetch failed', { error: error.message }).pipe(
                Effect.as<readonly Issue[]>([]),
              ),
            ),
          )
        const cyclicIdentifiers = cyclicIssueIdentifiers(candidates)
        for (const issue of sortIssues(candidates)) {
          if (
            state.claimed.has(issue.id) ||
            (identifierIssueNumber(issue.identifier) !== null &&
              state.pausedIssueNumbers.has(identifierIssueNumber(issue.identifier) ?? -1)) ||
            cyclicIdentifiers.has(issue.identifier) ||
            !issueIsActive(issue, effective.workflow) ||
            !issueIsRoutable(issue, effective.workflow) ||
            !stateHasSlot(issue, state, effective.workflow)
          ) {
            continue
          }
          yield* dispatch(issue, null)
        }
      })

    const createSnapshot = (): OrchestratorSnapshot => {
      const now = Date.now()
      const effective = lastKnownGood
      const activeSeconds = [...state.running.values()].reduce(
        (total, entry) => total + (now - entry.startedAt.getTime()) / 1_000,
        0,
      )
      return {
        generatedAt: new Date(now).toISOString(),
        workflowPath: selectedWorkflowPath,
        effectiveWorkflow: {
          fingerprint: effective.workflow.fingerprint,
          loadedAt: effective.loadedAt.toISOString(),
        },
        workflowReloadError:
          workflowReloadError === null
            ? null
            : {
                message: workflowReloadError.message,
                observedAt: workflowReloadError.observedAt.toISOString(),
              },
        pollingIntervalMs: effective.workflow.config.pollingIntervalMs,
        maxConcurrentAgents: effective.workflow.config.agent.maxConcurrentAgents,
        counts: {
          running: state.running.size,
          retrying: state.retries.size,
          completed: state.completed.size,
        },
        pausedIssueNumbers: [...state.pausedIssueNumbers].sort((left, right) => left - right),
        handoffs: handoffSnapshots(),
        running: [...state.running.values()].map((entry) => ({
          issueId: entry.issue.id,
          identifier: entry.issue.identifier,
          title: entry.issue.title,
          url: entry.issue.url,
          attempt: entry.attempt,
          startedAt: entry.startedAt.toISOString(),
          lastEventAt: entry.lastEventAt?.toISOString() ?? null,
          lastEvent: entry.lastEvent,
          processId: entry.processId,
          tokens: entry.tokens,
          workerHost: 'local',
        })),
        retrying: [...state.retries.values()].map((entry) => ({
          issueId: entry.issue.id,
          identifier: entry.issue.identifier,
          title: entry.issue.title,
          url: entry.issue.url,
          attempt: entry.attempt,
          dueAt: new Date(entry.dueAt).toISOString(),
          error: entry.error,
          workerHost: 'local',
        })),
        totals: {
          ...state.totals,
          secondsRunning: state.totals.secondsRunning + activeSeconds,
        },
        rateLimits: state.rateLimits,
      }
    }

    const eventLoop = Effect.gen(function* () {
      for (;;) {
        const event = yield* Queue.take(mailbox)
        switch (event._tag) {
          case 'Tick': {
            pollRunning = true
            yield* poll()
            const waiters = currentRefreshWaiters.splice(0)
            yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), {
              discard: true,
            })
            if (followUpRequested) {
              followUpRequested = false
              currentRefreshWaiters.push(...nextRefreshWaiters.splice(0))
              pollRunning = false
              yield* Queue.offer(mailbox, { _tag: 'Tick' })
              break
            }
            pollRunning = false
            tickQueued = false
            yield* scheduleNextTick()
            break
          }
          case 'AgentUpdate': {
            const entry = state.running.get(event.issueId)
            if (entry !== undefined) {
              entry.lastEvent = event.update.event
              entry.lastEventAt = event.update.timestamp
              entry.processId = event.update.processId
              if (event.update.usage !== null) {
                entry.tokens = event.update.usage
              }
            }
            break
          }
          case 'WorkerExited': {
            const entry = endRunning(event.issueId, event.runId)
            if (entry === null) {
              break
            }
            accountEndedRuntime(entry, Date.now())
            if (event.outcome === 'normal') {
              const handoff = yield* entry.execution.tracker
                .handoffCompletedWork(entry.issue, entry.execution.requiredLabels)
                .pipe(
                  Effect.match({
                    onFailure: (error) => ({ _tag: 'Failed' as const, error }),
                    onSuccess: (result) => ({ _tag: 'Succeeded' as const, result }),
                  }),
                )
              if (handoff._tag === 'Failed') {
                yield* scheduleRetry(
                  entry.issue,
                  (event.attempt ?? 0) + 1,
                  `handoff failed: ${handoff.error.message}`,
                  false,
                )
                break
              }
              if (handoff.result._tag === 'NoBranch') {
                yield* scheduleRetry(entry.issue, 1, null, true)
                break
              }
              state.handoffs.set(event.issueId, {
                issue: entry.issue,
                execution: entry.execution,
                pullRequestNumber: handoff.result.pullRequestNumber,
                pullRequestUrl: handoff.result.pullRequestUrl,
                branchName: handoff.result.branchName,
                state: 'awaiting_checks',
                headSha: null,
                reason: 'Awaiting the first protected-branch observation',
                repairAttempts: event.attempt ?? 0,
                observedAt: new Date(),
              })
              yield* persistHandoffs()
              yield* Effect.logInfo('worker handed off pull request', {
                ...logContext(entry.issue),
                branch: handoff.result.branchName,
                pull_request_url: handoff.result.pullRequestUrl,
              })
            } else {
              yield* scheduleRetry(entry.issue, (event.attempt ?? 0) + 1, event.error, false)
            }
            break
          }
          case 'RetryDue': {
            const retry = state.retries.get(event.issueId)
            if (retry?.attempt !== event.attempt) {
              break
            }
            state.retries.delete(event.issueId)
            const effective = lastKnownGood
            const refreshResult = yield* effective.tracker.fetchIssuesByIds([event.issueId]).pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: 'Failed' as const, error }),
                onSuccess: (issues) => ({ _tag: 'Succeeded' as const, issues }),
              }),
            )
            if (refreshResult._tag === 'Failed') {
              yield* scheduleRetry(
                retry.issue,
                event.attempt + 1,
                `retry refresh failed: ${refreshResult.error.message}`,
                false,
              )
              break
            }
            const issue = refreshResult.issues.find((candidate) => candidate.id === event.issueId)
            if (issue === undefined) {
              state.claimed.delete(event.issueId)
              break
            }
            if (stateIsIn(issue.state, effective.workflow.config.tracker.terminalStates)) {
              yield* effective.workspaces.remove(issue.identifier).pipe(
                Effect.catchAll((error) =>
                  Effect.logWarning('terminal workspace cleanup failed', {
                    ...logContext(issue),
                    error: error.message,
                  }),
                ),
              )
              state.claimed.delete(event.issueId)
              break
            }
            if (
              !issueIsActive(issue, effective.workflow) ||
              !issueIsRoutable(issue, effective.workflow)
            ) {
              state.claimed.delete(event.issueId)
              break
            }
            if (!stateHasSlot(issue, state, effective.workflow)) {
              yield* scheduleRetry(
                issue,
                event.attempt + 1,
                'no available orchestrator slots',
                false,
              )
              break
            }
            yield* dispatch(issue, event.attempt)
            break
          }
          case 'SetIssuePaused': {
            if (event.paused) {
              state.pausedIssueNumbers.add(event.issueNumber)
              for (const [id, entry] of state.running) {
                if (identifierIssueNumber(entry.issue.identifier) === event.issueNumber) {
                  yield* cancelRunning(id, false)
                }
              }
              for (const [id, retry] of state.retries) {
                if (identifierIssueNumber(retry.issue.identifier) === event.issueNumber) {
                  yield* Fiber.interrupt(retry.fiber)
                  state.retries.delete(id)
                  state.claimed.delete(id)
                }
              }
            } else {
              state.pausedIssueNumbers.delete(event.issueNumber)
            }
            yield* Deferred.succeed(event.reply, undefined)
            break
          }
        }
      }
    })

    yield* Effect.forkScoped(eventLoop)
    yield* requestTick('startup')

    return {
      snapshot: Effect.sync(createSnapshot),
      refresh: requestRefresh,
      setIssuePaused: (issueNumber, paused) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<void>()
          yield* Queue.offer(mailbox, { _tag: 'SetIssuePaused', issueNumber, paused, reply })
          yield* Deferred.await(reply)
        }),
    }
  })

export const runOrchestrator = (
  selectedWorkflowPath = resolve(process.cwd(), 'WORKFLOW.md'),
): Effect.Effect<void, WorkflowError> =>
  Effect.scoped(startOrchestrator(selectedWorkflowPath).pipe(Effect.zipRight(Effect.never)))
