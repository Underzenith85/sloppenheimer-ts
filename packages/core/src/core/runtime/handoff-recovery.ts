import { Effect, Option, Ref } from 'effect'

import { issueId, type Issue } from '../../domain/domain.js'
import { classifyPullRequest, type HandoffSnapshot } from '../../domain/handoff.js'
import { currentInstant } from '../../support/clock.js'
import { logError, logInfo, logWarning } from '../../support/logging.js'
import { asSettled } from '../../support/settled.js'
import { recordHandoff } from '../../telemetry.js'
import type { CodeReviewPort } from '../../ports/index.js'
import { captureExecutionSnapshot, issueIsRoutable, logContext } from '../policy.js'
import type { EffectiveWorkflow, ExecutionSnapshot, HandoffEntry } from '../state.js'
import * as Transitions from '../transitions.js'
import { findOrResumePublishedHandoff, owesPublishedHandoff } from './published-handoff.js'
import { persistHandoffs } from './store.js'
import { openDetailRecord } from './runs.js'
import type { RuntimeCells } from './types.js'

/**
 * Turns the handoffs read from the store into live entries, once the tracker has answered for the
 * issues behind them. A fetch that fails leaves them pending, so the next pass tries again.
 */
export const hydrateRestoredHandoffs = (cells: RuntimeCells): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pending = yield* Ref.get(cells.state)
    if (pending.pendingRestoredHandoffs.length === 0) {
      return
    }
    const fetched = yield* pending.lastKnownGood.tracker
      .fetchIssuesByIds(pending.pendingRestoredHandoffs.map((handoff) => issueId(handoff.issueId)))
      .pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Ref.update(cells.state, (failing) =>
              Transitions.noteRecovery(failing, { failed: 1 }),
            ).pipe(
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
    yield* Ref.update(cells.state, (current) => {
      const hydrated = new Set<string>()
      let next = current
      for (const restored of current.pendingRestoredHandoffs) {
        const issue = fetched.find((candidate) => candidate.id === restored.issueId)
        const entry =
          issue === undefined
            ? null
            : restoredHandoffEntry(
                issue,
                restored,
                captureExecutionSnapshot(next.lastKnownGood, ''),
              )
        if (entry === null) {
          continue
        }
        next = Transitions.putHandoff(next, entry.issue.id, entry)
        hydrated.add(restored.issueId)
      }
      return Transitions.dropRestoredHandoffs(next, hydrated)
    })
  })

/**
 * Reads one persisted snapshot back as a live handoff, or answers `null` when its pull-request URL
 * carries no number to inspect against. Migration of the older shapes lives here: a snapshot
 * written before a field existed is read as the most its author can honestly have meant.
 */
const restoredHandoffEntry = (
  issue: Issue,
  restored: HandoffSnapshot,
  execution: ExecutionSnapshot,
): HandoffEntry | null => {
  const numberMatch = /\/pulls?\/(\d+)(?:\/)?$/u.exec(restored.pullRequestUrl)
  const pullRequestNumber = Number(numberMatch?.[1])
  if (!Number.isSafeInteger(pullRequestNumber)) {
    return null
  }
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
    // Never restored: a rebase is the host's own in-flight action, and the process that was
    // performing it is gone. The next observation finds the branch still behind or already moved.
    rebase: Option.none(),
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
    const durableRecords = cells.durable === undefined ? [] : yield* cells.durable.snapshot
    if (
      opening.startupRecoveryFinished &&
      !durableRecords.some(
        (record) => owesPublishedHandoff(record) && !opening.handoffs.has(issueId(record.issueId)),
      )
    ) {
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
        yield* Ref.update(cells.state, (pass) => Transitions.noteRecovery(pass, { skipped: 1 }))
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
    const found = yield* findOrResumePublishedHandoff(cells, effective, capability, issue).pipe(
      asSettled,
    )
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
          message: foundResult.created
            ? 'Completed a durable publication handoff'
            : 'Recovered an existing pull request during startup',
          pullRequest: {
            status: foundResult.created ? 'created' : 'reused',
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
        rebase: Option.none(),
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
