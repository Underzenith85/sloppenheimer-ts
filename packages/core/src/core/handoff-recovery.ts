import { FileSystem } from '@effect/platform'
import { Effect, Option, Ref } from 'effect'

import { issueId, type Issue } from '../domain/domain.js'
import { classifyPullRequest, type HandoffSnapshot } from '../domain/handoff.js'
import { currentInstant } from '../support/clock.js'
import { logError, logInfo, logWarning } from '../support/logging.js'
import { asSettled } from '../support/settled.js'
import { recordHandoff } from '../telemetry.js'
import type { CodeReviewPort, HandoffResult } from '../ports/index.js'
import { loadHandoffs, saveHandoffs } from './handoff-store.js'
import { captureExecutionSnapshot, issueIsRoutable, logContext } from './policy.js'
import type { HandoffStoreBinding, OrchestratorContext } from './runtime.js'
import type { EffectiveWorkflow, HandoffEntry, HandoffStoreError, RuntimeState } from './state.js'
import * as Transitions from './transitions.js'

/**
 * The persisted handoff store, and the two recoveries a restart owes it: hydrating the snapshots
 * the store held, and finding the open pull requests that were opened while the host was down.
 *
 * Every write goes through {@link persistHandoffs}, which is also where the store's failure states
 * are decided — a store that could not be read is never written back over.
 */

/** What a restart read out of the store, and whether reading it succeeded. */
export type RestoredHandoffs = Readonly<{
  handoffs: readonly HandoffSnapshot[]
  storeReadFailed: boolean
  storeError: HandoffStoreError | null
}>

const onHostFileSystem = <Value, Error>(
  store: HandoffStoreBinding,
  effect: Effect.Effect<Value, Error, FileSystem.FileSystem>,
): Effect.Effect<Value, Error> =>
  Effect.provideService(effect, FileSystem.FileSystem, store.fileSystem)

/**
 * Reads the store a restart inherits. Handoff disabled leaves it deliberately unread, so the empty
 * in-memory list is never written back over it: a later handoff-enabled run still has to restore
 * those pull requests.
 */
export const restoreHandoffStore = (store: HandoffStoreBinding): Effect.Effect<RestoredHandoffs> =>
  store.disabled
    ? Effect.succeed({
        handoffs: [] as readonly HandoffSnapshot[],
        storeReadFailed: false,
        storeError: null,
      })
    : onHostFileSystem(store, loadHandoffs(store.path)).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            logError('handoff store read failed; preserving store during recovery', {
              action: 'handoff_store_read',
              outcome: 'failed',
              path: store.path,
              error: error.message,
            }).pipe(
              Effect.zipRight(currentInstant),
              Effect.map((observedAt) => ({
                handoffs: [] as readonly HandoffSnapshot[],
                storeReadFailed: true,
                storeError: {
                  operation: error.operation,
                  message: error.message,
                  observedAt,
                },
              })),
            ),
          onSuccess: (handoffs) =>
            Effect.succeed({ handoffs, storeReadFailed: false, storeError: null }),
        }),
      )

/** Writes the current handoffs back to the store, unless the restart is not entitled to. */
export const persistHandoffs = (context: OrchestratorContext): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(context.state)
    if (
      context.handoffStore.disabled ||
      !current.startupRecoveryFinished ||
      current.storeReadFailed
    ) {
      return
    }
    yield* onHostFileSystem(
      context.handoffStore,
      saveHandoffs(context.handoffStore.path, Transitions.handoffSnapshots(current)),
    ).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const observedAt = yield* currentInstant
          yield* Ref.update(context.state, (failing) =>
            Transitions.setHandoffStoreError(Transitions.noteRecovery(failing, { failed: 1 }), {
              operation: error.operation,
              message: error.message,
              observedAt,
            }),
          )
          yield* logError('handoff store write failed', {
            action: 'handoff_store_write',
            outcome: 'failed',
            path: context.handoffStore.path,
            error: error.message,
          })
        }),
      ),
    )
  })

/**
 * Rebuilds one handoff from the snapshot the store held, against the issue the tracker now reports.
 * It is a function of its inputs: the caller reads the state, and the migrations a legacy snapshot
 * needs are decided here rather than at the write that produced it.
 */
const restoredHandoffEntry = (
  state: RuntimeState,
  restored: HandoffSnapshot,
  issue: Issue,
  pullRequestNumber: number,
): HandoffEntry => ({
  issue,
  execution: captureExecutionSnapshot(state.lastKnownGood, ''),
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
      ...(restored.repairStartedHeadSha === undefined || restored.repairStartedHeadSha === null
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

/**
 * Attaches the restored snapshots to the issues they name, once the tracker can report them. A
 * fetch that fails leaves them pending, so the next pass tries again.
 */
export const hydrateRestoredHandoffs = (context: OrchestratorContext): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pending = yield* Ref.get(context.state)
    if (pending.pendingRestoredHandoffs.length === 0) {
      return
    }
    const fetched = yield* pending.lastKnownGood.tracker
      .fetchIssuesByIds(pending.pendingRestoredHandoffs.map((handoff) => issueId(handoff.issueId)))
      .pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Ref.update(context.state, (failing) =>
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
    yield* Ref.update(context.state, (current) => {
      const hydrated = new Set<string>()
      let next = current
      for (const restored of current.pendingRestoredHandoffs) {
        const issue = fetched.find((candidate) => candidate.id === restored.issueId)
        const numberMatch = /\/pulls?\/(\d+)(?:\/)?$/u.exec(restored.pullRequestUrl)
        const pullRequestNumber = Number(numberMatch?.[1])
        if (issue === undefined || !Number.isSafeInteger(pullRequestNumber)) {
          continue
        }
        next = Transitions.putHandoff(
          next,
          issue.id,
          restoredHandoffEntry(next, restored, issue, pullRequestNumber),
        )
        hydrated.add(restored.issueId)
      }
      return Transitions.dropRestoredHandoffs(next, hydrated)
    })
  })

/**
 * Adopts a pull request the tracker still reports but the store does not hold: the detail record
 * is opened as though this run had made the handoff, and the disposition the host observes now
 * stands in for whatever the lost run last saw.
 */
const adoptRecoveredHandoff = (
  context: OrchestratorContext,
  issue: Issue,
  effective: EffectiveWorkflow,
  capability: CodeReviewPort,
  found: Extract<HandoffResult, { _tag: 'PullRequest' }>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const observedAt = yield* currentInstant
    const inspected = yield* capability.inspectPullRequest(found.pullRequestNumber).pipe(asSettled)
    const disposition =
      inspected._tag === 'Succeeded'
        ? classifyPullRequest(inspected.value)
        : { state: 'awaiting_checks' as const, reason: inspected.error.message }
    const opened = yield* context.detailRecord(
      issue,
      null,
      effective.workflow.config.tracker.requiredLabels,
    )
    const branchObserved = recordHandoff(opened, observedAt, {
      step: 'remote_branch',
      status: 'observed',
      message: `Remote branch ${found.branchName} is present`,
      remoteBranch: found.branchName,
    })
    yield* Ref.update(context.state, (recovering) => {
      const withDetail = Transitions.putDetail(
        recovering,
        issue.id,
        recordHandoff(branchObserved, observedAt, {
          step: 'pull_request',
          status: 'observed',
          message: 'Recovered an existing pull request during startup',
          pullRequest: {
            status: 'reused',
            number: found.pullRequestNumber,
            url: found.pullRequestUrl,
            state: disposition.state,
          },
        }),
      )
      const withHandoff = Transitions.putHandoff(withDetail, issue.id, {
        issue,
        execution: captureExecutionSnapshot(effective, ''),
        pullRequestNumber: found.pullRequestNumber,
        pullRequestUrl: found.pullRequestUrl,
        branchName: found.branchName,
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
      branch: found.branchName,
      pull_request_url: found.pullRequestUrl,
    })
  })

/**
 * Recovers one issue's open pull request, if it has one nobody is tracking. Answers whether the
 * lookup failed, which holds startup recovery open for the next pass rather than declaring it
 * finished with an issue unaccounted for.
 */
const recoverIssueHandoff = (
  context: OrchestratorContext,
  issue: Issue,
  effective: EffectiveWorkflow,
  capability: CodeReviewPort,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const requiredLabels = effective.workflow.config.tracker.requiredLabels
    if (!issue.dispatchable) {
      yield* Ref.update(context.state, (pass) =>
        Transitions.noteRecovery(Transitions.resolveRecovery(pass, issue.id), { skipped: 1 }),
      )
      return false
    }
    const pass = yield* Ref.get(context.state)
    if (
      !issueIsRoutable(issue, { requiredLabels }) ||
      pass.handoffs.has(issue.id) ||
      pass.pendingRestoredHandoffs.some((handoff) => handoff.issueId === issue.id) ||
      pass.recoveryResolved.has(issue.id)
    ) {
      return false
    }
    const found = yield* capability.findExistingHandoff(issue).pipe(asSettled)
    if (found._tag === 'Failed') {
      yield* Ref.update(context.state, (failing) =>
        Transitions.noteRecovery(failing, { failed: 1 }),
      )
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
      yield* Ref.update(context.state, (skipping) =>
        Transitions.noteRecovery(Transitions.resolveRecovery(skipping, issue.id), {
          skipped: 1,
        }),
      )
      return false
    }
    yield* adoptRecoveredHandoff(context, issue, effective, capability, foundResult)
    return false
  })

/**
 * Finds the pull requests that were opened before the host stopped and are not in the store, once,
 * at startup. It runs on every pass until it completes, because an issue it could not look up
 * leaves recovery unfinished rather than silently unaccounted for.
 */
export const recoverMissingHandoffs = (context: OrchestratorContext): Effect.Effect<void> =>
  Effect.gen(function* () {
    const opening = yield* Ref.get(context.state)
    if (opening.startupRecoveryFinished) {
      return
    }
    const effective = opening.lastKnownGood
    const codeReview = effective.codeReview
    if (Option.isNone(codeReview)) {
      yield* Ref.update(context.state, Transitions.finishStartupRecovery)
      return
    }
    const capability = codeReview.value
    const fetched = yield* effective.tracker
      .fetchIssuesByStates(effective.workflow.config.tracker.activeStates, null, {
        hydrateDependencies: false,
      })
      .pipe(asSettled)
    if (fetched._tag === 'Failed') {
      const counts = yield* Ref.modify(context.state, (failing) => {
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
    for (const issue of fetched.value) {
      const failed = yield* recoverIssueHandoff(context, issue, effective, capability)
      attemptFailed = attemptFailed || failed
    }
    if (attemptFailed) {
      return
    }
    const finished = yield* Ref.modify(context.state, (pass) => {
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
    yield* context.persistHandoffs
  })
