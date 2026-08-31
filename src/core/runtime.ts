import { resolve } from 'node:path'
import { Deferred, Effect, Fiber, Option, Queue, type Scope } from 'effect'

import { unresolvedBlockers } from '../domain/dependencies.js'
import {
  issueId,
  normalizeState,
  type Issue,
  type IssueId,
  type IssueIdentifier,
  type JsonObject,
  type TokenTotals,
} from '../domain/domain.js'
import { WorkflowError } from '../errors.js'
import { classifyPullRequest, issueBranchName, type HandoffSnapshot } from '../domain/handoff.js'
import { loadHandoffs, saveHandoffs } from '../handoff-store.js'
import { mergeSparseObject } from '../support/json.js'
import { logError, logInfo, logWarning } from '../support/logging.js'
import {
  agentDetailPath,
  createAgentDetailRecord,
  recordAttemptStarted,
  recordCancellation,
  recordHandoff,
  recordIssueRefreshed,
  recordRetryScheduled,
  type AgentDetailContext,
  type AgentDetailRecord,
  type AgentDetailSnapshot,
  type AgentDetailStatus,
  type AgentEvent,
} from '../telemetry.js'
import type { Workflow } from '../config/workflow.js'
import { workspaceKey } from '../domain/workspace-containment.js'
import {
  AgentRunner,
  CurrentCodeReview,
  CurrentTracker,
  CurrentWorkspaceManager,
  WorkflowLoader,
  WorkflowWatcher,
  type AgentRunnerConfig,
  type AgentRunnerPort,
  type CodeReviewCell,
  type CodeReviewPort,
  type TrackerCell,
  type TrackerPort,
  type WorkflowLoaderPort,
  type WorkspaceManagerCell,
  type WorkspaceManagerPort,
} from '../ports/index.js'
import { eventLoop } from './polling.js'
import { agentDetail, createSnapshot } from './snapshot.js'
import { rebuildEffectiveWorkflow } from './workflow-reload.js'

export type RunningEntry = {
  runId: number
  issue: Issue
  fiber: Fiber.RuntimeFiber<void>
  execution: ExecutionSnapshot
  attempt: number | null
  startedAt: Date
  lastEventAt: Date | null
  lastEvent: string | null
  lastMessage: string | null
  processId: number | null
  threadId: string | null
  turnId: string | null
  sessionId: string | null
  turnCount: number
  turnActive: boolean
  tokens: Omit<TokenTotals, 'secondsRunning'>
  lastReportedTokens: Omit<TokenTotals, 'secondsRunning'>
}

export type RetryEntry = {
  issue: Issue
  attempt: number
  dueAt: number
  error: string | null
  fiber: Fiber.RuntimeFiber<void>
}

export type HandoffEntry = {
  issue: Issue
  execution: ExecutionSnapshot
  pullRequestNumber: number
  pullRequestUrl: string
  branchName: string
  state: HandoffSnapshot['state']
  headSha: string | null
  reason: string | null
  /** Distinct heads observed after a repair agent finished; its length is the verified repair count. */
  repairHeadShas: string[]
  /**
   * Every head this handoff has been observed at, baselines included. Cycle detection reads this
   * rather than repairHeadShas, which counts only post-repair heads and so never holds the head a
   * repair started from.
   */
  repairObservedHeadShas: string[]
  /** Head observed when the in-flight repair was dispatched, or null when no repair is running. */
  repairStartedHeadSha: string | null
  /**
   * Whether repairStartedHeadSha came back from the store rather than from a dispatch in this
   * process. Not persisted: a restored baseline proves a repair started, never that it finished,
   * so an unchanged head means the repair was interrupted rather than a no-op.
   */
  repairBaselineRestored: boolean
  reviewRequestedHeadSha: string | null
  reviewCompletedHeadSha: string | null
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
  lastMessage: string | null
  processId: number | null
  threadId: string | null
  turnId: string | null
  sessionId: string | null
  turnCount: number
  tokens: Omit<TokenTotals, 'secondsRunning'>
  lastReportedTokens: Omit<TokenTotals, 'secondsRunning'>
  workerHost: 'local'
  /** Stable link to the versioned detail resource for this agent. */
  detailUrl: string
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
  detailUrl: string
}>

/**
 * The four answers a detail request can receive. They are distinguished here, in the actor, rather
 * than inferred by the HTTP layer from a missing value.
 */
export type AgentDetailLookup =
  | Readonly<{ _tag: 'Found'; detail: AgentDetailSnapshot }>
  | Readonly<{ _tag: 'Completed'; identifier: string }>
  | Readonly<{ _tag: 'NoSession'; identifier: string }>
  | Readonly<{ _tag: 'Unavailable'; identifier: string; reason: string }>
  | Readonly<{ _tag: 'Unknown'; identifier: string }>

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
  handoffRecovery: Readonly<{
    status: 'recovering' | 'completed' | 'degraded'
    loaded: number
    recovered: number
    skipped: number
    failed: number
    storeError: Readonly<{
      operation: 'read' | 'write'
      message: string
      observedAt: string
    }> | null
  }>
  pollingIntervalMs: number
  maxConcurrentAgents: number
  counts: Readonly<{ running: number; retrying: number; completed: number }>
  pausedIssueNumbers: readonly number[]
  handoffs: readonly HandoffSnapshot[]
  running: readonly RunningSnapshot[]
  retrying: readonly RetrySnapshot[]
  totals: TokenTotals
  rateLimits: JsonObject | null
}>

export type OrchestratorControl = Readonly<{
  snapshot: Effect.Effect<OrchestratorSnapshot>
  refresh: Effect.Effect<void>
  setIssuePaused: (issueNumber: number, paused: boolean) => Effect.Effect<void>
  /**
   * Reads the published detail for one issue. The published index is built by the actor and is
   * immutable, so a detail request neither observes a partial update nor takes a turn in the
   * scheduler's mailbox: opening the panel can never delay polling.
   */
  agentDetail: (identifier: string) => Effect.Effect<AgentDetailLookup>
  /** Completes only when the host event loop fails or is interrupted during shutdown. */
  awaitTermination: Effect.Effect<never>
}>

export type OrchestratorEvent =
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

/**
 * One issue's published detail. The record is an immutable value the actor has finished with — a
 * later observation produces a new record rather than editing this one — and the reader supplies
 * only the current instant, so elapsed time and the stall countdown stay live without any consumer
 * touching scheduler state.
 */
export type PublishedDetail =
  | Readonly<{
      _tag: 'Found'
      record: AgentDetailRecord
      context: Omit<AgentDetailContext, 'now'>
    }>
  | Readonly<{ _tag: 'Completed' }>
  | Readonly<{ _tag: 'NoSession' }>
  | Readonly<{ _tag: 'Unavailable'; reason: string }>

/** How many finished agents keep their timeline for post-mortem inspection. */
export const retainedCompletedDetails = 16

export type RuntimeState = {
  running: Map<IssueId, RunningEntry>
  claimed: Set<IssueId>
  retries: Map<IssueId, RetryEntry>
  completed: Set<IssueId>
  pausedIssueNumbers: Set<number>
  handoffs: Map<IssueId, HandoffEntry>
  totals: TokenTotals
  rateLimits: JsonObject | null
  /** Actor-owned agent telemetry, keyed by issue and preserved across that issue's retries. */
  details: Map<IssueId, AgentDetailRecord>
  /** Issues whose detail record outlived its session, oldest first. */
  finishedDetails: IssueId[]
  /**
   * Issues whose retained detail has since been evicted. A session that ended and then aged out
   * keeps answering as completed rather than degrading into "no session", which would tell an
   * operator the agent never ran.
   */
  agedOutDetails: Set<IssueId>
  identifiers: Map<IssueId, IssueIdentifier>
}

export type EffectiveWorkflow = Readonly<{
  workflow: Workflow
  tracker: TrackerPort
  codeReview: CodeReviewPort | null
  workspaces: WorkspaceManagerPort
  loadedAt: Date
}>

export type ExecutionSnapshot = Readonly<{
  workflow: Workflow
  tracker: TrackerPort
  codeReview: CodeReviewPort | null
  requiredLabels: readonly string[]
  activeStates: readonly string[]
  terminalStates: readonly string[]
  secretEnvironmentNames: readonly string[]
  workspaces: WorkspaceManagerPort
  workspaceRoot: string
  prompt: string
  agentRunner: AgentRunnerConfig
  maxTurns: number
  stallTimeoutMs: number
}>

export type WorkflowReloadError = Readonly<{
  message: string
  observedAt: Date
}>

export type HandoffStoreError = Readonly<{
  operation: 'read' | 'write'
  message: string
  observedAt: Date
}>

export type HandoffRecoveryCounts = {
  loaded: number
  recovered: number
  skipped: number
  failed: number
}

/**
 * What the composition root must provide for the orchestrator to run. The code-review capability is
 * not among them: it is optional, and its absence is how the application says handoff is disabled.
 */
export type OrchestratorServices =
  | AgentRunner
  | CurrentTracker
  | CurrentWorkspaceManager
  | WorkflowLoader
  | WorkflowWatcher

/**
 * The ports the orchestrator resolved from {@link OrchestratorServices} at startup, and the cells
 * through which a reload or a credential rotation installs their replacements.
 *
 * This is not an injection seam: it is built inside the orchestrator from the tags the composition
 * root provided, and no caller can pass one in. A test binds a layer instead.
 */
export type RuntimePorts = Readonly<{
  agentRunner: AgentRunnerPort
  workflowLoader: WorkflowLoaderPort
  trackerCell: TrackerCell
  workspaceCell: WorkspaceManagerCell
  /**
   * `None` when pull-request handoff is disabled, so no code-review capability was composed and the
   * application follows the core continuation lifecycle.
   */
  codeReviewCell: Option.Option<CodeReviewCell>
}>

/**
 * An instance a rebuild replaced, held until the last live holder lets go of it. Adoption moves
 * running workers and in-flight handoffs onto the replacement, but a worker still holds whatever
 * its execution snapshot captured, and a handoff holds the workspace manager its run created.
 */
export type PendingRetirement = Readonly<{
  kind: 'tracker' | 'codeReview' | 'workspaces'
  instance: unknown
  retire: Effect.Effect<void>
}>

/**
 * The explicit mutable boundary shared by the extracted runtime operations.  The operation fields
 * are installed once the orchestrator has resolved its ports; extracted modules receive this record
 * instead of closing over startOrchestrator's local scope.
 */
export type OrchestratorContext = {
  readonly state: RuntimeState
  readonly ports: RuntimePorts
  /** Replaced port instances whose release is still waiting on a live holder. */
  readonly pendingRetirements: PendingRetirement[]
  /**
   * Ports an adoption took away from a live run, keyed by that run. A call that read an instance a
   * moment before adoption replaced it is still using it, so the instance is held until the run
   * ends rather than until the reference is swapped. Keyed by run rather than by issue: the same
   * issue goes on to a handoff, and a retry after it starts a run that never touched these.
   */
  readonly supersededPorts: Map<number, unknown[]>
  readonly selectedWorkflowPath: string
  readonly mailbox: Queue.Queue<OrchestratorEvent>
  readonly currentRefreshWaiters: Deferred.Deferred<void>[]
  readonly nextRefreshWaiters: Deferred.Deferred<void>[]
  readonly pendingUsage: Map<IssueId, NonNullable<AgentEvent['usage']>>
  readonly pendingLifecycle: Map<IssueId, AgentEvent[]>
  lastKnownGood: EffectiveWorkflow
  workflowReloadError: WorkflowReloadError | null
  pendingRateLimits: JsonObject | null
  nextRunId: number
  startupRecoveryFinished: boolean
  storeReadFailed: boolean
  handoffStoreError: HandoffStoreError | null
  readonly recoveryCounts: HandoffRecoveryCounts
  publishedDetails: ReadonlyMap<string, PublishedDetail>
  tickQueued: boolean
  pollRunning: boolean
  followUpRequested: boolean
  pollTimer: Fiber.RuntimeFiber<void> | null
  detailRecordValue: (
    issue: Issue,
    attempt: number | null,
    dispatchLabels: readonly string[],
  ) => AgentDetailRecord
  scheduleRetryEffect: (
    issue: Issue,
    attempt: number,
    error: string | null,
    continuation: boolean,
  ) => Effect.Effect<void, never, Scope.Scope>
  captureExecutionSnapshotValue: (effective: EffectiveWorkflow, prompt: string) => ExecutionSnapshot
  issueIsActiveInSnapshotValue: (issue: Issue, snapshot: ExecutionSnapshot) => boolean
  issueIsRoutableInSnapshotValue: (issue: Issue, snapshot: ExecutionSnapshot) => boolean
  logContextValue: (issue: Issue) => Readonly<Record<string, string>>
  identifierIssueNumberValue: (identifier: string) => number | null
  noteHandoffOutcomeValue: (
    id: IssueId,
    handoff: HandoffEntry,
    outcome: 'pull_request_open' | 'merged' | 'intervention_required',
  ) => void
  stateHasSlotValue: (issue: Issue, state: RuntimeState, workflow: Workflow) => boolean
  persistHandoffsEffect: () => Effect.Effect<void>
  handoffSnapshotsValue: () => readonly HandoffSnapshot[]
  recoverMissingHandoffsEffect: () => Effect.Effect<void>
  reconcileEffect: () => Effect.Effect<void, never, Scope.Scope>
  makeEffectiveWorkflowEffect: (
    workflow: Workflow,
  ) => Effect.Effect<EffectiveWorkflow, WorkflowError>
  sortIssuesValue: typeof sortIssues
  issueIsActiveValue: (issue: Issue, workflow: Workflow) => boolean
  issueIsRoutableValue: typeof issueIsRoutable
  stateIsInValue: (state: string, configured: readonly string[]) => boolean
  offerFromCallbackValue: (event: OrchestratorEvent) => void
  applyLifecycleUpdateEffect: (entry: RunningEntry, update: AgentEvent) => Effect.Effect<void>
  endRunningValue: (id: IssueId, expectedRunId: number | null) => RunningEntry | null
  applyPendingTelemetryValue: (id: IssueId, entry: RunningEntry) => void
  accountEndedRuntimeValue: (entry: RunningEntry, now: number) => void
  sessionLogContextValue: (entry: RunningEntry) => Readonly<Record<string, string | number | null>>
  cancelRunningEffect: (
    id: IssueId,
    cleanupWorkspace: boolean,
    reason?: string,
  ) => Effect.Effect<RunningEntry | null, never>
  scheduleNextTickEffect: () => Effect.Effect<void, never, Scope.Scope>
  hydrateRestoredHandoffsEffect: () => Effect.Effect<void>
  publishDetailsValue: () => void
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
  details: new Map(),
  finishedDetails: [],
  agedOutDetails: new Set(),
  identifiers: new Map(),
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
    codeReview: effective.codeReview,
    requiredLabels: Object.freeze([...effective.workflow.config.tracker.requiredLabels]),
    activeStates: Object.freeze([...effective.workflow.config.tracker.activeStates]),
    terminalStates: Object.freeze([...effective.workflow.config.tracker.terminalStates]),
    secretEnvironmentNames: Object.freeze([...effective.tracker.secretEnvironmentNames]),
    workspaces: effective.workspaces,
    workspaceRoot: effective.workflow.config.workspaceRoot,
    prompt,
    agentRunner: Object.freeze({ ...effective.workflow.config.codex }),
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

const sessionLogContext = (
  entry: RunningEntry,
): Readonly<Record<string, string | number | null>> => ({
  ...logContext(entry.issue),
  session_id: entry.sessionId,
  thread_id: entry.threadId,
  turn_id: entry.turnId,
  turn_count: entry.turnCount,
})

const identifierIssueNumber = (identifier: string): number | null => {
  const match = /#(\d+)$/u.exec(identifier)
  return match?.[1] === undefined ? null : Number(match[1])
}

export const startOrchestratorRuntime = (
  selectedWorkflowPath: string,
): Effect.Effect<OrchestratorControl, WorkflowError, OrchestratorServices | Scope.Scope> =>
  Effect.gen(function* () {
    const ports: RuntimePorts = {
      agentRunner: yield* AgentRunner,
      workflowLoader: yield* WorkflowLoader,
      trackerCell: yield* CurrentTracker,
      workspaceCell: yield* CurrentWorkspaceManager,
      codeReviewCell: yield* Effect.serviceOption(CurrentCodeReview),
    }
    const pendingRetirements: PendingRetirement[] = []
    const supersededPorts = new Map<number, unknown[]>()
    /**
     * Built from the workflow the orchestrator loaded rather than adopted from the composition
     * root's own read of it. The two are separate reads of one file, and an edit between them would
     * otherwise leave every port serving a version that nothing compares against again: the reload
     * check measures the file against the workflow adopted here, never against the cells' input.
     * The instances the layer built are replaced immediately and retired on the first poll.
     */
    let lastKnownGood = yield* rebuildEffectiveWorkflow(
      ports,
      pendingRetirements,
      yield* ports.workflowLoader.load(selectedWorkflowPath),
    )
    const makeEffectiveWorkflow = (
      workflow: Workflow,
    ): Effect.Effect<EffectiveWorkflow, WorkflowError> =>
      rebuildEffectiveWorkflow(ports, pendingRetirements, workflow)
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
                    logWarning('startup terminal issue fetch failed; continuing', {
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
                logWarning('startup workspace inspection failed; continuing', {
                  ...logContext(issue),
                  action: 'workspace_inspection',
                  outcome: 'failed',
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
                  logWarning('startup terminal issue recheck failed; continuing', {
                    ...logContext(issue),
                    action: 'terminal_recheck',
                    outcome: 'failed',
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
              logWarning('startup terminal workspace cleanup failed; continuing', {
                ...logContext(current),
                action: 'workspace_cleanup',
                outcome: 'failed',
                error: error.message,
              }),
            ),
          )
        }
      })
    yield* cleanupTerminalWorkspaces(lastKnownGood)
    let workflowReloadError: WorkflowReloadError | null = null
    const state = initialState()
    const pendingUsage = new Map<IssueId, NonNullable<AgentEvent['usage']>>()
    const pendingLifecycle = new Map<IssueId, AgentEvent[]>()
    let pendingRateLimits: JsonObject | null = null
    /**
     * The immutable detail index published by the actor. Every consumer reads this; nothing outside
     * the event loop ever reaches `state.details`.
     */
    let publishedDetails: ReadonlyMap<string, PublishedDetail> = new Map()

    /** How many issue identifiers are remembered for answering detail requests. */
    const rememberedIdentifiers = 500

    const noteIssue = (issue: Issue): void => {
      state.identifiers.set(issue.id, issue.identifier)
      if (state.identifiers.size > rememberedIdentifiers) {
        const oldest = state.identifiers.keys().next()
        if (!oldest.done) {
          state.identifiers.delete(oldest.value)
        }
      }
    }

    const detailRecord = (
      issue: Issue,
      attempt: number | null,
      dispatchLabels: readonly string[],
    ): AgentDetailRecord => {
      noteIssue(issue)
      // A new session supersedes whatever aged out for this issue.
      state.agedOutDetails.delete(issue.id)
      const now = new Date()
      const existing = state.details.get(issue.id)
      if (existing !== undefined) {
        // The same record carries every attempt for the issue, so ordering and session identity
        // survive the boundary that separates them.
        const started = recordAttemptStarted(
          recordIssueRefreshed(existing, issue),
          now,
          attempt ?? 0,
        )
        state.details.set(issue.id, started)
        return started
      }
      const record = createAgentDetailRecord({
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        attempt,
        startedAt: now,
        workspacePathKey: workspaceKey(issue.identifier),
        expectedBranch: issue.branchName ?? issueBranchName(issue),
        dispatchLabels,
      })
      state.details.set(issue.id, record)
      return record
    }

    const publishDetailsValue = (): void => {
      const next = new Map<string, PublishedDetail>()
      for (const [id, record] of state.details) {
        const running = state.running.get(id)
        const retry = state.retries.get(id)
        const status: AgentDetailStatus =
          running !== undefined ? 'running' : retry !== undefined ? 'retrying' : 'completed'
        if (status === 'completed') {
          if (!state.finishedDetails.includes(id)) {
            state.finishedDetails.push(id)
          }
        } else {
          state.finishedDetails = state.finishedDetails.filter((finished) => finished !== id)
        }
        next.set(record.identifier, {
          _tag: 'Found',
          record,
          context: {
            self: agentDetailPath(record.identifier),
            status,
            stallTimeoutMs: running?.execution.stallTimeoutMs ?? 0,
            workerHost: 'local',
            branch: record.handoff.expectedBranch,
            retry:
              retry === undefined
                ? null
                : { attempt: retry.attempt, dueAt: new Date(retry.dueAt), reason: retry.error },
          },
        })
      }
      while (state.finishedDetails.length > retainedCompletedDetails) {
        const evicted = state.finishedDetails.shift()
        const record = evicted === undefined ? undefined : state.details.get(evicted)
        if (evicted !== undefined && record !== undefined) {
          state.details.delete(evicted)
          state.agedOutDetails.add(evicted)
          if (state.agedOutDetails.size > rememberedIdentifiers) {
            const oldest = state.agedOutDetails.values().next()
            if (!oldest.done) {
              state.agedOutDetails.delete(oldest.value)
            }
          }
          next.set(record.identifier, { _tag: 'Completed' })
        }
      }
      for (const [id, identifier] of state.identifiers) {
        if (next.has(identifier)) {
          continue
        }
        if (state.completed.has(id) || state.agedOutDetails.has(id)) {
          next.set(identifier, { _tag: 'Completed' })
          continue
        }
        next.set(
          identifier,
          state.claimed.has(id) && !state.running.has(id) && !state.handoffs.has(id)
            ? { _tag: 'Unavailable', reason: 'The agent session is still starting' }
            : { _tag: 'NoSession' },
        )
      }
      publishedDetails = next
    }
    const handoffStorePath = resolve(
      lastKnownGood.workflow.config.workspaceRoot,
      '.symphony',
      'handoffs.json',
    )
    let handoffStoreError: HandoffStoreError | null = null
    let storeReadFailed = false
    // Handoff disabled: the store is deliberately left unread, so the empty in-memory list must
    // never be written back over it. A later handoff-enabled run still has to restore those
    // pull requests.
    const handoffStoreDisabled = lastKnownGood.codeReview === null
    const loadedHandoffs = yield* handoffStoreDisabled
      ? Effect.succeed<readonly HandoffSnapshot[]>([])
      : loadHandoffs(handoffStorePath).pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              storeReadFailed = true
              handoffStoreError = {
                operation: error.operation,
                message: error.message,
                observedAt: new Date(),
              }
              return logError('handoff store read failed; preserving store during recovery', {
                action: 'handoff_store_read',
                outcome: 'failed',
                path: handoffStorePath,
                error: error.message,
              }).pipe(Effect.as<readonly HandoffSnapshot[]>([]))
            },
            onSuccess: (handoffs) => Effect.succeed(handoffs),
          }),
        )
    let pendingRestoredHandoffs = loadedHandoffs
    const recoveryCounts = {
      loaded: loadedHandoffs.length,
      recovered: 0,
      skipped: 0,
      failed: storeReadFailed ? 1 : 0,
    }
    let startupRecoveryFinished = false
    const recoveryResolved = new Set<IssueId>()
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
        repairAttempts: handoff.repairHeadShas.length,
        repairHeadShas: [...handoff.repairHeadShas],
        repairObservedHeadShas: [...handoff.repairObservedHeadShas],
        repairStartedHeadSha: handoff.repairStartedHeadSha,
        reviewRequestedHeadSha: handoff.reviewRequestedHeadSha,
        reviewCompletedHeadSha: handoff.reviewCompletedHeadSha,
        observedAt: handoff.observedAt.toISOString(),
      })),
    ]
    const persistHandoffs = (): Effect.Effect<void> => {
      if (handoffStoreDisabled || !startupRecoveryFinished || storeReadFailed) {
        return Effect.void
      }
      return saveHandoffs(handoffStorePath, handoffSnapshots()).pipe(
        Effect.catchAll((error) => {
          recoveryCounts.failed += 1
          handoffStoreError = {
            operation: error.operation,
            message: error.message,
            observedAt: new Date(),
          }
          return logError('handoff store write failed', {
            action: 'handoff_store_write',
            outcome: 'failed',
            path: handoffStorePath,
            error: error.message,
          })
        }),
      )
    }
    const hydrateRestoredHandoffsEffect = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (pendingRestoredHandoffs.length === 0) {
          return
        }
        const fetched = yield* lastKnownGood.tracker
          .fetchIssuesByIds(pendingRestoredHandoffs.map((handoff) => issueId(handoff.issueId)))
          .pipe(
            Effect.matchEffect({
              onFailure: (error) => {
                recoveryCounts.failed += 1
                return logWarning('persisted handoff hydration failed; retrying later', {
                  action: 'handoff_hydration',
                  outcome: 'failed',
                  pending: pendingRestoredHandoffs.length,
                  error: error.message,
                }).pipe(Effect.as<readonly Issue[] | null>(null))
              },
              onSuccess: (issues) => Effect.succeed<readonly Issue[] | null>(issues),
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
            state:
              restored.repairHeadShas === undefined &&
              restored.state === 'intervention_required' &&
              restored.reason?.startsWith('Repair limit reached.') === true
                ? 'repair_needed'
                : restored.state,
            headSha: restored.headSha,
            reason: restored.reason,
            // Legacy snapshots conflated worker retries with repairs. An absent head list migrates
            // to zero verified repairs rather than preserving a contaminated counter.
            repairHeadShas: [...(restored.repairHeadShas ?? [])],
            // A legacy snapshot has no observed set; its post-repair heads plus any in-flight
            // baseline are the most it can honestly contribute.
            repairObservedHeadShas: [
              ...new Set([
                ...(restored.repairObservedHeadShas ?? restored.repairHeadShas ?? []),
                ...(restored.repairStartedHeadSha === undefined ||
                restored.repairStartedHeadSha === null
                  ? []
                  : [restored.repairStartedHeadSha]),
              ]),
            ],
            // Preserved rather than cleared: a repair may have pushed a new head just before the
            // restart, and the first observation after recovery needs this baseline to attribute it.
            repairStartedHeadSha: restored.repairStartedHeadSha ?? null,
            repairBaselineRestored: (restored.repairStartedHeadSha ?? null) !== null,
            reviewRequestedHeadSha: restored.reviewRequestedHeadSha ?? null,
            reviewCompletedHeadSha: restored.reviewCompletedHeadSha ?? null,
            observedAt: new Date(restored.observedAt),
          })
          state.claimed.add(issue.id)
          noteIssue(issue)
          hydrated.add(restored.issueId)
        }
        pendingRestoredHandoffs = pendingRestoredHandoffs.filter(
          (handoff) => !hydrated.has(handoff.issueId),
        )
      })
    yield* hydrateRestoredHandoffsEffect()
    publishDetailsValue()
    const mailbox = yield* Queue.unbounded<OrchestratorEvent>()
    let nextRunId = 1
    const currentRefreshWaiters: Deferred.Deferred<void>[] = []
    const nextRefreshWaiters: Deferred.Deferred<void>[] = []

    const offerFromCallback = (event: OrchestratorEvent): void => {
      Effect.runSync(Queue.offer(mailbox, event))
    }

    const requestTick = (source: 'startup' | 'timer' | 'change'): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (context.tickQueued) {
          if (context.pollRunning && source === 'change') {
            context.followUpRequested = true
          }
          return Effect.void
        }
        context.tickQueued = true
        return Queue.offer(mailbox, { _tag: 'Tick' }).pipe(Effect.asVoid)
      })

    const requestRefresh = Effect.suspend(() =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<void>()
        if (context.pollRunning) {
          nextRefreshWaiters.push(reply)
        } else {
          currentRefreshWaiters.push(reply)
        }
        yield* requestTick('change')
        yield* Deferred.await(reply)
      }),
    )

    yield* Effect.flatMap(WorkflowWatcher, (watcher) =>
      watcher.watch(selectedWorkflowPath, () => {
        Effect.runFork(requestTick('change'))
      }),
    )

    const scheduleNextTick = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        if (context.pollTimer !== null) {
          yield* Fiber.interrupt(context.pollTimer)
        }
        const intervalMs = lastKnownGood.workflow.config.pollingIntervalMs
        context.pollTimer = yield* Effect.forkScoped(
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
        noteIssue(issue)
        const record = state.details.get(issue.id)
        if (record !== undefined) {
          state.details.set(
            issue.id,
            recordRetryScheduled(record, new Date(), attempt, new Date(dueAt), error),
          )
        }
        yield* logInfo('action=retry outcome=scheduled', {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          action: 'retry',
          outcome: 'scheduled',
          attempt,
          due_at: new Date(dueAt).toISOString(),
          error,
        })
      })

    /** Mirrors an observed pull-request disposition onto the issue's retained handoff detail. */
    const noteHandoffOutcome = (
      id: IssueId,
      handoff: HandoffEntry,
      outcome: 'pull_request_open' | 'merged' | 'intervention_required',
    ): void => {
      const record = state.details.get(id)
      if (record === undefined) {
        return
      }
      const observed = recordHandoff(record, handoff.observedAt, {
        step: 'outcome',
        status: outcome === 'intervention_required' ? 'failed' : 'observed',
        message: handoff.reason,
        pullRequest: {
          status:
            record.handoff.pullRequest.status === 'pending'
              ? 'reused'
              : record.handoff.pullRequest.status,
          number: handoff.pullRequestNumber,
          url: handoff.pullRequestUrl,
          state: handoff.state,
        },
        outcome,
      })
      state.details.set(id, observed)
    }

    const recoverMissingHandoffs = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (startupRecoveryFinished) {
          return
        }
        const effective = lastKnownGood
        if (effective.codeReview === null) {
          startupRecoveryFinished = true
          return
        }
        const requiredLabels = effective.workflow.config.tracker.requiredLabels
        const fetched = yield* effective.tracker
          .fetchIssuesByStates(effective.workflow.config.tracker.activeStates, null, {
            hydrateDependencies: false,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: 'Failed' as const, error }),
              onSuccess: (issues) => ({ _tag: 'Succeeded' as const, issues }),
            }),
          )
        if (fetched._tag === 'Failed') {
          recoveryCounts.failed += 1
          yield* logError('startup handoff recovery issue fetch failed; retrying later', {
            action: 'handoff_recovery',
            outcome: 'failed',
            loaded: recoveryCounts.loaded,
            recovered: recoveryCounts.recovered,
            skipped: recoveryCounts.skipped,
            failed: recoveryCounts.failed,
            error: fetched.error.message,
          })
          return
        }
        let attemptFailed = false
        for (const issue of fetched.issues) {
          if (!issue.dispatchable) {
            recoveryResolved.add(issue.id)
            recoveryCounts.skipped += 1
            continue
          }
          const labels = new Set(issue.labels.map((label) => label.trim().toLowerCase()))
          const isLabeled = requiredLabels.every(
            (label) => label.length > 0 && labels.has(label.trim().toLowerCase()),
          )
          if (
            !isLabeled ||
            state.handoffs.has(issue.id) ||
            pendingRestoredHandoffs.some((handoff) => handoff.issueId === issue.id) ||
            recoveryResolved.has(issue.id)
          ) {
            continue
          }
          const found = yield* effective.codeReview.findExistingHandoff(issue).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: 'Failed' as const, error }),
              onSuccess: (result) => ({ _tag: 'Succeeded' as const, result }),
            }),
          )
          if (found._tag === 'Failed') {
            attemptFailed = true
            recoveryCounts.failed += 1
            yield* logWarning('startup handoff recovery lookup failed; retrying later', {
              ...logContext(issue),
              action: 'handoff_recovery',
              outcome: 'failed',
              error: found.error.message,
            })
            continue
          }
          if (found.result._tag === 'NoBranch') {
            recoveryResolved.add(issue.id)
            recoveryCounts.skipped += 1
            continue
          }
          const observedAt = new Date()
          const inspected = yield* effective.codeReview
            .inspectPullRequest(found.result.pullRequestNumber)
            .pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: 'Failed' as const, error }),
                onSuccess: (observation) => ({ _tag: 'Succeeded' as const, observation }),
              }),
            )
          const disposition =
            inspected._tag === 'Succeeded'
              ? classifyPullRequest(inspected.observation)
              : {
                  state: 'awaiting_checks' as const,
                  reason: inspected.error.message,
                }
          const branchObserved = recordHandoff(
            detailRecord(issue, null, requiredLabels),
            observedAt,
            {
              step: 'remote_branch',
              status: 'observed',
              message: `Remote branch ${found.result.branchName} is present`,
              remoteBranch: found.result.branchName,
            },
          )
          state.details.set(
            issue.id,
            recordHandoff(branchObserved, observedAt, {
              step: 'pull_request',
              status: 'observed',
              message: 'Recovered an existing pull request during startup',
              pullRequest: {
                status: 'reused',
                number: found.result.pullRequestNumber,
                url: found.result.pullRequestUrl,
                state: disposition.state,
              },
            }),
          )
          state.handoffs.set(issue.id, {
            issue,
            execution: captureExecutionSnapshot(effective, ''),
            pullRequestNumber: found.result.pullRequestNumber,
            pullRequestUrl: found.result.pullRequestUrl,
            branchName: found.result.branchName,
            state: disposition.state,
            headSha: inspected._tag === 'Succeeded' ? inspected.observation.headSha : null,
            reason: 'reason' in disposition ? disposition.reason : null,
            repairHeadShas: [],
            repairObservedHeadShas: [],
            repairStartedHeadSha: null,
            repairBaselineRestored: false,
            reviewRequestedHeadSha: null,
            reviewCompletedHeadSha: null,
            observedAt,
          })
          state.claimed.add(issue.id)
          noteIssue(issue)
          recoveryResolved.add(issue.id)
          recoveryCounts.recovered += 1
          yield* logInfo('open pull request handoff recovered', {
            ...logContext(issue),
            action: 'handoff_recovery',
            outcome: 'recovered',
            branch: found.result.branchName,
            pull_request_url: found.result.pullRequestUrl,
          })
        }
        if (attemptFailed) {
          return
        }
        startupRecoveryFinished = true
        yield* logInfo('startup handoff recovery completed', {
          action: 'handoff_recovery',
          outcome: storeReadFailed ? 'degraded' : 'completed',
          loaded: recoveryCounts.loaded,
          recovered: recoveryCounts.recovered,
          skipped: recoveryCounts.skipped,
          failed: recoveryCounts.failed,
        })
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

    const applyPendingTelemetry = (id: IssueId, entry: RunningEntry): void => {
      const usage = pendingUsage.get(id)
      if (usage !== undefined) {
        entry.lastReportedTokens = usage
        entry.tokens = {
          inputTokens: Math.max(entry.tokens.inputTokens, usage.inputTokens),
          outputTokens: Math.max(entry.tokens.outputTokens, usage.outputTokens),
          totalTokens: Math.max(entry.tokens.totalTokens, usage.totalTokens),
        }
      }
      if (pendingRateLimits !== null) {
        state.rateLimits = mergeSparseObject(state.rateLimits, pendingRateLimits)
        pendingRateLimits = null
      }
      pendingUsage.delete(id)
    }

    const applyLifecycleUpdate = (entry: RunningEntry, update: AgentEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        entry.lastEvent = update.event
        entry.lastEventAt = update.timestamp
        if (update.message !== null) {
          entry.lastMessage = update.message
        }
        entry.processId = update.processId
        entry.threadId = update.threadId ?? entry.threadId
        if (update.turnId !== null && update.turnCount >= entry.turnCount) {
          entry.turnId = update.turnId
        }
        entry.sessionId = update.sessionId ?? entry.sessionId
        entry.turnCount = Math.max(entry.turnCount, update.turnCount)
        if (entry.sessionId !== null && update.event === 'session_started') {
          yield* logInfo('action=session outcome=started', {
            ...sessionLogContext(entry),
            action: 'session',
            outcome: 'started',
            error: null,
          })
        }
        if (entry.sessionId !== null && update.event === 'turn_started') {
          entry.turnActive = true
          yield* logInfo('action=turn outcome=started', {
            ...sessionLogContext(entry),
            action: 'turn',
            outcome: 'started',
            error: null,
          })
        }
        if (
          entry.sessionId !== null &&
          (update.event === 'turn/completed' ||
            update.event === 'turn/failed' ||
            update.event === 'turn/terminated') &&
          update.turnStatus !== null
        ) {
          const outcome = ports.agentRunner.semantics.turnOutcome(update.turnStatus)
          const completed = outcome === 'completed'
          const cancelled = outcome === 'cancelled'
          entry.turnActive = false
          yield* (completed || cancelled ? logInfo : logError)(`action=turn outcome=${outcome}`, {
            ...sessionLogContext(entry),
            action: 'turn',
            outcome,
            error: completed || cancelled ? null : `turn finished with status ${update.turnStatus}`,
          })
        }
      })

    const takePendingLifecycle = (id: IssueId): readonly AgentEvent[] => {
      const updates = pendingLifecycle.get(id) ?? []
      pendingLifecycle.delete(id)
      return updates
    }

    const cancelRunning = (
      id: IssueId,
      cleanupWorkspace: boolean,
      reason = 'the orchestrator cancelled the run',
    ): Effect.Effect<RunningEntry | null, never> =>
      Effect.gen(function* () {
        const entry = state.running.get(id)
        if (entry === undefined) {
          return null
        }
        const queuedBeforeInterruption = pendingLifecycle.get(id)?.length ?? 0
        yield* Fiber.interrupt(entry.fiber)
        const queuedLifecycle = takePendingLifecycle(id)
        yield* Effect.forEach(
          queuedLifecycle.slice(0, queuedBeforeInterruption),
          (update) => applyLifecycleUpdate(entry, update),
          {
            discard: true,
          },
        )
        if (entry.sessionId !== null && entry.turnId !== null && entry.turnActive) {
          yield* logInfo('action=turn outcome=cancelled', {
            ...sessionLogContext(entry),
            action: 'turn',
            outcome: 'cancelled',
            error: null,
          })
          entry.turnActive = false
        }
        applyPendingTelemetry(id, entry)
        endRunning(id, null)
        accountEndedRuntime(entry, Date.now())
        const record = state.details.get(id)
        if (record !== undefined) {
          state.details.set(id, recordCancellation(record, new Date(), reason))
        }
        state.claimed.delete(id)
        if (entry.sessionId !== null) {
          yield* logInfo('action=session outcome=cancelled', {
            ...sessionLogContext(entry),
            action: 'session',
            outcome: 'cancelled',
            error: null,
          })
        }
        if (cleanupWorkspace) {
          yield* entry.execution.workspaces.remove(entry.issue.identifier).pipe(
            Effect.catchAll((error) =>
              logWarning('terminal workspace cleanup failed', {
                ...logContext(entry.issue),
                action: 'workspace_cleanup',
                outcome: 'failed',
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
            const ended = yield* cancelRunning(
              id,
              false,
              `the agent stalled after ${String(stallTimeout)}ms without protocol activity`,
            )
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
            yield* logWarning('reconciliation failed; keeping worker running', {
              ...logContext(entry.issue),
              action: 'reconciliation',
              outcome: 'failed',
              error: refreshResult.error.message,
            })
            continue
          }
          const issue = refreshResult.issues.find((candidate) => candidate.id === id)
          if (issue === undefined) {
            yield* cancelRunning(id, false, 'the tracker no longer reports the issue')
            continue
          }
          const terminal = stateIsIn(issue.state, execution.terminalStates)
          if (terminal || !issueIsActiveInSnapshot(issue, execution)) {
            yield* cancelRunning(
              id,
              terminal,
              terminal
                ? `the issue reached the terminal state ${issue.state}`
                : `the issue left its active states as ${issue.state}`,
            )
          } else {
            entry.issue = issue
          }
        }
      })

    const context: OrchestratorContext = {
      state,
      ports,
      pendingRetirements,
      supersededPorts,
      selectedWorkflowPath,
      mailbox,
      currentRefreshWaiters,
      nextRefreshWaiters,
      pendingUsage,
      pendingLifecycle,
      get lastKnownGood() {
        return lastKnownGood
      },
      set lastKnownGood(value) {
        lastKnownGood = value
      },
      get workflowReloadError() {
        return workflowReloadError
      },
      set workflowReloadError(value) {
        workflowReloadError = value
      },
      get pendingRateLimits() {
        return pendingRateLimits
      },
      set pendingRateLimits(value) {
        pendingRateLimits = value
      },
      get nextRunId() {
        return nextRunId
      },
      set nextRunId(value) {
        nextRunId = value
      },
      get startupRecoveryFinished() {
        return startupRecoveryFinished
      },
      set startupRecoveryFinished(value) {
        startupRecoveryFinished = value
      },
      get storeReadFailed() {
        return storeReadFailed
      },
      set storeReadFailed(value) {
        storeReadFailed = value
      },
      get handoffStoreError() {
        return handoffStoreError
      },
      set handoffStoreError(value) {
        handoffStoreError = value
      },
      recoveryCounts,
      get publishedDetails() {
        return publishedDetails
      },
      set publishedDetails(value) {
        publishedDetails = value
      },
      tickQueued: false,
      pollRunning: false,
      followUpRequested: false,
      pollTimer: null,
      detailRecordValue: detailRecord,
      scheduleRetryEffect: scheduleRetry,
      captureExecutionSnapshotValue: captureExecutionSnapshot,
      issueIsActiveInSnapshotValue: issueIsActiveInSnapshot,
      issueIsRoutableInSnapshotValue: issueIsRoutableInSnapshot,
      logContextValue: logContext,
      identifierIssueNumberValue: identifierIssueNumber,
      noteHandoffOutcomeValue: noteHandoffOutcome,
      stateHasSlotValue: stateHasSlot,
      persistHandoffsEffect: persistHandoffs,
      handoffSnapshotsValue: handoffSnapshots,
      recoverMissingHandoffsEffect: recoverMissingHandoffs,
      reconcileEffect: reconcile,
      makeEffectiveWorkflowEffect: makeEffectiveWorkflow,
      sortIssuesValue: sortIssues,
      issueIsActiveValue: issueIsActive,
      issueIsRoutableValue: issueIsRoutable,
      stateIsInValue: stateIsIn,
      offerFromCallbackValue: offerFromCallback,
      applyLifecycleUpdateEffect: applyLifecycleUpdate,
      endRunningValue: endRunning,
      applyPendingTelemetryValue: applyPendingTelemetry,
      accountEndedRuntimeValue: accountEndedRuntime,
      sessionLogContextValue: sessionLogContext,
      cancelRunningEffect: cancelRunning,
      scheduleNextTickEffect: scheduleNextTick,
      hydrateRestoredHandoffsEffect,
      publishDetailsValue,
    }

    const eventLoopFiber = yield* Effect.forkScoped(eventLoop(context))
    yield* requestTick('startup')

    return {
      snapshot: Effect.sync(() => createSnapshot(context)),
      refresh: requestRefresh,
      agentDetail: (identifier) => agentDetail(context, identifier),
      setIssuePaused: (issueNumber, paused) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<void>()
          yield* Queue.offer(mailbox, { _tag: 'SetIssuePaused', issueNumber, paused, reply })
          yield* Deferred.await(reply)
        }),
      awaitTermination: Fiber.join(eventLoopFiber).pipe(
        Effect.zipRight(Effect.dieMessage('orchestrator event loop exited unexpectedly')),
      ),
    }
  })

export const runOrchestratorRuntime = (
  selectedWorkflowPath: string,
): Effect.Effect<void, WorkflowError, OrchestratorServices> =>
  Effect.scoped(
    startOrchestratorRuntime(selectedWorkflowPath).pipe(
      Effect.flatMap((orchestrator) => orchestrator.awaitTermination),
    ),
  )
