import { Effect, Option, Ref } from 'effect'

import { issueId, type Issue } from '../../domain/domain.js'
import { classifyPullRequest, type HandoffSnapshot } from '../../domain/handoff.js'
import { currentInstant } from '../../support/clock.js'
import { logError, logInfo, logWarning } from '../../support/logging.js'
import { asSettled } from '../../support/settled.js'
import { recordHandoff } from '../../telemetry.js'
import type { CodeReviewPort, TrackerPort } from '../../ports/index.js'
import { captureExecutionSnapshot, issueIsRoutable, logContext } from '../policy.js'
import type { EffectiveWorkflow, ExecutionSnapshot, HandoffEntry } from '../state.js'
import * as Transitions from '../transitions.js'
import { persistHandoffs } from './store.js'
import { openDetailRecord } from './runs.js'
import type { RuntimeCells } from './types.js'

/**
 * Turns the handoffs read from the store into live entries, once the tracker has answered for the
 * issues behind them.
 *
 * One issue at a time, for the reason `handoff-eligibility.ts` gives for its refreshes: the tracker
 * boundary fails fast even when it accepts several ids, so one issue GitHub no longer has would
 * fail the whole batch and leave every restored pull request unhydrated — and claimed — on every
 * poll. A fetch that failed leaves its own handoff pending, so the next pass tries again. An issue
 * the tracker says is gone, or simply no longer returns, can never hydrate: its snapshot is dropped
 * and its claim released, because otherwise nothing would ever dispatch that issue again.
 */
export const hydrateRestoredHandoffs = (cells: RuntimeCells): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pending = yield* Ref.get(cells.state)
    if (pending.pendingRestoredHandoffs.length === 0) {
      return
    }
    let dropped = false
    for (const restored of pending.pendingRestoredHandoffs) {
      dropped =
        (yield* hydrateRestoredHandoff(cells, pending.lastKnownGood.tracker, restored)) || dropped
    }
    if (dropped) {
      // A dropped snapshot must not come back with the next restart. While startup recovery is
      // still running this is a no-op, and `finishRecovery` writes the store itself.
      yield* persistHandoffs(cells)
    }
  })

/**
 * Hydrates one restored handoff against the tracker, and says whether its snapshot was dropped.
 *
 * Only a `tracker_not_found` answer and an issue missing from a successful answer count as gone.
 * Every other failure — a credential refused, a record that would not decode, a transient status —
 * says nothing about the issue itself, so the handoff stays pending and is tried again.
 */
const hydrateRestoredHandoff = (
  cells: RuntimeCells,
  tracker: TrackerPort,
  restored: HandoffSnapshot,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const pullRequestNumber = restoredPullRequestNumber(restored)
    if (Option.isNone(pullRequestNumber)) {
      yield* dropRestoredHandoff(cells, restored, 'its pull request URL names no number to inspect')
      return true
    }
    const fetched = yield* tracker.fetchIssuesByIds([issueId(restored.issueId)]).pipe(asSettled)
    if (fetched._tag === 'Failed' && fetched.error.category !== 'tracker_not_found') {
      yield* Ref.update(cells.state, (failing) => Transitions.noteRecovery(failing, { failed: 1 }))
      yield* logWarning('persisted handoff hydration failed; retrying later', {
        ...restoredLogContext(restored),
        action: 'handoff_hydration',
        outcome: 'failed',
        error: fetched.error.message,
      })
      return false
    }
    if (fetched._tag === 'Failed') {
      yield* dropRestoredHandoff(
        cells,
        restored,
        `the tracker has no such issue: ${fetched.error.message}`,
      )
      return true
    }
    const issue = fetched.value.find((candidate) => candidate.id === restored.issueId)
    if (issue === undefined) {
      yield* dropRestoredHandoff(cells, restored, 'the tracker no longer reports its issue')
      return true
    }
    yield* Ref.update(cells.state, (current) =>
      Transitions.dropRestoredHandoffs(
        Transitions.putHandoff(
          current,
          issue.id,
          restoredHandoffEntry(
            issue,
            restored,
            pullRequestNumber.value,
            captureExecutionSnapshot(current.lastKnownGood, ''),
          ),
        ),
        new Set([restored.issueId]),
      ),
    )
    return false
  })

/**
 * Gives up a restored handoff nothing can hydrate: the snapshot goes and the claim it held since
 * startup is released, so the issue is dispatchable again if the tracker does report it. Counted as
 * skipped, which is what recovery reports for a pull request it read but did not adopt.
 */
const dropRestoredHandoff = (
  cells: RuntimeCells,
  restored: HandoffSnapshot,
  reason: string,
): Effect.Effect<void> =>
  Ref.update(cells.state, (dropping) =>
    Transitions.noteRecovery(
      Transitions.releaseRestoredHandoff(dropping, issueId(restored.issueId)),
      { skipped: 1 },
    ),
  ).pipe(
    Effect.zipRight(
      logWarning('persisted handoff dropped; its claim is released', {
        ...restoredLogContext(restored),
        action: 'handoff_hydration',
        outcome: 'dropped',
        pull_request_url: restored.pullRequestUrl,
        reason,
      }),
    ),
  )

/** The issue context a snapshot can supply before its issue has been fetched. */
const restoredLogContext = (restored: HandoffSnapshot): Readonly<Record<string, string>> => ({
  issue_id: restored.issueId,
  issue_identifier: restored.identifier,
})

/** The pull-request number a snapshot's URL names, when it names one. */
const restoredPullRequestNumber = (restored: HandoffSnapshot): Option.Option<number> => {
  const numberMatch = /\/pulls?\/(\d+)(?:\/)?$/u.exec(restored.pullRequestUrl)
  const pullRequestNumber = Number(numberMatch?.[1])
  return Number.isSafeInteger(pullRequestNumber) ? Option.some(pullRequestNumber) : Option.none()
}

/**
 * Reads one persisted snapshot back as a live handoff. Migration of the older shapes lives here: a
 * snapshot written before a field existed is read as the most its author can honestly have meant.
 */
const restoredHandoffEntry = (
  issue: Issue,
  restored: HandoffSnapshot,
  pullRequestNumber: number,
  execution: ExecutionSnapshot,
): HandoffEntry => {
  const repairStartedHeadSha = restored.repairStartedHeadSha ?? null
  return {
    issue,
    execution,
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
    // Legacy snapshots conflated worker retries with repairs. An absent head list migrates to zero
    // verified repairs rather than preserving a contaminated counter.
    repairHeadShas: [...(restored.repairHeadShas ?? [])],
    // A legacy snapshot has no observed set; its post-repair heads plus any in-flight baseline are
    // the most it can honestly contribute.
    repairObservedHeadShas: [
      ...new Set([
        ...(restored.repairObservedHeadShas ?? restored.repairHeadShas ?? []),
        ...(repairStartedHeadSha === null ? [] : [repairStartedHeadSha]),
      ]),
    ],
    // Preserved rather than cleared: a repair may have pushed a new head just before the restart,
    // and the first observation after recovery needs this baseline to attribute it.
    repair:
      repairStartedHeadSha === null
        ? Option.none()
        : Option.some({
            issue,
            startedHeadSha: repairStartedHeadSha,
            inFlight: false,
            // Snapshots written before the flag existed recorded a baseline only once a worker had
            // started, so their absence is a started worker.
            workerStarted: restored.repairWorkerStarted ?? true,
            publication: restored.repairPublication ?? 'pending',
            publishedHeadSha: restored.repairPublishedHeadSha ?? null,
          }),
    reviewRequestedHeadSha: restored.reviewRequestedHeadSha ?? null,
    reviewCompletedHeadSha: restored.reviewCompletedHeadSha ?? null,
    observedAt: new Date(restored.observedAt),
  }
}

/**
 * Adopts the open pull requests this host left behind but has no record of, once per start. It runs
 * until it completes a pass with nothing failing; a pass that failed anywhere leaves recovery
 * unfinished, so the next poll retries it rather than declaring the store authoritative.
 */
export const recoverMissingHandoffs = (cells: RuntimeCells): Effect.Effect<void> =>
  Effect.gen(function* () {
    const opening = yield* Ref.get(cells.state)
    if (opening.startupRecoveryFinished) {
      return
    }
    const effective = opening.lastKnownGood
    const codeReview = effective.codeReview
    if (Option.isNone(codeReview)) {
      yield* Ref.update(cells.state, Transitions.finishStartupRecovery)
      return
    }
    const requiredLabels = effective.workflow.config.tracker.requiredLabels
    const fetched = yield* effective.tracker
      .fetchIssuesByStates(effective.workflow.config.tracker.activeStates, null, {
        hydrateDependencies: false,
      })
      .pipe(asSettled)
    if (fetched._tag === 'Failed') {
      yield* noteRecoveryFetchFailure(cells, fetched.error.message)
      return
    }
    let attemptFailed = false
    for (const issue of fetched.value) {
      if (!issue.dispatchable) {
        yield* Ref.update(cells.state, (pass) =>
          Transitions.noteRecovery(Transitions.resolveRecovery(pass, issue.id), { skipped: 1 }),
        )
        continue
      }
      const pass = yield* Ref.get(cells.state)
      if (
        !issueIsRoutable(issue, { requiredLabels }) ||
        pass.handoffs.has(issue.id) ||
        pass.pendingRestoredHandoffs.some((handoff) => handoff.issueId === issue.id) ||
        pass.recoveryResolved.has(issue.id)
      ) {
        continue
      }
      attemptFailed =
        (yield* recoverIssueHandoff(cells, effective, codeReview.value, issue, requiredLabels)) ||
        attemptFailed
    }
    if (attemptFailed) {
      return
    }
    yield* finishRecovery(cells)
  })

/** Records a failed issue fetch against the recovery counts, and says where the pass had reached. */
const noteRecoveryFetchFailure = (cells: RuntimeCells, error: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const counts = yield* Ref.modify(cells.state, (failing) => {
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
      error,
    })
  })

/**
 * Recovers the handoff for one issue, and says whether the attempt failed. A lookup that failed is
 * what keeps the whole pass unfinished; an issue with no branch is resolved and skipped.
 */
const recoverIssueHandoff = (
  cells: RuntimeCells,
  effective: EffectiveWorkflow,
  capability: CodeReviewPort,
  issue: Issue,
  requiredLabels: readonly string[],
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const found = yield* capability.findExistingHandoff(issue).pipe(asSettled)
    if (found._tag === 'Failed') {
      yield* Ref.update(cells.state, (failing) => Transitions.noteRecovery(failing, { failed: 1 }))
      yield* logWarning('startup handoff recovery lookup failed; retrying later', {
        ...logContext(issue),
        action: 'handoff_recovery',
        outcome: 'failed',
        error: found.error.message,
      })
      return true
    }
    const foundResult = found.value
    if (foundResult._tag === 'NoBranch') {
      yield* Ref.update(cells.state, (skipping) =>
        Transitions.noteRecovery(Transitions.resolveRecovery(skipping, issue.id), { skipped: 1 }),
      )
      return false
    }
    const observedAt = yield* currentInstant
    const inspected = yield* capability
      .inspectPullRequest(foundResult.pullRequestNumber)
      .pipe(asSettled)
    const disposition =
      inspected._tag === 'Succeeded'
        ? classifyPullRequest(inspected.value)
        : { state: 'awaiting_checks' as const, reason: inspected.error.message }
    const opened = yield* openDetailRecord(cells, issue, null, requiredLabels)
    const branchObserved = recordHandoff(opened, observedAt, {
      step: 'remote_branch',
      status: 'observed',
      message: `Remote branch ${foundResult.branchName} is present`,
      remoteBranch: foundResult.branchName,
    })
    yield* Ref.update(cells.state, (recovering) => {
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
        headSha: inspected._tag === 'Succeeded' ? inspected.value.headSha : null,
        reason: 'reason' in disposition ? disposition.reason : null,
        repairHeadShas: [],
        repairObservedHeadShas: [],
        repair: Option.none(),
        reviewRequestedHeadSha: null,
        reviewCompletedHeadSha: null,
        observedAt,
      })
      return Transitions.noteRecovery(Transitions.resolveRecovery(withHandoff, issue.id), {
        recovered: 1,
      })
    })
    yield* logInfo('open pull request handoff recovered', {
      ...logContext(issue),
      action: 'handoff_recovery',
      outcome: 'recovered',
      branch: foundResult.branchName,
      pull_request_url: foundResult.pullRequestUrl,
    })
    return false
  })

/** Closes startup recovery, and writes the adopted handoffs to the store for the first time. */
const finishRecovery = (cells: RuntimeCells): Effect.Effect<void> =>
  Effect.gen(function* () {
    const finished = yield* Ref.modify(cells.state, (pass) => {
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
    yield* persistHandoffs(cells)
  })
