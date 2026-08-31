import { resolve } from 'node:path'
import { Deferred, Effect, Fiber, Option, Queue, Ref, Runtime, Stream, type Scope } from 'effect'

import {
  issueId,
  type Issue,
  type IssueId,
  type JsonObject,
  type TokenTotals,
} from '../domain/domain.js'
import { WorkflowError, type TrackerError } from '../errors.js'
import { classifyPullRequest, issueBranchName, type HandoffSnapshot } from '../domain/handoff.js'
import { loadHandoffs, saveHandoffs } from '../handoff-store.js'
import { logError, logInfo, logWarning } from '../support/logging.js'
import {
  createAgentDetailRecord,
  recordAttemptStarted,
  recordCancellation,
  recordHandoff,
  recordIssueRefreshed,
  recordRetryScheduled,
  type AgentDetailRecord,
  type AgentDetailSnapshot,
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
} from '../ports/index.js'
import { eventLoop } from './polling.js'
import {
  captureExecutionSnapshot,
  issueIsActiveInSnapshot,
  logContext,
  sessionLogContext,
  stateIsIn,
} from './policy.js'
import { releaseRepair, settleRepair } from './handoff-decision.js'
import { agentRetryDelay, trackerRetryDelay } from './retry.js'
import { agentDetail, createSnapshot } from './snapshot.js'
import {
  initialState,
  type EffectiveWorkflow,
  type HandoffEntry,
  type RepairDisposition,
  type RunningEntry,
  type RuntimePorts,
  type RuntimeState,
} from './state.js'
import * as Transitions from './transitions.js'
import { rebuildEffectiveWorkflow } from './workflow-reload.js'

/**
 * How much finished work the snapshot publishes. The console scopes its Finished view to a time
 * window, so the wire payload is bounded by recency rather than by however many issues a long
 * session has merged.
 */
export const publishedCompletedWork = 50

export {
  retainedCompletedDetails,
  type CompletedEntry,
  type EffectiveWorkflow,
  type ExecutionSnapshot,
  type HandoffEntry,
  type HandoffRecoveryCounts,
  type HandoffStoreError,
  type PendingRetirement,
  type PublishedDetail,
  type RetryEntry,
  type RunningEntry,
  type RuntimePorts,
  type RuntimeState,
  type WorkflowReloadError,
} from './state.js'
export { issueIsRoutable, retryDelayMs, sortIssues } from './policy.js'

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
  /**
   * The instant this agent is considered stalled, or `null` when stall detection is disabled for
   * it. Published as an absolute time rather than a flag so the console can decide for itself that
   * the deadline has passed without waiting for the next snapshot to say so.
   */
  stallDeadline: string | null
  /** Stable link to the versioned detail resource for this agent. */
  detailUrl: string
}>

export type CompletedSnapshot = Readonly<{
  issueId: IssueId
  identifier: string
  title: string
  url: string | null
  outcome: 'merged'
  finishedAt: string
  pullRequestUrl: string | null
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
  /** Finished work, newest first and bounded by {@link publishedCompletedWork}. */
  completed: readonly CompletedSnapshot[]
  /**
   * Normalized issue states with no dispatch slot left, because the workflow narrows
   * `agent.max_concurrent_agents_by_state` below the global limit and that state has reached its
   * own cap. The scheduler enforces both limits, so a console that knew only the global one would
   * promise an immediate start for work that will in fact stay queued. Normalization is the
   * runtime's rule, so the runtime publishes the answer rather than the inputs.
   */
  saturatedStates: readonly string[]
  /**
   * Issue identifiers whose agent detail will answer, rather than report no session. A handoff
   * restored from the store after a restart has no agent session behind it, so a console must not
   * offer to inspect one.
   */
  inspectableAgents: readonly string[]
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
 * What the extracted runtime operations are handed instead of closing over the orchestrator's own
 * scope: the state cell, the ports, and the operations whose implementation needs something only
 * that scope has — a scope to fork a timer into, or the mailbox to enqueue against.
 *
 * The state is one `Ref` rather than a record of mutable containers, so every operation states its
 * change as a transition applied to it. A reader sees one coherent value; a writer replaces it.
 */
export type OrchestratorContext = Readonly<{
  state: Ref.Ref<RuntimeState>
  ports: RuntimePorts
  selectedWorkflowPath: string
  mailbox: Queue.Queue<OrchestratorEvent>
  /** Opens or reuses the detail record for an issue that is about to be dispatched. */
  detailRecord: (
    issue: Issue,
    attempt: number | null,
    dispatchLabels: readonly string[],
  ) => Effect.Effect<AgentDetailRecord>
  scheduleRetry: (
    issue: Issue,
    attempt: number,
    error: string | null,
    continuation: boolean,
    trackerError?: TrackerError,
  ) => Effect.Effect<boolean, never, Scope.Scope>
  /** Applies one protocol event to a run and says in the log what the event amounted to. */
  applyLifecycleUpdate: (entry: RunningEntry, update: AgentEvent) => Effect.Effect<RunningEntry>
  cancelRunning: (
    id: IssueId,
    cleanupWorkspace: boolean,
    reason?: string,
  ) => Effect.Effect<Option.Option<RunningEntry>>
  /** Mirrors an observed pull-request disposition onto the issue's retained handoff detail. */
  noteHandoffOutcome: (
    id: IssueId,
    handoff: HandoffEntry,
    outcome: 'pull_request_open' | 'merged' | 'intervention_required',
  ) => Effect.Effect<void>
  persistHandoffs: Effect.Effect<void>
  recoverMissingHandoffs: Effect.Effect<void>
  reconcile: Effect.Effect<void, never, Scope.Scope>
  hydrateRestoredHandoffs: Effect.Effect<void>
  makeEffectiveWorkflow: (workflow: Workflow) => Effect.Effect<EffectiveWorkflow, WorkflowError>
  scheduleNextTick: Effect.Effect<void, never, Scope.Scope>
  requestTick: (source: Transitions.TickSource) => Effect.Effect<void>
  /**
   * Runs a settling effect from a plain callback, on the orchestrator's own runtime and inside its
   * scope. The effect must complete without suspending; see the bridge's definition.
   */
  runFromCallback: (effect: Effect.Effect<void>) => void
  /** Rebuilds the published detail index. Runs after every transition the event loop makes. */
  publish: Effect.Effect<void>
}>

/**
 * Removes the workspace of every issue that reached a terminal state while the orchestrator was
 * down. It runs before any state exists, and answers only to the tracker and the filesystem.
 */
const cleanupTerminalWorkspaces = (effective: EffectiveWorkflow): Effect.Effect<void> =>
  Effect.gen(function* () {
    const terminalGroups = yield* Effect.forEach(
      effective.workflow.config.tracker.terminalStates,
      (state) =>
        effective.tracker.fetchIssuesByStates([state], null, { hydrateDependencies: false }).pipe(
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
    /**
     * Built from the workflow the orchestrator loaded rather than adopted from the composition
     * root's own read of it. The two are separate reads of one file, and an edit between them would
     * otherwise leave every port serving a version that nothing compares against again: the reload
     * check measures the file against the workflow adopted here, never against the cells' input.
     * The instances the layer built are replaced immediately and retired on the first poll.
     */
    const bootstrap = yield* rebuildEffectiveWorkflow(
      ports,
      yield* ports.workflowLoader.load(selectedWorkflowPath),
    )
    // A bootstrap that refuses takes the whole host down with it, so whatever it replaced is
    // released by the composition root's own scope rather than by a drain that never runs.
    const bootstrapWorkflow = yield* bootstrap.value
    yield* cleanupTerminalWorkspaces(bootstrapWorkflow)

    const handoffStorePath = resolve(
      bootstrapWorkflow.workflow.config.workspaceRoot,
      '.symphony',
      'handoffs.json',
    )
    // Handoff disabled: the store is deliberately left unread, so the empty in-memory list must
    // never be written back over it. A later handoff-enabled run still has to restore those
    // pull requests.
    const handoffStoreDisabled = bootstrapWorkflow.codeReview === null
    const restored = yield* handoffStoreDisabled
      ? Effect.succeed({
          handoffs: [] as readonly HandoffSnapshot[],
          storeReadFailed: false,
          storeError: null,
        })
      : loadHandoffs(handoffStorePath).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              logError('handoff store read failed; preserving store during recovery', {
                action: 'handoff_store_read',
                outcome: 'failed',
                path: handoffStorePath,
                error: error.message,
              }).pipe(
                Effect.as({
                  handoffs: [] as readonly HandoffSnapshot[],
                  storeReadFailed: true,
                  storeError: {
                    operation: error.operation,
                    message: error.message,
                    observedAt: new Date(),
                  },
                }),
              ),
            onSuccess: (handoffs) =>
              Effect.succeed({ handoffs, storeReadFailed: false, storeError: null }),
          }),
        )

    const state = yield* Ref.make(
      Transitions.holdRetirements(initialState(bootstrapWorkflow, restored), bootstrap.retirements),
    )
    const mailbox = yield* Queue.unbounded<OrchestratorEvent>()

    const publish = Ref.update(state, Transitions.publishDetails)

    const makeEffectiveWorkflow = (
      workflow: Workflow,
    ): Effect.Effect<EffectiveWorkflow, WorkflowError> =>
      rebuildEffectiveWorkflow(ports, workflow).pipe(
        // Recorded before the outcome is raised: a rebuild that refused partway through has still
        // displaced whatever the cells it did reach were holding.
        Effect.tap((rebuilt) =>
          Ref.update(state, (current) => Transitions.holdRetirements(current, rebuilt.retirements)),
        ),
        Effect.flatMap((rebuilt) => rebuilt.value),
      )

    const detailRecord = (
      issue: Issue,
      attempt: number | null,
      dispatchLabels: readonly string[],
    ): Effect.Effect<AgentDetailRecord> =>
      Effect.suspend(() => {
        // Read before the transition, not inside it: a transition is a function of its inputs.
        const now = new Date()
        return Ref.modify(state, (current) => {
          // A new session supersedes whatever aged out for this issue.
          const noted = Transitions.revivedDetail(Transitions.noteIssue(current, issue), issue.id)
          const existing = noted.details.get(issue.id)
          if (existing !== undefined) {
            // The same record carries every attempt for the issue, so ordering and session identity
            // survive the boundary that separates them.
            const started = recordAttemptStarted(
              recordIssueRefreshed(existing, issue),
              now,
              attempt ?? 0,
            )
            return [started, Transitions.putDetail(noted, issue.id, started)]
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
          return [record, Transitions.putDetail(noted, issue.id, record)]
        })
      })

    const persistHandoffs: Effect.Effect<void> = Effect.gen(function* () {
      const current = yield* Ref.get(state)
      if (handoffStoreDisabled || !current.startupRecoveryFinished || current.storeReadFailed) {
        return
      }
      yield* saveHandoffs(handoffStorePath, Transitions.handoffSnapshots(current)).pipe(
        Effect.catchAll((error) => {
          const observedAt = new Date()
          return Ref.update(state, (failing) =>
            Transitions.setHandoffStoreError(Transitions.noteRecovery(failing, { failed: 1 }), {
              operation: error.operation,
              message: error.message,
              observedAt,
            }),
          ).pipe(
            Effect.zipRight(
              logError('handoff store write failed', {
                action: 'handoff_store_write',
                outcome: 'failed',
                path: handoffStorePath,
                error: error.message,
              }),
            ),
          )
        }),
      )
    })

    const hydrateRestoredHandoffs: Effect.Effect<void> = Effect.gen(function* () {
      const pending = yield* Ref.get(state)
      if (pending.pendingRestoredHandoffs.length === 0) {
        return
      }
      const fetched = yield* pending.lastKnownGood.tracker
        .fetchIssuesByIds(
          pending.pendingRestoredHandoffs.map((handoff) => issueId(handoff.issueId)),
        )
        .pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Ref.update(state, (failing) => Transitions.noteRecovery(failing, { failed: 1 })).pipe(
                Effect.zipRight(
                  logWarning('persisted handoff hydration failed; retrying later', {
                    action: 'handoff_hydration',
                    outcome: 'failed',
                    pending: pending.pendingRestoredHandoffs.length,
                    error: error.message,
                  }),
                ),
                Effect.as<readonly Issue[] | null>(null),
              ),
            onSuccess: (issues) => Effect.succeed<readonly Issue[] | null>(issues),
          }),
        )
      if (fetched === null) {
        return
      }
      yield* Ref.update(state, (current) => {
        const hydrated = new Set<string>()
        let next = current
        for (const restored of current.pendingRestoredHandoffs) {
          const issue = fetched.find((candidate) => candidate.id === restored.issueId)
          const numberMatch = /\/pulls?\/(\d+)(?:\/)?$/u.exec(restored.pullRequestUrl)
          const pullRequestNumber = Number(numberMatch?.[1])
          if (issue === undefined || !Number.isSafeInteger(pullRequestNumber)) {
            continue
          }
          next = Transitions.putHandoff(next, issue.id, {
            issue,
            execution: captureExecutionSnapshot(next.lastKnownGood, ''),
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
            repair:
              restored.repairStartedHeadSha === undefined || restored.repairStartedHeadSha === null
                ? Option.none()
                : Option.some({
                    issue,
                    startedHeadSha: restored.repairStartedHeadSha,
                    inFlight: false,
                    // Snapshots written before the flag existed recorded a baseline only once a
                    // worker had started, so their absence is a started worker.
                    workerStarted: restored.repairWorkerStarted ?? true,
                  }),
            reviewRequestedHeadSha: restored.reviewRequestedHeadSha ?? null,
            reviewCompletedHeadSha: restored.reviewCompletedHeadSha ?? null,
            observedAt: new Date(restored.observedAt),
          })
          next = Transitions.claimIssue(next, issue)
          hydrated.add(restored.issueId)
        }
        return Transitions.dropRestoredHandoffs(next, hydrated)
      })
    })

    const recoverMissingHandoffs: Effect.Effect<void> = Effect.gen(function* () {
      const opening = yield* Ref.get(state)
      if (opening.startupRecoveryFinished) {
        return
      }
      const effective = opening.lastKnownGood
      const codeReview = effective.codeReview
      if (codeReview === null) {
        yield* Ref.update(state, Transitions.finishStartupRecovery)
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
        const counts = yield* Ref.modify(state, (failing) => {
          const next = Transitions.noteRecovery(failing, { failed: 1 })
          return [next.recoveryCounts, next] as const
        })
        yield* logError('startup handoff recovery issue fetch failed; retrying later', {
          action: 'handoff_recovery',
          outcome: 'failed',
          loaded: counts.loaded,
          recovered: counts.recovered,
          skipped: counts.skipped,
          failed: counts.failed,
          error: fetched.error.message,
        })
        return
      }
      let attemptFailed = false
      for (const issue of fetched.issues) {
        if (!issue.dispatchable) {
          yield* Ref.update(state, (pass) =>
            Transitions.noteRecovery(Transitions.resolveRecovery(pass, issue.id), { skipped: 1 }),
          )
          continue
        }
        const labels = new Set(issue.labels.map((label) => label.trim().toLowerCase()))
        const isLabeled = requiredLabels.every(
          (label) => label.length > 0 && labels.has(label.trim().toLowerCase()),
        )
        const pass = yield* Ref.get(state)
        if (
          !isLabeled ||
          pass.handoffs.has(issue.id) ||
          pass.pendingRestoredHandoffs.some((handoff) => handoff.issueId === issue.id) ||
          pass.recoveryResolved.has(issue.id)
        ) {
          continue
        }
        const found = yield* codeReview.findExistingHandoff(issue).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: 'Failed' as const, error }),
            onSuccess: (result) => ({ _tag: 'Succeeded' as const, result }),
          }),
        )
        if (found._tag === 'Failed') {
          attemptFailed = true
          yield* Ref.update(state, (failing) => Transitions.noteRecovery(failing, { failed: 1 }))
          yield* logWarning('startup handoff recovery lookup failed; retrying later', {
            ...logContext(issue),
            action: 'handoff_recovery',
            outcome: 'failed',
            error: found.error.message,
          })
          continue
        }
        const foundResult = found.result
        if (foundResult._tag === 'NoBranch') {
          yield* Ref.update(state, (skipping) =>
            Transitions.noteRecovery(Transitions.resolveRecovery(skipping, issue.id), {
              skipped: 1,
            }),
          )
          continue
        }
        const observedAt = new Date()
        const inspected = yield* codeReview.inspectPullRequest(foundResult.pullRequestNumber).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: 'Failed' as const, error }),
            onSuccess: (observation) => ({ _tag: 'Succeeded' as const, observation }),
          }),
        )
        const disposition =
          inspected._tag === 'Succeeded'
            ? classifyPullRequest(inspected.observation)
            : { state: 'awaiting_checks' as const, reason: inspected.error.message }
        const opened = yield* detailRecord(issue, null, requiredLabels)
        const branchObserved = recordHandoff(opened, observedAt, {
          step: 'remote_branch',
          status: 'observed',
          message: `Remote branch ${foundResult.branchName} is present`,
          remoteBranch: foundResult.branchName,
        })
        yield* Ref.update(state, (recovering) => {
          const withDetail = Transitions.putDetail(
            recovering,
            issue.id,
            recordHandoff(branchObserved, observedAt, {
              step: 'pull_request',
              status: 'observed',
              message: 'Recovered an existing pull request during startup',
              pullRequest: {
                status: 'reused',
                number: foundResult.pullRequestNumber,
                url: foundResult.pullRequestUrl,
                state: disposition.state,
              },
            }),
          )
          const withHandoff = Transitions.putHandoff(withDetail, issue.id, {
            issue,
            execution: captureExecutionSnapshot(effective, ''),
            pullRequestNumber: foundResult.pullRequestNumber,
            pullRequestUrl: foundResult.pullRequestUrl,
            branchName: foundResult.branchName,
            state: disposition.state,
            headSha: inspected._tag === 'Succeeded' ? inspected.observation.headSha : null,
            reason: 'reason' in disposition ? disposition.reason : null,
            repairHeadShas: [],
            repairObservedHeadShas: [],
            repair: Option.none(),
            reviewRequestedHeadSha: null,
            reviewCompletedHeadSha: null,
            observedAt,
          })
          return Transitions.noteRecovery(
            Transitions.resolveRecovery(Transitions.claimIssue(withHandoff, issue), issue.id),
            { recovered: 1 },
          )
        })
        yield* logInfo('open pull request handoff recovered', {
          ...logContext(issue),
          action: 'handoff_recovery',
          outcome: 'recovered',
          branch: foundResult.branchName,
          pull_request_url: foundResult.pullRequestUrl,
        })
      }
      if (attemptFailed) {
        return
      }
      const finished = yield* Ref.modify(state, (pass) => {
        const next = Transitions.finishStartupRecovery(pass)
        return [next, next] as const
      })
      yield* logInfo('startup handoff recovery completed', {
        action: 'handoff_recovery',
        outcome: finished.storeReadFailed ? 'degraded' : 'completed',
        loaded: finished.recoveryCounts.loaded,
        recovered: finished.recoveryCounts.recovered,
        skipped: finished.recoveryCounts.skipped,
        failed: finished.recoveryCounts.failed,
      })
      yield* persistHandoffs
    })

    const applyLifecycleUpdate = (
      entry: RunningEntry,
      update: AgentEvent,
    ): Effect.Effect<RunningEntry> =>
      Effect.gen(function* () {
        const applied = Transitions.applyRunEvent(entry, update)
        if (applied.sessionId !== null && update.event === 'session_started') {
          yield* logInfo('action=session outcome=started', {
            ...sessionLogContext(applied),
            action: 'session',
            outcome: 'started',
            error: null,
          })
        }
        if (applied.sessionId !== null && update.event === 'turn_started') {
          yield* logInfo('action=turn outcome=started', {
            ...sessionLogContext(applied),
            action: 'turn',
            outcome: 'started',
            error: null,
          })
          return { ...applied, turnActive: true }
        }
        if (
          applied.sessionId !== null &&
          (update.event === 'turn/completed' ||
            update.event === 'turn/failed' ||
            update.event === 'turn/terminated') &&
          update.turnStatus !== null
        ) {
          const outcome = ports.agentRunner.semantics.turnOutcome(update.turnStatus)
          const completed = outcome === 'completed'
          const cancelled = outcome === 'cancelled'
          yield* (completed || cancelled ? logInfo : logError)(`action=turn outcome=${outcome}`, {
            ...sessionLogContext(applied),
            action: 'turn',
            outcome,
            error: completed || cancelled ? null : `turn finished with status ${update.turnStatus}`,
          })
          return { ...applied, turnActive: false }
        }
        return applied
      })

    const cancelRunning = (
      id: IssueId,
      cleanupWorkspace: boolean,
      reason = 'the orchestrator cancelled the run',
      repairDisposition: RepairDisposition = 'release',
    ): Effect.Effect<Option.Option<RunningEntry>> =>
      Effect.gen(function* () {
        const before = yield* Ref.get(state)
        const running = before.running.get(id)
        if (running === undefined) {
          return Option.none()
        }
        const queuedBeforeInterruption = before.pendingLifecycle.get(id)?.length ?? 0
        yield* Fiber.interrupt(running.fiber)
        const queuedLifecycle = yield* Ref.modify(state, (current) =>
          Transitions.takePendingLifecycle(current, id),
        )
        let entry = running
        for (const update of queuedLifecycle.slice(0, queuedBeforeInterruption)) {
          entry = yield* applyLifecycleUpdate(entry, update)
        }
        if (entry.sessionId !== null && entry.turnId !== null && entry.turnActive) {
          yield* logInfo('action=turn outcome=cancelled', {
            ...sessionLogContext(entry),
            action: 'turn',
            outcome: 'cancelled',
            error: null,
          })
          entry = { ...entry, turnActive: false }
        }
        const settled = yield* Ref.modify(state, (current) =>
          Transitions.applyPendingTelemetry(current, id, entry),
        )
        const endedAt = new Date()
        yield* Ref.update(state, (current) => {
          const [, ended] = Transitions.endRun(current, id, null)
          const accounted = Transitions.accountEndedRun(ended, settled, endedAt.getTime())
          const handoff = accounted.handoffs.get(id)
          // `retain` leaves the identity for the retry that continues this repair; `settle` keeps
          // the baseline with nothing behind it, so one inspection can still attribute a head the
          // worker pushed before it stopped; `release` ends the repair outright.
          const disposed =
            handoff === undefined || repairDisposition === 'retain'
              ? accounted
              : Transitions.putHandoff(
                  accounted,
                  id,
                  repairDisposition === 'release' ? releaseRepair(handoff) : settleRepair(handoff),
                )
          return Transitions.releaseClaim(
            Transitions.updateDetail(disposed, id, (record) =>
              recordCancellation(record, endedAt, reason),
            ),
            id,
          )
        })
        if (repairDisposition !== 'retain') {
          yield* persistHandoffs
        }
        if (settled.sessionId !== null) {
          yield* logInfo('action=session outcome=cancelled', {
            ...sessionLogContext(settled),
            action: 'session',
            outcome: 'cancelled',
            error: null,
          })
        }
        if (cleanupWorkspace) {
          yield* settled.execution.workspaces.remove(settled.issue.identifier).pipe(
            Effect.catchAll((error) =>
              logWarning('terminal workspace cleanup failed', {
                ...logContext(settled.issue),
                action: 'workspace_cleanup',
                outcome: 'failed',
                error: error.message,
              }),
            ),
          )
        }
        return Option.some(settled)
      })

    const requestTick = (source: Transitions.TickSource): Effect.Effect<void> =>
      Ref.modify(state, (current) => Transitions.requestTick(current, source)).pipe(
        Effect.flatMap((decision) =>
          decision.enqueue
            ? Queue.offer(mailbox, { _tag: 'Tick' as const }).pipe(Effect.asVoid)
            : Effect.void,
        ),
      )

    const requestRefresh = Effect.gen(function* () {
      const reply = yield* Deferred.make<void>()
      yield* Ref.update(state, (current) => Transitions.awaitRefresh(current, reply))
      yield* requestTick('change')
      yield* Deferred.await(reply)
    })

    const scheduleNextTick: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
      const current = yield* Ref.get(state)
      if (current.pollTimer !== null) {
        yield* Fiber.interrupt(current.pollTimer)
      }
      const intervalMs = current.lastKnownGood.workflow.config.pollingIntervalMs
      const timer = yield* Effect.forkScoped(
        Effect.sleep(intervalMs).pipe(Effect.zipRight(requestTick('timer')), Effect.asVoid),
      )
      yield* Ref.update(state, (next) => Transitions.setPollTimer(next, timer))
    })

    const scheduleRetry = (
      issue: Issue,
      attempt: number,
      error: string | null,
      continuation: boolean,
      trackerError?: TrackerError,
    ): Effect.Effect<boolean, never, Scope.Scope> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        const maximumMs = current.lastKnownGood.workflow.config.agent.maxRetryBackoffMs
        const delayOption = continuation
          ? Option.some(1_000)
          : trackerError === undefined
            ? Option.some(yield* agentRetryDelay(attempt, maximumMs))
            : yield* trackerRetryDelay(trackerError, attempt, maximumMs)
        if (Option.isNone(delayOption)) {
          const cancelledAt = new Date()
          const reason = error ?? 'the tracker rejected the retry'
          yield* Ref.update(state, (pending) =>
            Transitions.updateDetail(
              Transitions.releaseClaim(pending, issue.id),
              issue.id,
              (record) => recordCancellation(record, cancelledAt, reason, true),
            ),
          )
          yield* logWarning('action=retry outcome=not_retryable', {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            action: 'retry',
            outcome: 'not_retryable',
            attempt,
            error,
          })
          return false
        }
        const delay = delayOption.value
        const dueAt = Date.now() + delay
        const fiber = yield* Effect.forkScoped(
          Effect.sleep(delay).pipe(
            Effect.zipRight(Queue.offer(mailbox, { _tag: 'RetryDue', issueId: issue.id, attempt })),
            Effect.asVoid,
          ),
        )
        const displaced = yield* Ref.modify(state, (pending) =>
          Transitions.scheduleRetry(pending, { issue, attempt, dueAt, error, fiber }),
        )
        if (Option.isSome(displaced)) {
          yield* Fiber.interrupt(displaced.value.fiber)
        }
        const scheduledAt = new Date()
        yield* Ref.update(state, (pending) =>
          Transitions.updateDetail(pending, issue.id, (record) =>
            recordRetryScheduled(record, scheduledAt, attempt, new Date(dueAt), error),
          ),
        )
        yield* logInfo('action=retry outcome=scheduled', {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          action: 'retry',
          outcome: 'scheduled',
          attempt,
          due_at: new Date(dueAt).toISOString(),
          error,
        })
        return true
      })

    const noteHandoffOutcome = (
      id: IssueId,
      handoff: HandoffEntry,
      outcome: 'pull_request_open' | 'merged' | 'intervention_required',
    ): Effect.Effect<void> =>
      Ref.update(state, (current) =>
        Transitions.updateDetail(current, id, (record) =>
          recordHandoff(record, handoff.observedAt, {
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
          }),
        ),
      )

    const reconcile: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
      const stalling = yield* Ref.get(state)
      if (stalling.running.size === 0) {
        return
      }
      const now = Date.now()
      for (const [id, entry] of stalling.running) {
        const stallTimeout = entry.execution.stallTimeoutMs
        const activeAt = entry.lastEventAt?.getTime() ?? entry.startedAt.getTime()
        if (stallTimeout > 0 && now - activeAt > stallTimeout) {
          const ended = yield* cancelRunning(
            id,
            false,
            `the agent stalled after ${String(stallTimeout)}ms without protocol activity`,
            // The retry scheduled just below continues this repair from the same baseline.
            'retain',
          )
          if (Option.isSome(ended)) {
            yield* scheduleRetry(
              ended.value.issue,
              (ended.value.attempt ?? 0) + 1,
              'agent stalled',
              false,
            )
          }
        }
      }
      const refreshing = yield* Ref.get(state)
      if (refreshing.running.size === 0) {
        return
      }
      for (const [id, entry] of refreshing.running) {
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
          // The handoff outlives the issue the tracker stopped reporting, so a head this worker
          // pushed is still the repair's to account for on the next inspection.
          yield* cancelRunning(id, false, 'the tracker no longer reports the issue', 'settle')
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
            // A worker may have pushed immediately before its issue stopped qualifying, and
            // nothing continues it: keep the baseline for one inspection so that head is
            // attributed. A terminal issue keeps its baseline untouched, so the next inspection
            // still reaches the verdict for a repair that changed nothing.
            terminal ? 'retain' : 'settle',
          )
        } else {
          yield* Ref.update(state, (current) =>
            Transitions.updateRun(current, id, (live) => ({ ...live, issue })),
          )
        }
      }
    })

    /**
     * The one bridge left from a plain callback into the runtime: an agent runner reports progress
     * synchronously, and what the report owes the run — the telemetry it buffers and the mailbox
     * event it raises — has to be applied from there. The runtime is captured once here rather than
     * re-derived per call, and the fork is attached to the orchestrator's scope, so work in flight
     * is interrupted with the orchestrator instead of outliving it.
     *
     * The effect a caller hands this must be one that completes without suspending — a state update
     * and an offer to an unbounded queue — because the fork starts immediately and the callback's
     * caller is entitled to assume the report has landed by the time it returns.
     */
    const runtime = yield* Effect.runtime<never>()
    const orchestratorScope = yield* Effect.scope
    const runFromCallback = (effect: Effect.Effect<void>): void => {
      Runtime.runFork(runtime)(effect, { scope: orchestratorScope })
    }

    const context: OrchestratorContext = {
      state,
      ports,
      selectedWorkflowPath,
      mailbox,
      detailRecord,
      scheduleRetry,
      applyLifecycleUpdate,
      cancelRunning,
      noteHandoffOutcome,
      persistHandoffs,
      recoverMissingHandoffs,
      reconcile,
      hydrateRestoredHandoffs,
      makeEffectiveWorkflow,
      scheduleNextTick,
      requestTick,
      runFromCallback,
      publish,
    }

    yield* hydrateRestoredHandoffs
    yield* publish

    // The watcher is installed before startup continues; only its consumption is forked, into the
    // orchestrator's scope, so the tick a change requests is interrupted on shutdown rather than
    // left running against a stopped orchestrator.
    const workflowWatcher = yield* WorkflowWatcher
    const workflowChanges = yield* workflowWatcher.changes(selectedWorkflowPath)
    yield* Effect.forkScoped(Stream.runForEach(workflowChanges, () => requestTick('change')))

    const eventLoopFiber = yield* Effect.forkScoped(eventLoop(context))
    yield* requestTick('startup')

    return {
      snapshot: Ref.get(state).pipe(
        Effect.map((current) => createSnapshot(current, selectedWorkflowPath)),
      ),
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
    // Workers are forked into this scope, and each one's interruption waits on a bounded agent
    // teardown. Closing them concurrently keeps the cost of shutdown independent of how many
    // agents were running, which is what lets the CLI's watchdog stay a last-resort path.
    Effect.parallelFinalizers(
      startOrchestratorRuntime(selectedWorkflowPath).pipe(
        Effect.flatMap((orchestrator) => orchestrator.awaitTermination),
      ),
    ),
  )
