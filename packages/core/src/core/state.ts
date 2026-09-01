import type { Deferred, Effect, Fiber, MutableRef, Option } from 'effect'

import type { Workflow } from '../config/workflow.js'
import { issueId } from '../domain/domain.js'
import type { Issue, IssueId, IssueIdentifier, JsonObject, TokenTotals } from '../domain/domain.js'
import type { HandoffSnapshot } from '../domain/handoff.js'
import type {
  AgentRunnerConfig,
  AgentRunnerPort,
  CodeReviewCell,
  CodeReviewPort,
  SourceControlCell,
  SourceControlPort,
  TrackerCell,
  TrackerPort,
  WorkflowLoaderPort,
  WorkspaceManagerCell,
  WorkspaceManagerPort,
} from '../ports/index.js'
import type { AgentDetailContext, AgentDetailRecord, AgentEvent } from '../telemetry.js'

/**
 * The scheduler's whole world, as one immutable value.
 *
 * Every field was a mutable `Map`, `Set`, or `let` binding in `startOrchestrator`'s closure. They
 * are gathered here so that a transition is a function from this value to the next one, testable
 * without booting an orchestrator, and so that a reader — the snapshot path above all — observes
 * one coherent instant rather than a set of containers mid-edit.
 *
 * The mailbox actor loop remains the single writer. Immutability is what makes its writes
 * expressible as pure functions, not a defence against a second writer that does not exist.
 */
/**
 * The stages one poll pass performs, in the order `polling.ts` performs them. A pass whose
 * credential or workflow validation failed stops before `dispatch`, so the stages a pass actually
 * reached are reported rather than assumed.
 */
export type RefreshOperation =
  | 'credential_revalidation'
  | 'handoff_recovery'
  | 'workflow_reload'
  | 'handoff_reconciliation'
  | 'issue_reconciliation'
  | 'dispatch'

export type RuntimeState = Readonly<{
  /** Sessions with a live worker fiber. */
  running: ReadonlyMap<IssueId, RunningEntry>
  /** Issues this orchestrator has taken responsibility for, in any phase. */
  claimed: ReadonlySet<IssueId>
  retries: ReadonlyMap<IssueId, RetryEntry>
  /** Finished work, keyed by issue: enough of each to say what Sloppenheimer merged, and when. */
  completed: ReadonlyMap<IssueId, CompletedEntry>
  pausedIssueNumbers: ReadonlySet<number>
  handoffs: ReadonlyMap<IssueId, HandoffEntry>
  totals: TokenTotals
  rateLimits: JsonObject | null

  /** Agent telemetry, keyed by issue and preserved across that issue's retries. */
  details: ReadonlyMap<IssueId, AgentDetailRecord>
  /** Issues whose detail record outlived its session, oldest first. */
  finishedDetails: readonly IssueId[]
  /**
   * Issues whose retained detail has since been evicted. A session that ended and then aged out
   * keeps answering as completed rather than degrading into "no session", which would tell an
   * operator the agent never ran.
   */
  agedOutDetails: ReadonlySet<IssueId>
  identifiers: ReadonlyMap<IssueId, IssueIdentifier>
  /**
   * The detail index consumers read. Rebuilt from `details` after every transition, so a reader
   * never sees an index that disagrees with the scheduler it was derived from.
   */
  publishedDetails: ReadonlyMap<string, PublishedDetail>

  /**
   * Telemetry the agent runner reported from its callback, held until the mailbox applies it to
   * the run it belongs to. The callback cannot write state; it enqueues, and these are what the
   * enqueued event resolves against.
   */
  pendingUsage: ReadonlyMap<IssueId, NonNullable<AgentEvent['usage']>>
  pendingLifecycle: ReadonlyMap<IssueId, readonly AgentEvent[]>
  pendingRateLimits: JsonObject | null

  /** Whether a tick is already queued in the mailbox, and so a further request coalesces into it. */
  tickQueued: boolean
  pollRunning: boolean
  /** A change observed during a poll, which owes the next poll a follow-up pass. */
  followUpRequested: boolean
  pollTimer: Fiber.Fiber<void> | null
  nextRunId: number
  /**
   * Callers awaiting the poll now running, and callers awaiting the one after it. Each is answered
   * with what its pass performed, so an acknowledgement reports that pass rather than a pass in
   * general.
   */
  currentRefreshWaiters: readonly Deferred.Deferred<readonly RefreshOperation[]>[]
  nextRefreshWaiters: readonly Deferred.Deferred<readonly RefreshOperation[]>[]

  /** The workflow and ports in force: the last configuration that validated. */
  lastKnownGood: EffectiveWorkflow
  workflowReloadError: WorkflowReloadError | null

  startupRecoveryFinished: boolean
  storeReadFailed: boolean
  handoffStoreError: HandoffStoreError | null
  recoveryCounts: HandoffRecoveryCounts
  /** Persisted handoffs still waiting for the tracker to answer with their issues. */
  pendingRestoredHandoffs: readonly HandoffSnapshot[]
  /** Issues startup recovery has already settled, so a later pass does not re-examine them. */
  recoveryResolved: ReadonlySet<IssueId>

  /** Replaced port instances whose release is still waiting on a live holder. */
  pendingRetirements: readonly PendingRetirement[]
  /**
   * Ports an adoption took away from a live run, keyed by that run. A call that read an instance a
   * moment before adoption replaced it is still using it, so the instance is held until the run
   * ends rather than until the reference is swapped. Keyed by run rather than by issue: the same
   * issue goes on to a handoff, and a retry after it starts a run that never touched these.
   */
  supersededPorts: ReadonlyMap<number, readonly unknown[]>
}>

/** The ports a session reaches its provider through, as they stand at the moment of the call. */
export type SessionPorts = Pick<ExecutionSnapshot, 'tracker' | 'codeReview' | 'sourceControl'>

export type RunningEntry = Readonly<{
  runId: number
  issue: Issue
  /**
   * The worker. Held as a plain `Fiber` because the only thing the scheduler ever does with it is
   * interrupt it, which keeps a transition testable with a fiber value that never ran.
   */
  fiber: Fiber.Fiber<void>
  execution: ExecutionSnapshot
  /**
   * This run's ports, in a cell the non-Effect world can read. A host tool leaves Effect for a
   * promise and so cannot take a turn on the state cell; adoption writes the replacement here at
   * the moment it rewrites `execution`, and the two are never allowed to disagree.
   */
  sessionPorts: MutableRef.MutableRef<SessionPorts>
  attempt: number | null
  /** Whether this worker was dispatched to repair an existing pull request. */
  repairRun: boolean
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
}>

/**
 * One piece of finished work, as the console shows it. The runtime already had to know which
 * issues had completed; it keeps enough of each to answer "what did Sloppenheimer finish, and when"
 * without the console inventing a session history of its own.
 */
export type CompletedEntry = Readonly<{
  issueId: IssueId
  identifier: string
  title: string
  url: string | null
  outcome: 'merged'
  finishedAt: Date
  pullRequestUrl: string | null
}>

export type RetryEntry = Readonly<{
  issue: Issue
  attempt: number
  /** Preserved independently of `attempt`, which counts every kind of worker retry. */
  repairRun: boolean
  dueAt: number
  error: string | null
  fiber: Fiber.Fiber<void>
}>

/**
 * A repair that owns a pull request head, from the decision to repair until the head it produced
 * has been attributed. It outlives a refused dispatch and the retry that follows one, so the
 * retry renders the same repair rather than the bare tracker issue.
 */
export type RepairEntry = Readonly<{
  /** The repair-shaped issue, retained so a refused dispatch can render the same repair on retry. */
  issue: Issue
  /** Pull-request head this repair was started from. */
  startedHeadSha: string
  /** False once nothing continues this repair: a restored baseline, or a settled cancellation. */
  inFlight: boolean
  /** Whether a worker actually started, as opposed to a dispatch refused before launch. */
  workerStarted: boolean
}>

/**
 * What a cancelled run does with the repair identity it was carrying.
 *
 * - `release`: the repair is over, so the identity goes with it.
 * - `retain`: leave the identity exactly as it stands, because something else still resolves it --
 *   a retry that continues this repair, or the next pull-request inspection, which is what reaches
 *   the verdict on a repair that changed nothing.
 * - `settle`: nothing continues it, but the worker may have pushed before it was cancelled, so the
 *   baseline outlives it for exactly one handoff inspection to attribute that head.
 */
export type RepairDisposition = 'release' | 'retain' | 'settle'

export type HandoffEntry = Readonly<{
  issue: Issue
  execution: ExecutionSnapshot
  pullRequestNumber: number
  pullRequestUrl: string
  branchName: string
  state: HandoffSnapshot['state']
  headSha: string | null
  reason: string | null
  /** Distinct heads observed after a repair agent finished; its length is the verified repair count. */
  repairHeadShas: readonly string[]
  /**
   * Every head this handoff has been observed at, baselines included. Cycle detection reads this
   * rather than repairHeadShas, which counts only post-repair heads and so never holds the head a
   * repair started from.
   */
  repairObservedHeadShas: readonly string[]
  /** The repair currently running or waiting to retry; None for ordinary worker continuations. */
  repair: Option.Option<RepairEntry>
  reviewRequestedHeadSha: string | null
  reviewCompletedHeadSha: string | null
  observedAt: Date
}>

export type EffectiveWorkflow = Readonly<{
  workflow: Workflow
  tracker: TrackerPort
  codeReview: Option.Option<CodeReviewPort>
  sourceControl: SourceControlPort | null
  workspaces: WorkspaceManagerPort
  loadedAt: Date
}>

export type ExecutionSnapshot = Readonly<{
  workflow: Workflow
  tracker: TrackerPort
  codeReview: Option.Option<CodeReviewPort>
  sourceControl: SourceControlPort | null
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

export type HandoffRecoveryCounts = Readonly<{
  loaded: number
  recovered: number
  skipped: number
  failed: number
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

/**
 * An instance a rebuild replaced, held until the last live holder lets go of it. Adoption moves
 * running workers and in-flight handoffs onto the replacement, but a worker still holds whatever
 * its execution snapshot captured, and a handoff holds the workspace manager its run created.
 */
export type PendingRetirement = Readonly<{
  kind: 'tracker' | 'codeReview' | 'sourceControl' | 'workspaces'
  instance: unknown
  retire: Effect.Effect<void>
}>

/**
 * The ports the orchestrator resolved at startup, and the cells through which a reload or a
 * credential rotation installs their replacements.
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
  /** None when host-owned publication is not composed. */
  sourceControlCell: Option.Option<SourceControlCell>
}>

/** How many finished agents keep their timeline for post-mortem inspection. */
export const retainedCompletedDetails = 16

/** How many issue identifiers are remembered for answering detail requests. */
export const rememberedIdentifiers = 500

export const initialState = (
  lastKnownGood: EffectiveWorkflow,
  restored: Readonly<{
    handoffs: readonly HandoffSnapshot[]
    storeReadFailed: boolean
    storeError: HandoffStoreError | null
  }>,
): RuntimeState => ({
  running: new Map(),
  // A persisted handoff is a claim this orchestrator already holds, before its issue is hydrated.
  claimed: new Set(restored.handoffs.map((handoff) => issueId(handoff.issueId))),
  retries: new Map(),
  completed: new Map(),
  pausedIssueNumbers: new Set(),
  handoffs: new Map(),
  totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
  rateLimits: null,
  details: new Map(),
  finishedDetails: [],
  agedOutDetails: new Set(),
  identifiers: new Map(),
  publishedDetails: new Map(),
  pendingUsage: new Map(),
  pendingLifecycle: new Map(),
  pendingRateLimits: null,
  tickQueued: false,
  pollRunning: false,
  followUpRequested: false,
  pollTimer: null,
  nextRunId: 1,
  currentRefreshWaiters: [],
  nextRefreshWaiters: [],
  lastKnownGood,
  workflowReloadError: null,
  startupRecoveryFinished: false,
  storeReadFailed: restored.storeReadFailed,
  handoffStoreError: restored.storeError,
  recoveryCounts: {
    loaded: restored.handoffs.length,
    recovered: 0,
    skipped: 0,
    failed: restored.storeReadFailed ? 1 : 0,
  },
  pendingRestoredHandoffs: restored.handoffs,
  recoveryResolved: new Set(),
  pendingRetirements: [],
  supersededPorts: new Map(),
})
