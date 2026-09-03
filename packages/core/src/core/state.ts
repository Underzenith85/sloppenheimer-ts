import type { Deferred, Effect, MutableRef, Option } from 'effect'

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
import type { DeliveryEntry } from './postflight.js'

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
  /**
   * Sessions with a live worker. The worker fiber itself is owned by `runtime/execution.ts`, keyed
   * by issue: this map is what the host is running, not how it is running it.
   */
  running: ReadonlyMap<IssueId, RunningEntry>
  /** Issues this orchestrator has taken responsibility for, in any phase. */
  claimed: ReadonlySet<IssueId>
  retries: ReadonlyMap<IssueId, RetryEntry>
  /**
   * Work an agent produced that is not on the remote yet, keyed by issue. A delivery is a claim
   * held without a running worker: the agent is finished with, and only the publication is owed.
   */
  deliveries: ReadonlyMap<IssueId, DeliveryEntry>
  /** Finished work, keyed by issue: enough of each to say what Sloppenheimer merged, and when. */
  completed: ReadonlyMap<IssueId, CompletedEntry>
  /**
   * Finished work an earlier host recorded, restored from the completion store and already
   * filtered to the Finished window.
   *
   * Deliberately not folded into `completed`, and read by nothing but `createSnapshot`. A restored
   * completion is history this host is republishing, not work it performed: it holds no claim, has
   * no detail record and no session behind it, so admitting it to the map that `publishDetails`
   * consults would change how the versioned agent-detail resource answers after a restart. The
   * console's Finished view is what asked for this, and the console reads the snapshot.
   */
  restoredCompletions: readonly CompletedSnapshot[]
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
  /**
   * When the host's own postflight took over from the agent, if it has.
   *
   * The stall timer measures silence on the agent protocol, and a postflight is silent on it by
   * construction: no agent is running. Without this, an inspection or a push that outlasts the
   * timeout reads as a stalled agent and is retired as one — turning a slow delivery into another
   * coding turn, which is the exact confusion the postflight exists to end.
   */
  postflightStartedAt: Date | null
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

/**
 * One piece of finished work as it is published and as it is persisted: the same record as
 * {@link CompletedEntry} with its instant as a wire timestamp. The console reads it off the
 * snapshot and the completion store writes it to disk, so the two never drift apart.
 */
export type CompletedSnapshot = Readonly<{
  issueId: IssueId
  identifier: string
  title: string
  url: string | null
  outcome: 'merged'
  finishedAt: string
  pullRequestUrl: string | null
}>

export type RetryEntry = Readonly<{
  issue: Issue
  attempt: number
  /** Preserved independently of `attempt`, which counts every kind of worker retry. */
  repairRun: boolean
  dueAt: number
  error: string | null
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
  /**
   * What the host made of this repair's workspace once its turn settled. An unchanged pull-request
   * head means the repair achieved nothing only when this says the worktree was clean; a delivery
   * that failed left work behind, and reading that as "completed without changing the head" is the
   * defect this field exists to make impossible.
   */
  publication: RepairPublication
  /**
   * The commit that publication produced, when it produced one. It is what tells a stale
   * pull-request observation from a publication that genuinely changed nothing: an unchanged head
   * beside a different published head is the provider catching up, not a repair that achieved
   * nothing.
   */
  publishedHeadSha: string | null
}>

/**
 * The postflight verdict a repair carries, as the handoff state machine needs it.
 *
 * `pending` is a repair whose turn has not settled yet — including one dispatched but not started.
 */
export type RepairPublication = 'pending' | 'published' | 'no_changes' | 'delivery_failed'

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

/**
 * A rebase the host is performing on a pull request that fell behind the protected base. It is a
 * host action rather than a repair: no agent runs, no repair budget is spent, and the identity is
 * in-memory only -- a restart finds the branch either still behind, and rebases it again, or
 * already moved, and observes the new head.
 */
export type RebaseEntry = Readonly<{
  /** The pull-request head the rebase was started from, and the lease it publishes under. */
  headSha: string
  /**
   * The head the rebase pushed, or `null` while the attempt is still running. Kept until the
   * provider reports it: an observation that still carries `headSha` is the provider catching up,
   * not a branch that is behind again.
   */
  publishedHeadSha: string | null
}>

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
  /** The host rebase in flight for this pull request, which nothing else may act on meanwhile. */
  rebase: Option.Option<RebaseEntry>
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

/**
 * How much finished work the snapshot publishes, and how much of it the completion store keeps.
 * The console scopes its Finished view to a time window, so both are bounded by recency rather
 * than by however many issues a long-lived host has merged.
 */
export const publishedCompletedWork = 50

/**
 * How far back restored finished work reaches: completions older than this are not read back at
 * startup, because nothing would ever show them.
 *
 * This is the console's Finished window. The console states its own copy in
 * `src/operator/ui/model.ts` — its sources are classic browser scripts and cannot import this
 * module — and `test/operator/console-ux.test.ts` holds the two to the same span.
 */
export const completionWindowMs = 24 * 60 * 60 * 1000

/** How many issue identifiers are remembered for answering detail requests. */
export const rememberedIdentifiers = 500

export const initialState = (
  lastKnownGood: EffectiveWorkflow,
  restored: Readonly<{
    handoffs: readonly HandoffSnapshot[]
    completions: readonly CompletedSnapshot[]
    storeReadFailed: boolean
    storeError: HandoffStoreError | null
  }>,
): RuntimeState => ({
  running: new Map(),
  // A persisted handoff is a claim this orchestrator already holds, before its issue is hydrated.
  claimed: new Set(restored.handoffs.map((handoff) => issueId(handoff.issueId))),
  retries: new Map(),
  deliveries: new Map(),
  completed: new Map(),
  restoredCompletions: restored.completions,
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
