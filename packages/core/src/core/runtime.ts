import { FileSystem } from '@effect/platform'
import { Clock, Deferred, Effect, Fiber, Option, Queue, Ref, Stream, type Scope } from 'effect'

import type { Issue, IssueId, JsonObject, TokenTotals } from '../domain/domain.js'
import type { TrackerError, WorkflowError } from '../domain/errors.js'
import type { HandoffSnapshot } from '../domain/handoff.js'
import type { AgentDetailRecord, AgentDetailSnapshot, AgentEvent } from '../telemetry.js'
import type { Workflow } from '../config/workflow.js'
import {
  AgentRunner,
  CurrentTracker,
  CurrentWorkspaceManager,
  WorkflowLoader,
  WorkflowWatcher,
} from '../ports/index.js'
import { eventLoop } from './polling.js'
import { requestRefresh } from './scheduling.js'
import { agentDetail, createSnapshot } from './snapshot.js'
import { openOrchestratorContext } from './startup.js'
import type {
  EffectiveWorkflow,
  HandoffEntry,
  RefreshOperation,
  RunningEntry,
  RuntimePorts,
  RuntimeState,
} from './state.js'
import type * as Transitions from './transitions.js'

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
  type RefreshOperation,
  type RetryEntry,
  type RunningEntry,
  type RuntimePorts,
  type RuntimeState,
  type WorkflowReloadError,
} from './state.js'
export { issueIsRoutable, sortIssues } from './policy.js'

export type RunningSnapshot = Readonly<{
  issueId: IssueId
  identifier: string
  title: string
  url: string | null
  /** The issue state the tracker reported for this run, as the tracker spells it. */
  state: string
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

/** What an accepted refresh request amounted to. */
export type RefreshOutcome = Readonly<{
  /**
   * Whether the request joined a pass somebody else had already arranged, rather than bringing one
   * into being. A burst of refreshes therefore costs one poll rather than one each, and the caller
   * whose request created the pass is the one told so.
   */
  coalesced: boolean
  /** When the host accepted the request. */
  requestedAt: string
  /** The stages the pass that answered this request actually reached, in order. */
  operations: readonly RefreshOperation[]
}>

export type OrchestratorControl = Readonly<{
  snapshot: Effect.Effect<OrchestratorSnapshot>
  /**
   * Requests a poll pass and completes when that pass has finished, so a caller that reads the
   * snapshot afterwards sees the state the refresh produced.
   */
  refresh: Effect.Effect<RefreshOutcome>
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
  /** The handoff store is read and written against the host filesystem the root bound. */
  | FileSystem.FileSystem
  | WorkflowLoader
  | WorkflowWatcher

/**
 * Where the persisted handoff snapshot lives, and the host filesystem bound to reach it.
 *
 * The filesystem is bound once at startup rather than read from each fiber that persists: the
 * runtime hands its own operations out as `Effect<void>` for a callback to run, and those carry no
 * context of their own.
 */
export type HandoffStoreBinding = Readonly<{
  path: string
  /**
   * Handoff disabled: the store is deliberately left unread, so the empty in-memory list must
   * never be written back over it. A later handoff-enabled run still has to restore those pull
   * requests.
   */
  disabled: boolean
  fileSystem: FileSystem.FileSystem
}>

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
  handoffStore: HandoffStoreBinding
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
  reconcile: (retryDispatchAllowed: boolean) => Effect.Effect<void, never, Scope.Scope>
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

export const startOrchestratorRuntime = (
  selectedWorkflowPath: string,
): Effect.Effect<OrchestratorControl, WorkflowError, OrchestratorServices | Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* openOrchestratorContext(selectedWorkflowPath)

    yield* context.hydrateRestoredHandoffs
    yield* context.publish

    // The watcher is installed before startup continues; only its consumption is forked, into the
    // orchestrator's scope, so the tick a change requests is interrupted on shutdown rather than
    // left running against a stopped orchestrator.
    const workflowWatcher = yield* WorkflowWatcher
    const workflowChanges = yield* workflowWatcher.changes(selectedWorkflowPath)
    yield* Effect.forkScoped(
      Stream.runForEach(workflowChanges, () => context.requestTick('change')),
    )

    const eventLoopFiber = yield* Effect.forkScoped(eventLoop(context))
    yield* context.requestTick('startup')

    return {
      snapshot: Effect.map(
        Effect.all([Ref.get(context.state), Clock.currentTimeMillis]),
        ([current, now]) => createSnapshot(current, selectedWorkflowPath, now),
      ),
      refresh: requestRefresh(context),
      agentDetail: (identifier) => agentDetail(context, identifier),
      setIssuePaused: (issueNumber, paused) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<void>()
          yield* Queue.offer(context.mailbox, {
            _tag: 'SetIssuePaused',
            issueNumber,
            paused,
            reply,
          })
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
