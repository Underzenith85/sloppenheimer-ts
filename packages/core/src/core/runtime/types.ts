import type { DurableHost } from '../durable/live-journal.js'
import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { FileSystem } from '@effect/platform'
import type { Deferred, Effect, Option, Queue, Ref } from 'effect'

import type {
  Issue,
  IssueId,
  IssueIdentifier,
  JsonObject,
  TokenTotals,
} from '../../domain/domain.js'
import type { TrackerError, WorkflowError } from '../../domain/errors.js'
import type { HandoffSnapshot } from '../../domain/handoff.js'
import type { AgentDetailRecord, AgentDetailSnapshot, AgentEvent } from '../../telemetry.js'
import type { Workflow } from '../../config/workflow.js'
import type {
  AgentRunner,
  CurrentTracker,
  CurrentWorkspaceManager,
  WorkflowLoader,
  WorkflowWatcher,
} from '../../ports/index.js'
import type {
  CompletedSnapshot,
  EffectiveWorkflow,
  HandoffEntry,
  RefreshOperation,
  RunningEntry,
  RuntimePorts,
  RuntimeState,
} from '../state.js'
import type { DeliveryEntry, PostflightOutcome } from '../postflight.js'
import type { RebaseOutcome } from '../rebase.js'
import type { ExecutionOwner } from './execution.js'
import type { TickSource } from '../transitions.js'

/**
 * The bound on published finished work, and the record it publishes, both live in `state.ts`: the
 * completion store persists the same record, and a scheduler value the store writes belongs with
 * the state rather than with the wire types alone.
 */
export { publishedCompletedWork, type CompletedSnapshot } from '../state.js'

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

/**
 * Work an agent finished that is not on the remote yet. Published beside the running and retrying
 * rows because it is neither: no agent is running, and what is queued is a publication.
 */
export type DeliverySnapshot = Readonly<{
  issueId: IssueId
  identifier: string
  title: string
  url: string | null
  branchName: string
  /** How many publication attempts have failed for this work. */
  attempt: number
  dueAt: string
  category: string
  reason: string
  /** Paths the inspection found, or `null` when the inspection itself failed. */
  changedFileCount: number | null
  repairRun: boolean
  observedAt: string
  workerHost: 'local'
  detailUrl: string
  interventionRequired?: boolean
}>

/**
 * What one issue keeps on disk: its retained run workspaces, counted and measured after the last
 * run of it ended. Published so an operator sees an issue whose attempts keep leaving whole
 * checkouts behind before the disk does.
 */
export type RetainedWorkspaceSnapshot = Readonly<{
  issueId: IssueId
  identifier: string
  count: number
  bytes: number
  observedAt: string
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
  durableWorkflows?: readonly DurableWorkflow[]
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
  /** How many retained run workspaces one issue keeps, as the workflow in force sets it. */
  retainedWorkspaceLimit: number
  counts: Readonly<{ running: number; retrying: number; delivering: number; completed: number }>
  pausedIssueNumbers: readonly number[]
  handoffs: readonly HandoffSnapshot[]
  running: readonly RunningSnapshot[]
  retrying: readonly RetrySnapshot[]
  /**
   * Work waiting to reach the remote. An operator that sees a row here is being told the agent
   * succeeded and the publication did not, which the running and retrying rows cannot say.
   */
  delivering: readonly DeliverySnapshot[]
  /** Finished work, newest first and bounded by {@link publishedCompletedWork}. */
  completed: readonly CompletedSnapshot[]
  /** Issues holding retained run workspaces, largest first. Measured after each run ends. */
  retainedWorkspaces: readonly RetainedWorkspaceSnapshot[]
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
  awaitTermination: Effect.Effect<never, WorkflowError>
}>

/**
 * What one delivery attempt amounted to, decided off the event loop and settled on it.
 *
 * `Held` and `Discarded` are the dispositions a re-read of the issue reaches — an operator pause
 * holds the work, an issue that is finished with discards it — and `DiscardFailed` is a removal
 * that did not happen, which leaves the files exactly where they were. `Abandoned` is a host with
 * nothing to publish through at all. `Settled` carries whatever the publication answered, for the
 * same settlement a turn's own postflight goes through.
 */
export type DeliveryAttemptResult =
  | Readonly<{ _tag: 'Held' }>
  | Readonly<{ _tag: 'Discarded' }>
  | Readonly<{ _tag: 'DiscardFailed'; error: string }>
  | Readonly<{ _tag: 'Abandoned' }>
  | Readonly<{ _tag: 'Settled'; outcome: PostflightOutcome }>

export type OrchestratorEvent =
  | Readonly<{ _tag: 'Tick' }>
  | Readonly<{
      _tag: 'AgentStarted'
      issueId: IssueId
      runId: number
      applied: Deferred.Deferred<boolean>
    }>
  | Readonly<{ _tag: 'WorkerCrashed'; issueId: IssueId; runId: number }>
  | Readonly<{ _tag: 'AgentUpdate'; issueId: IssueId; runId: number; update: AgentEvent }>
  // The agent is done and the host has taken the workspace over. Nothing about the run changes
  // except who is working, which is what the stall timer needs to know.
  // `applied` is completed once the marker is in the state. The worker waits for it before the
  // first git call: offering alone only enqueues, and a poll already in flight would still read the
  // run as an agent that has gone quiet — and retire the publication as a stalled agent.
  | Readonly<{
      _tag: 'PostflightStarted'
      issueId: IssueId
      runId: number
      applied: Deferred.Deferred<void>
    }>
  | Readonly<{
      _tag: 'WorkerExited'
      issueId: IssueId
      runId: number
      attempt: number | null
      /**
       * How the agent protocol itself ended. It is not a verdict on the work: what the host made
       * of the workspace afterwards is `postflight`, and only the two together say what the run
       * achieved.
       */
      outcome: 'normal' | 'failed'
      error: string | null
      postflight: PostflightOutcome
    }>
  | Readonly<{ _tag: 'RetryDue'; issueId: IssueId; attempt: number }>
  /**
   * What an issue keeps on disk, as the worker that has just ended counted it after bounding it.
   * Reported from the worker's fiber rather than written there, because the count is the state's;
   * `runId` names that worker, so a count a terminal cleanup has since overtaken is refused.
   */
  | Readonly<{
      _tag: 'RetainedWorkspacesObserved'
      issueId: IssueId
      identifier: IssueIdentifier
      runId: number
      count: number
      bytes: number
    }>
  /** A retained delivery's next publication attempt is due. No agent runs for this. */
  | Readonly<{ _tag: 'DeliveryDue'; issueId: IssueId; attempt: number }>
  /**
   * What that attempt did, reported from the fiber that ran it. The attempt itself is git and
   * tracker work, so it runs off the event loop; everything it decides comes back here, because
   * the state it settles is the loop's to write.
   */
  | Readonly<{
      _tag: 'DeliveryAttempted'
      issueId: IssueId
      attempt: number
      result: DeliveryAttemptResult
    }>
  /**
   * What the host's rebase of a pull request that fell behind the base amounted to, reported from
   * the fiber that performed it. Git, so off the loop like a delivery; `headSha` names the head it
   * was started from, which is what tells a settlement for a superseded attempt from the live one.
   */
  | Readonly<{
      _tag: 'RebaseAttempted'
      issueId: IssueId
      headSha: string
      outcome: RebaseOutcome
    }>
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
 * One of the documents the host keeps beside its workspace, and how an operation reaches the
 * filesystem holding it.
 *
 * The store names its file rather than its path, because a reload may move `workspaceRoot`: a
 * write resolves the root in force through `storePath`, so a store is never written beside a root
 * the host has left and then looked for beside the one it moved to.
 *
 * The filesystem is bound once at startup rather than read from each fiber that persists: the
 * runtime hands its own operations out as `Effect<void>` for a callback to run, and those carry no
 * context of their own.
 */
export type RuntimeStore = Readonly<{
  /** The document's name under `.sloppenheimer/`. */
  file: string
  /**
   * Whether this store is left alone entirely. Handoff disabled: neither store is read, so the
   * empty in-memory lists must never be written back over them — a later handoff-enabled run still
   * has to restore those pull requests and republish that finished work. A completion store whose
   * read failed is disabled for the same reason: what it holds has not been seen.
   */
  disabled: boolean
  onHostFileSystem: <Value, Error>(
    effect: Effect.Effect<Value, Error, FileSystem.FileSystem>,
  ) => Effect.Effect<Value, Error>
}>

/** The two documents that outlive the host: the pull requests it is following, and what it merged. */
export type RuntimeStores = Readonly<{
  handoffs: RuntimeStore
  completions: RuntimeStore
}>

/**
 * What the extracted runtime operations take in place of closing over the factory's scope: the
 * state cell, the mailbox they enqueue against, and the stores they persist to.
 *
 * The state is one `Ref` rather than a record of mutable containers, so every operation states its
 * change as a transition applied to it. A reader sees one coherent value; a writer replaces it.
 */
export type RuntimeCells = Readonly<{
  durable?: DurableHost
  state: Ref.Ref<RuntimeState>
  mailbox: Queue.Queue<OrchestratorEvent>
  stores: RuntimeStores
  /**
   * The fibers the host owns: workers, retry timers, delivery attempts and the polling timer, keyed
   * by purpose and issue. Execution only — what is running is the state's to say.
   */
  execution: ExecutionOwner
}>

/**
 * A delivery as its caller states it: everything but the schedule, which `scheduleDelivery`
 * decides, and the attempt it forks to keep.
 */
export type DeliveryRequest = Omit<
  DeliveryEntry,
  'dueAt' | 'observedAt' | 'publishingSince' | 'armed'
>

/**
 * What a runtime operation is handed when it is reached through the context rather than called
 * directly: every field is one of the extracted operations, bound to the cells the factory made.
 */
export type OrchestratorContext = Readonly<{
  durable?: DurableHost
  state: Ref.Ref<RuntimeState>
  ports: RuntimePorts
  selectedWorkflowPath: string
  mailbox: Queue.Queue<OrchestratorEvent>
  /** The scoped owner of every fiber the host forks. See `runtime/execution.ts`. */
  execution: ExecutionOwner
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
    repairRun: boolean,
    trackerError?: TrackerError,
  ) => Effect.Effect<boolean>
  /**
   * Queues another publication of work already in a workspace. Answers `false` when the work
   * cannot be delivered as it stands, which is the caller's signal to fall back to an agent retry.
   */
  scheduleDelivery: (request: DeliveryRequest) => Effect.Effect<boolean>
  /** Discards retained unpublished work, per the cancellation policy in `AGENTS.md`. */
  abandonDelivery: (id: IssueId, reason: string) => Effect.Effect<void>
  /**
   * Holds retained work without discarding it: the attempt waiting to publish is called off and
   * the change stays in its workspace. What an operator pause does to a delivery.
   */
  suspendDelivery: (id: IssueId, reason: string) => Effect.Effect<void>
  /** Arms a suspended delivery again, from the attempt it was suspended on. */
  resumeDelivery: (entry: DeliveryEntry) => Effect.Effect<void>
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
  /** Records the finished work this host can still show, so a restart does not empty Finished. */
  persistCompletions: Effect.Effect<void>
  recoverMissingHandoffs: Effect.Effect<void>
  reconcile: (retryDispatchAllowed: boolean) => Effect.Effect<void>
  hydrateRestoredHandoffs: Effect.Effect<void>
  makeEffectiveWorkflow: (workflow: Workflow) => Effect.Effect<EffectiveWorkflow, WorkflowError>
  scheduleNextTick: Effect.Effect<void>
  requestTick: (source: TickSource) => Effect.Effect<void>
  /**
   * Runs a settling effect from a plain callback, on the orchestrator's own runtime and inside its
   * scope. The effect must complete without suspending; see the bridge's definition.
   */
  runFromCallback: (effect: Effect.Effect<void>) => void
  /** Rebuilds the published detail index. Runs after every transition the event loop makes. */
  publish: Effect.Effect<void>
}>
