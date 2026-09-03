import { Effect, Option, Ref } from 'effect'

import type { Issue, IssueId } from '../../domain/domain.js'
import { issueBranchName } from '../../domain/handoff.js'
import { currentInstant } from '../../support/clock.js'
import { logError, logInfo, logWarning } from '../../support/logging.js'
import {
  agentOutcomes,
  handoffOutcomes,
  recordOutcome,
  type AgentOutcome,
} from '../../support/observability.js'
import {
  createAgentDetailRecord,
  recordAttemptStarted,
  recordCancellation,
  recordHandoff,
  recordIssueRefreshed,
  type AgentDetailRecord,
  type AgentEvent,
} from '../../telemetry.js'
import { workspaceKey } from '../../domain/workspace-containment.js'
import { logContext, sessionLogContext } from '../policy.js'
import { abandonDelivery } from './deliveries.js'
import { releaseIssueFiber } from './execution.js'
import { pruneRetainedWorkspaces, stopRetentionPass } from '../run-workspace.js'
import { releaseRepair, settleRepair } from '../repair.js'
import type { HandoffEntry, RepairDisposition, RunningEntry, RuntimeState } from '../state.js'
import * as Transitions from '../transitions.js'
import { persistHandoffs } from './store.js'
import type { RuntimeCells } from './types.js'

/** Opens or reuses the detail record for an issue that is about to be dispatched. */
export const openDetailRecord = (
  cells: RuntimeCells,
  issue: Issue,
  attempt: number | null,
  dispatchLabels: readonly string[],
): Effect.Effect<AgentDetailRecord> =>
  Effect.gen(function* () {
    // Read before the transition, not inside it: a transition is a function of its inputs.
    const now = yield* currentInstant
    return yield* Ref.modify(cells.state, (current) => {
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

/** Applies one protocol event to a run and says in the log what the event amounted to. */
export const applyLifecycleUpdate = (
  entry: RunningEntry,
  update: AgentEvent,
): Effect.Effect<RunningEntry> =>
  Effect.gen(function* () {
    const applied = Transitions.applyRunEvent(entry, update)
    const lifecycle = update.lifecycle
    if (applied.sessionId !== null && lifecycle?.phase === 'session_started') {
      yield* logInfo('action=session outcome=started', {
        ...sessionLogContext(applied),
        action: 'session',
        outcome: 'started',
        error: null,
      })
    }
    if (applied.sessionId !== null && lifecycle?.phase === 'turn_started') {
      yield* logInfo('action=turn outcome=started', {
        ...sessionLogContext(applied),
        action: 'turn',
        outcome: 'started',
        error: null,
      })
      return { ...applied, turnActive: true }
    }
    if (applied.sessionId !== null && lifecycle?.phase === 'turn_settled') {
      // The runner states the outcome on the settling event, so nothing here interprets one
      // backend's status vocabulary. `turnStatus` survives only as the operator-facing detail.
      const outcome = lifecycle.outcome
      const completed = outcome === 'completed'
      const cancelled = outcome === 'cancelled'
      yield* (completed || cancelled ? logInfo : logError)(`action=turn outcome=${outcome}`, {
        ...sessionLogContext(applied),
        action: 'turn',
        outcome,
        // The outcome is the authoritative fact; a runner that reports no status string of its own
        // must still produce a legible line rather than one naming `null`.
        error:
          completed || cancelled
            ? null
            : update.turnStatus === null
              ? `turn finished as ${outcome}`
              : `turn finished with status ${update.turnStatus}`,
      })
      return { ...applied, turnActive: false }
    }
    return applied
  })

/**
 * Interrupts a live run, settles whatever telemetry it had buffered, and disposes of the repair
 * identity it was holding.
 */
export const cancelRunning = (
  cells: RuntimeCells,
  id: IssueId,
  cleanupWorkspace: boolean,
  reason = 'the orchestrator cancelled the run',
  repairDisposition: RepairDisposition = 'release',
  agentOutcome: AgentOutcome = 'cancelled',
): Effect.Effect<Option.Option<RunningEntry>> =>
  Effect.gen(function* () {
    const before = yield* Ref.get(cells.state)
    const running = before.running.get(id)
    if (running === undefined) {
      return Option.none()
    }
    const queuedBeforeInterruption = before.pendingLifecycle.get(id)?.length ?? 0
    // Awaited, not merely signalled: the worker's finalizers release its workspace lease, and what
    // follows here settles the telemetry and may remove the very workspace it was holding.
    yield* releaseIssueFiber(cells.execution, 'worker', id)
    const queuedLifecycle = yield* Ref.modify(cells.state, (current) =>
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
    const settled = yield* Ref.modify(cells.state, (current) =>
      Transitions.applyPendingTelemetry(current, id, entry),
    )
    const endedAt = yield* currentInstant
    yield* Ref.update(cells.state, (current) =>
      endRunAt(current, id, settled, endedAt, reason, repairDisposition),
    )
    if (repairDisposition !== 'retain') {
      yield* persistHandoffs(cells)
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
      // Removing the workspace destroys anything unpublished in it, so the delivery that would
      // have republished it goes in the same step rather than coming due against a directory that
      // no longer exists.
      yield* abandonDelivery(cells, id, reason)
      yield* stopRetentionPass(cells.execution, id)
      yield* settled.execution.workspaces.remove(settled.issue.identifier).pipe(
        Effect.zipRight(
          Ref.update(cells.state, (current) => Transitions.forgetRetainedWorkspaces(current, id)),
        ),
        Effect.catchAll((error) =>
          logWarning('terminal workspace cleanup failed', {
            ...logContext(settled.issue),
            action: 'workspace_cleanup',
            outcome: 'failed',
            error: error.message,
          }),
        ),
      )
    } else {
      // The workspace stays, so what the issue keeps of its earlier attempts still has to be
      // bounded — and the worker's own tail never ran: an interruption does not reach it. This is
      // the stall loop's path, where every attempt would otherwise leave one more whole checkout.
      // The lease is already released: the interruption above was waited for.
      yield* pruneRetainedWorkspaces(cells, settled.issue, settled.execution, settled.runId)
    }
    yield* recordOutcome(agentOutcomes, agentOutcome)
    return Option.some(settled)
  })

/**
 * Ends the run, accounts for it, and disposes of its repair identity.
 *
 * `retain` leaves the identity for the retry that continues this repair; `settle` keeps the
 * baseline with nothing behind it, so one inspection can still attribute a head the worker pushed
 * before it stopped; `release` ends the repair outright.
 */
const endRunAt = (
  current: RuntimeState,
  id: IssueId,
  settled: RunningEntry,
  endedAt: Date,
  reason: string,
  repairDisposition: RepairDisposition,
): RuntimeState => {
  const [, ended] = Transitions.endRun(current, id, null)
  const accounted = Transitions.accountEndedRun(ended, settled, endedAt.getTime())
  const handoff = accounted.handoffs.get(id)
  const disposed =
    handoff === undefined || repairDisposition === 'retain'
      ? accounted
      : Transitions.putHandoff(
          accounted,
          id,
          repairDisposition === 'release' ? releaseRepair(handoff) : settleRepair(handoff),
        )
  return Transitions.releaseClaim(
    Transitions.updateDetail(disposed, id, (record) => recordCancellation(record, endedAt, reason)),
    id,
  )
}

/** Mirrors an observed pull-request disposition onto the issue's retained handoff detail. */
export const noteHandoffOutcome = (
  cells: RuntimeCells,
  id: IssueId,
  handoff: HandoffEntry,
  outcome: 'pull_request_open' | 'merged' | 'intervention_required',
): Effect.Effect<void> =>
  Ref.update(cells.state, (current) =>
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
  ).pipe(
    Effect.zipRight(
      outcome === 'pull_request_open'
        ? Effect.void
        : recordOutcome(handoffOutcomes, outcome === 'merged' ? 'merged' : 'intervention'),
    ),
  )
