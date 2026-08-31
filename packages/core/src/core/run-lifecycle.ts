import { Clock, Effect, Fiber, Option, Ref, type Scope } from 'effect'

import type { IssueId } from '../domain/domain.js'
import { currentInstant } from '../support/clock.js'
import { logError, logInfo, logWarning } from '../support/logging.js'
import { asSettled } from '../support/settled.js'
import { recordCancellation, type AgentEvent } from '../telemetry.js'
import { releaseRepair, settleRepair } from './handoff-decision.js'
import { issueIsActive, logContext, sessionLogContext, stateIsIn } from './policy.js'
import type { OrchestratorContext } from './runtime.js'
import type { RepairDisposition, RunningEntry } from './state.js'
import * as Transitions from './transitions.js'

/**
 * What happens to a run between its dispatch and its end: the protocol events it reports, the
 * cancellation that stops it, and the reconciliation pass that decides it should no longer be
 * running at all.
 */

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
        // The outcome is the authoritative fact; a runner that reports no status string of
        // its own must still produce a legible line rather than one naming `null`.
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
 * Stops a running agent, settles the telemetry its worker had buffered, and releases the claim.
 * The repair disposition says what happens to a repair baseline the run was carrying.
 */
export const cancelRunning = (
  context: OrchestratorContext,
  id: IssueId,
  cleanupWorkspace: boolean,
  reason = 'the orchestrator cancelled the run',
  repairDisposition: RepairDisposition = 'release',
): Effect.Effect<Option.Option<RunningEntry>> =>
  Effect.gen(function* () {
    const before = yield* Ref.get(context.state)
    const running = before.running.get(id)
    if (running === undefined) {
      return Option.none()
    }
    const queuedBeforeInterruption = before.pendingLifecycle.get(id)?.length ?? 0
    yield* Fiber.interrupt(running.fiber)
    const queuedLifecycle = yield* Ref.modify(context.state, (current) =>
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
    const settled = yield* Ref.modify(context.state, (current) =>
      Transitions.applyPendingTelemetry(current, id, entry),
    )
    const endedAt = yield* currentInstant
    yield* Ref.update(context.state, (current) => {
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
      yield* context.persistHandoffs
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

/** Requests a tick, and says whether this request is the one that scheduled the pass. */

/**
 * Brings the running set back in line with what the tracker and the clock report: a stalled agent
 * is cancelled and retried, and a run whose issue has left its active states is stopped.
 */
export const reconcile = (
  context: OrchestratorContext,
  retryDispatchAllowed: boolean,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const stalling = yield* Ref.get(context.state)
    if (stalling.running.size === 0) {
      return
    }
    const now = yield* Clock.currentTimeMillis
    for (const [id, entry] of stalling.running) {
      const stallTimeout = entry.execution.stallTimeoutMs
      const activeAt = entry.lastEventAt?.getTime() ?? entry.startedAt.getTime()
      if (retryDispatchAllowed && stallTimeout > 0 && now - activeAt > stallTimeout) {
        const ended = yield* cancelRunning(
          context,
          id,
          false,
          `the agent stalled after ${String(stallTimeout)}ms without protocol activity`,
          // The retry scheduled just below continues this repair from the same baseline.
          'retain',
        )
        if (Option.isSome(ended)) {
          yield* context.scheduleRetry(
            ended.value.issue,
            (ended.value.attempt ?? 0) + 1,
            'agent stalled',
            false,
          )
        }
      }
    }
    const refreshing = yield* Ref.get(context.state)
    if (refreshing.running.size === 0) {
      return
    }
    for (const [id, entry] of refreshing.running) {
      const execution = entry.execution
      const refreshResult = yield* execution.tracker.fetchIssuesByIds([id]).pipe(asSettled)
      if (refreshResult._tag === 'Failed') {
        yield* logWarning('reconciliation failed; keeping worker running', {
          ...logContext(entry.issue),
          action: 'reconciliation',
          outcome: 'failed',
          error: refreshResult.error.message,
        })
        continue
      }
      const issue = refreshResult.value.find((candidate) => candidate.id === id)
      if (issue === undefined) {
        // The handoff outlives the issue the tracker stopped reporting, so a head this worker
        // pushed is still the repair's to account for on the next inspection.
        yield* cancelRunning(
          context,
          id,
          false,
          'the tracker no longer reports the issue',
          'settle',
        )
        continue
      }
      const terminal = stateIsIn(issue.state, execution.terminalStates)
      if (terminal || !issueIsActive(issue, execution)) {
        yield* cancelRunning(
          context,
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
        yield* Ref.update(context.state, (current) =>
          Transitions.updateRun(current, id, (live) => ({ ...live, issue })),
        )
      }
    }
  })
