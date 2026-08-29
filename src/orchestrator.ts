import { resolve } from 'node:path'
import chokidar from 'chokidar'
import { Deferred, Effect, Fiber, Queue, type Scope } from 'effect'

import { runAgent, type AgentEvent } from './codex.js'
import { normalizeState, type Issue, type IssueId, type TokenTotals } from './domain.js'
import { AgentError, type WorkflowError } from './errors.js'
import { makeGitHubTracker, type TrackerAdapter } from './tracker.js'
import { loadWorkflow, renderPrompt, type Workflow } from './workflow.js'
import { makeWorkspaceManager, type WorkspaceManager } from './workspace.js'

type RunningEntry = {
  issue: Issue
  fiber: Fiber.RuntimeFiber<void>
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
  pollingIntervalMs: number
  maxConcurrentAgents: number
  counts: Readonly<{ running: number; retrying: number; completed: number }>
  running: readonly RunningSnapshot[]
  retrying: readonly RetrySnapshot[]
  totals: TokenTotals
  rateLimits: Readonly<Record<string, string | number | boolean | null>> | null
}>

export type OrchestratorControl = Readonly<{
  snapshot: Effect.Effect<OrchestratorSnapshot>
  refresh: Effect.Effect<void>
}>

type OrchestratorEvent =
  | Readonly<{ _tag: 'Poll' }>
  | Readonly<{ _tag: 'WorkflowChanged' }>
  | Readonly<{ _tag: 'AgentUpdate'; issueId: IssueId; update: AgentEvent }>
  | Readonly<{
      _tag: 'WorkerExited'
      issueId: IssueId
      attempt: number | null
      outcome: 'normal' | 'failed'
      error: string | null
    }>
  | Readonly<{ _tag: 'RetryDue'; issueId: IssueId; attempt: number }>
  | Readonly<{
      _tag: 'Snapshot'
      reply: Deferred.Deferred<OrchestratorSnapshot>
    }>

type RuntimeState = {
  running: Map<IssueId, RunningEntry>
  claimed: Set<IssueId>
  retries: Map<IssueId, RetryEntry>
  completed: Set<IssueId>
  totals: TokenTotals
  rateLimits: Readonly<Record<string, string | number | boolean | null>> | null
}

const initialState = (): RuntimeState => ({
  running: new Map(),
  claimed: new Set(),
  retries: new Map(),
  completed: new Set(),
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
  const labels = new Set(issue.labels.map((label) => label.trim().toLowerCase()))
  return workflow.config.tracker.requiredLabels.every(
    (label) => label.length > 0 && labels.has(label),
  )
}

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

export const startOrchestrator = (
  selectedWorkflowPath = resolve(process.cwd(), 'WORKFLOW.md'),
): Effect.Effect<OrchestratorControl, WorkflowError, Scope.Scope> =>
  Effect.gen(function* () {
    let workflow = yield* loadWorkflow(selectedWorkflowPath)
    let tracker: TrackerAdapter = makeGitHubTracker(workflow.config.tracker.provider)
    let workspaces: WorkspaceManager = makeWorkspaceManager(
      workflow.config.workspaceRoot,
      workflow.config.hooks,
    )
    const state = initialState()
    const mailbox = yield* Queue.unbounded<OrchestratorEvent>()

    const offerFromCallback = (event: OrchestratorEvent): void => {
      Effect.runFork(Queue.offer(mailbox, event))
    }

    const watcher = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const instance = chokidar.watch(selectedWorkflowPath, {
          awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
          ignoreInitial: true,
        })
        instance.on('change', () => {
          offerFromCallback({ _tag: 'WorkflowChanged' })
        })
        return instance
      }),
      (instance) => Effect.promise(() => instance.close()),
    )
    void watcher

    yield* Effect.forkScoped(
      Effect.forever(
        Queue.offer(mailbox, { _tag: 'Poll' }).pipe(
          Effect.zipRight(Effect.sleep(workflow.config.pollingIntervalMs)),
        ),
      ),
    )

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
          : retryDelayMs(attempt, workflow.config.agent.maxRetryBackoffMs)
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

    const dispatch = (
      issue: Issue,
      attempt: number | null,
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

        const refreshIssue = (): Effect.Effect<Issue | null, AgentError> =>
          tracker.fetchIssuesByIds([issue.id]).pipe(
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

        const worker = workspaces.create(issue.identifier).pipe(
          Effect.flatMap((workspace) =>
            workspaces.beforeRun(workspace).pipe(
              Effect.zipRight(renderPrompt(workflow, issue, attempt)),
              Effect.flatMap((prompt) =>
                runAgent(
                  issue,
                  workspace,
                  workflow.config.codex,
                  prompt,
                  workflow.config.agent.maxTurns,
                  tracker.secretEnvironmentNames,
                  refreshIssue,
                  (refreshed) =>
                    issueIsActive(refreshed, workflow) && issueIsRoutable(refreshed, workflow),
                  (update) => {
                    offerFromCallback({ _tag: 'AgentUpdate', issueId: issue.id, update })
                  },
                ),
              ),
              Effect.ensuring(workspaces.afterRun(workspace)),
            ),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Queue.offer(mailbox, {
                _tag: 'WorkerExited',
                issueId: issue.id,
                attempt,
                outcome: 'failed',
                error: error.message,
              }).pipe(Effect.asVoid),
            onSuccess: () =>
              Queue.offer(mailbox, {
                _tag: 'WorkerExited',
                issueId: issue.id,
                attempt,
                outcome: 'normal',
                error: null,
              }).pipe(Effect.asVoid),
          }),
        )
        const fiber = yield* Effect.forkScoped(worker)
        state.running.set(issue.id, {
          issue,
          fiber,
          attempt,
          startedAt: new Date(),
          lastEventAt: null,
          lastEvent: null,
          processId: null,
          tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        })
        yield* Effect.logInfo('worker dispatched', logContext(issue))
      })

    const reconcile = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        if (state.running.size === 0) {
          return
        }
        const now = Date.now()
        const stallTimeout = workflow.config.codex.stallTimeoutMs
        for (const [id, entry] of state.running) {
          const activeAt = entry.lastEventAt?.getTime() ?? entry.startedAt.getTime()
          if (stallTimeout > 0 && now - activeAt > stallTimeout) {
            yield* Fiber.interrupt(entry.fiber)
            state.running.delete(id)
            yield* scheduleRetry(entry.issue, (entry.attempt ?? 0) + 1, 'agent stalled', false)
          }
        }
        if (state.running.size === 0) {
          return
        }
        const refreshed = yield* tracker
          .fetchIssuesByIds([...state.running.keys()])
          .pipe(
            Effect.catchAll((error) =>
              Effect.logWarning('reconciliation failed', { error: error.message }).pipe(
                Effect.as<readonly Issue[]>([]),
              ),
            ),
          )
        const byId = new Map(refreshed.map((issue) => [issue.id, issue] as const))
        for (const [id, entry] of state.running) {
          const issue = byId.get(id)
          if (issue === undefined) {
            continue
          }
          const terminal = stateIsIn(issue.state, workflow.config.tracker.terminalStates)
          if (terminal || !issueIsActive(issue, workflow) || !issueIsRoutable(issue, workflow)) {
            yield* Fiber.interrupt(entry.fiber)
            state.running.delete(id)
            state.claimed.delete(id)
            if (terminal) {
              yield* workspaces.remove(issue.identifier).pipe(
                Effect.catchAll((error) =>
                  Effect.logWarning('terminal workspace cleanup failed', {
                    ...logContext(issue),
                    error: error.message,
                  }),
                ),
              )
            }
          } else {
            entry.issue = issue
          }
        }
      })

    const poll = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        yield* reconcile()
        const reloaded = yield* loadWorkflow(selectedWorkflowPath).pipe(
          Effect.catchAll((error) =>
            Effect.logError('workflow validation failed', { error: error.message }).pipe(
              Effect.as<Workflow | null>(null),
            ),
          ),
        )
        if (reloaded === null) {
          return
        }
        if (reloaded.fingerprint !== workflow.fingerprint) {
          workflow = reloaded
          tracker = makeGitHubTracker(workflow.config.tracker.provider)
          workspaces = makeWorkspaceManager(workflow.config.workspaceRoot, workflow.config.hooks)
          yield* Effect.logInfo('workflow reloaded', { path: workflow.path })
        }
        const candidates = yield* tracker
          .fetchIssuesByStates(workflow.config.tracker.activeStates)
          .pipe(
            Effect.catchAll((error) =>
              Effect.logError('candidate fetch failed', { error: error.message }).pipe(
                Effect.as<readonly Issue[]>([]),
              ),
            ),
          )
        for (const issue of sortIssues(candidates)) {
          if (
            state.claimed.has(issue.id) ||
            !issueIsActive(issue, workflow) ||
            !issueIsRoutable(issue, workflow) ||
            !stateHasSlot(issue, state, workflow)
          ) {
            continue
          }
          yield* dispatch(issue, null)
        }
      })

    const createSnapshot = (): OrchestratorSnapshot => {
      const now = Date.now()
      const activeSeconds = [...state.running.values()].reduce(
        (total, entry) => total + (now - entry.startedAt.getTime()) / 1_000,
        0,
      )
      return {
        generatedAt: new Date(now).toISOString(),
        workflowPath: selectedWorkflowPath,
        pollingIntervalMs: workflow.config.pollingIntervalMs,
        maxConcurrentAgents: workflow.config.agent.maxConcurrentAgents,
        counts: {
          running: state.running.size,
          retrying: state.retries.size,
          completed: state.completed.size,
        },
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
          case 'Poll':
          case 'WorkflowChanged': {
            yield* poll()
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
            const entry = state.running.get(event.issueId)
            if (entry === undefined) {
              break
            }
            state.running.delete(event.issueId)
            const seconds = (Date.now() - entry.startedAt.getTime()) / 1_000
            state.totals = {
              inputTokens: state.totals.inputTokens + entry.tokens.inputTokens,
              outputTokens: state.totals.outputTokens + entry.tokens.outputTokens,
              totalTokens: state.totals.totalTokens + entry.tokens.totalTokens,
              secondsRunning: state.totals.secondsRunning + seconds,
            }
            if (event.outcome === 'normal') {
              state.completed.add(event.issueId)
              yield* scheduleRetry(entry.issue, 1, null, true)
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
            const refreshed = yield* tracker
              .fetchIssuesByIds([event.issueId])
              .pipe(
                Effect.catchAll((error) =>
                  Effect.logWarning('retry refresh failed', { error: error.message }).pipe(
                    Effect.as<readonly Issue[]>([]),
                  ),
                ),
              )
            const issue = refreshed[0]
            if (issue === undefined) {
              state.claimed.delete(event.issueId)
              break
            }
            if (stateIsIn(issue.state, workflow.config.tracker.terminalStates)) {
              yield* workspaces.remove(issue.identifier).pipe(
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
            if (!issueIsActive(issue, workflow) || !issueIsRoutable(issue, workflow)) {
              state.claimed.delete(event.issueId)
              break
            }
            if (!stateHasSlot(issue, state, workflow)) {
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
          case 'Snapshot': {
            yield* Deferred.succeed(event.reply, createSnapshot())
            break
          }
        }
      }
    })

    yield* Effect.forkScoped(eventLoop)

    return {
      snapshot: Effect.gen(function* () {
        const reply = yield* Deferred.make<OrchestratorSnapshot>()
        yield* Queue.offer(mailbox, { _tag: 'Snapshot', reply })
        return yield* Deferred.await(reply)
      }),
      refresh: Queue.offer(mailbox, { _tag: 'Poll' }).pipe(Effect.asVoid),
    }
  })

export const runOrchestrator = (
  selectedWorkflowPath = resolve(process.cwd(), 'WORKFLOW.md'),
): Effect.Effect<void, WorkflowError> =>
  Effect.scoped(startOrchestrator(selectedWorkflowPath).pipe(Effect.zipRight(Effect.never)))
