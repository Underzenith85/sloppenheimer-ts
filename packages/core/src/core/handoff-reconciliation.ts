import { Effect, Option, Ref, type Scope } from 'effect'

import type { Issue, IssueId } from '../domain/domain.js'
import { currentInstant } from '../support/clock.js'
import { logInfo } from '../support/logging.js'
import { asSettled } from '../support/settled.js'
import { dispatch } from './dispatch.js'
import {
  afterInspectionFailed,
  afterMerge,
  afterRepairDispatched,
  afterReviewRequested,
  afterThreadsResolved,
  awaitingSlot,
  observeHandoff,
  repairIssue,
  type HandoffAction,
} from './handoff-decision.js'
import {
  hasSlot,
  identifierIssueNumber,
  issueIsActive,
  issueIsRoutable,
  logContext,
  stateIsIn,
} from './policy.js'
import type { CodeReviewPort } from '../ports/index.js'
import type { CompletedEntry } from './state.js'
import type { OrchestratorContext } from './runtime.js'
import type { EffectiveWorkflow, HandoffEntry, RuntimeState } from './state.js'
import * as Transitions from './transitions.js'

/** Whether this handoff is the orchestrator's to act on at all in this pass. */
const skipped = (state: RuntimeState, id: IssueId, handoff: HandoffEntry): boolean => {
  if (state.running.has(id) || state.retries.has(id)) {
    return true
  }
  if (handoff.state === 'closed_without_merge') {
    return true
  }
  return Option.exists(identifierIssueNumber(handoff.issue.identifier), (issueNumber) =>
    state.pausedIssueNumbers.has(issueNumber),
  )
}

/**
 * What a merged handoff leaves behind. The runtime already recorded that the issue completed; this
 * keeps the title, link and instant alongside it so the console can answer what Sloppenheimer finished
 * and when, instead of publishing a bare count.
 *
 * A reported merge time wins over the observation's own: dating a restored handoff now would put
 * finished work back into the console's recent-activity window.
 */
const finishedWork = (
  id: IssueId,
  handoff: HandoffEntry,
  mergedAt: string | null,
  observedAt: Date,
): CompletedEntry => {
  const reported = mergedAt === null ? null : new Date(mergedAt)
  return {
    issueId: id,
    identifier: handoff.issue.identifier,
    title: handoff.issue.title,
    url: handoff.issue.url,
    outcome: 'merged',
    finishedAt: reported === null || Number.isNaN(reported.getTime()) ? observedAt : reported,
    pullRequestUrl: handoff.pullRequestUrl,
  }
}

/**
 * Files the issue as finished and records it on disk in the same step. Persisted here rather than
 * with the pass's handoffs: a completion is a single event, and the store it lands in is the one
 * thing that will still know about it after a restart.
 */
const completeWork = (
  context: OrchestratorContext,
  id: IssueId,
  finished: CompletedEntry,
): Effect.Effect<void> =>
  Ref.update(context.state, (current) => Transitions.completeHandoff(current, id, finished)).pipe(
    Effect.zipRight(context.persistCompletions),
  )

/**
 * Records one handoff in the state cell without persisting it.
 *
 * A reconciliation pass rewrites many handoffs, and `reconcileHandoffs` flushes all of them with a
 * single `persistHandoffs` at the end rather than writing the store once per change. Staging is
 * therefore what every write in this module wants — deliberately not `writeHandoff` in
 * `polling.ts`, which persists as it writes because the changes it makes stand alone.
 */
const stageHandoff = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry,
): Effect.Effect<void> =>
  Ref.update(context.state, (current) => Transitions.putHandoff(current, id, handoff))

type IssueRefresh =
  | Readonly<{ _tag: 'Failed'; reason: string }>
  | Readonly<{ _tag: 'Succeeded'; issue: Option.Option<Issue> }>

export type RepairPermission =
  | Readonly<{ _tag: 'Allowed'; issue: Issue }>
  | Readonly<{ _tag: 'Denied'; reason: string }>

/**
 * A handoff keeps the workflow that created its pull request. A freshly fetched issue is evaluated
 * against that same workflow before new agent work starts, while review and merge observation stay
 * independent of issue eligibility. Removing a label therefore stops repairs without stranding a
 * pull request that is already green.
 */
export const repairPermission = (
  handoff: HandoffEntry,
  refresh: IssueRefresh,
): RepairPermission => {
  if (refresh._tag === 'Failed') {
    return { _tag: 'Denied', reason: `Cannot confirm repair eligibility. ${refresh.reason}` }
  }
  if (Option.isNone(refresh.issue)) {
    return {
      _tag: 'Denied',
      reason: 'Repair paused because the tracker no longer reports the issue.',
    }
  }
  const issue = refresh.issue.value
  const workflow = handoff.execution.workflow
  if (stateIsIn(issue.state, workflow.config.tracker.terminalStates)) {
    return { _tag: 'Denied', reason: 'Repair paused because the issue is terminal.' }
  }
  if (
    !issueIsActive(issue, workflow.config.tracker) ||
    !issueIsRoutable(issue, workflow.config.tracker)
  ) {
    return {
      _tag: 'Denied',
      reason: 'Repair paused because the issue is not eligible under its handoff workflow.',
    }
  }
  return { _tag: 'Allowed', issue }
}

/**
 * Refresh each eligible handoff independently.
 *
 * The tracker boundary is fail-fast even when it accepts several IDs, so batching unrelated
 * handoffs would let one malformed or missing tracker record deny repairs for every pull request
 * in that batch. Eligibility refreshes are deliberately isolated here: a provider failure can
 * affect only the handoff whose policy decision depends on it.
 */
const refreshHandoffIssues = (
  handoffs: ReadonlyMap<IssueId, HandoffEntry>,
): Effect.Effect<ReadonlyMap<IssueId, IssueRefresh>, never> =>
  Effect.gen(function* () {
    const fetched: readonly (readonly [IssueId, IssueRefresh])[] = yield* Effect.forEach(
      handoffs,
      ([id, handoff]) =>
        handoff.execution.tracker.fetchIssuesByIds([id]).pipe(
          Effect.match({
            onFailure: (error) =>
              [id, { _tag: 'Failed', reason: error.message } satisfies IssueRefresh] as const,
            onSuccess: (issues) =>
              [
                id,
                {
                  _tag: 'Succeeded',
                  issue: Option.fromNullable(issues.find((issue) => issue.id === id)),
                } satisfies IssueRefresh,
              ] as const,
          }),
        ),
    )
    return new Map(fetched)
  })

/**
 * The protected merge, and everything that follows it here: the handoff is completed and the issue
 * filed as finished, so nothing dispatches it again. A refused merge only records why.
 */
const performMerge = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry,
  capability: CodeReviewPort,
  headSha: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* stageHandoff(context, id, handoff)
    const merged = yield* capability
      .mergePullRequest(handoff.pullRequestNumber, headSha)
      .pipe(asSettled)
    const settled = afterMerge(handoff, merged._tag === 'Failed' ? merged.error.message : null)
    yield* stageHandoff(context, id, settled)
    if (merged._tag === 'Failed') {
      return
    }
    yield* context.noteHandoffOutcome(id, settled, 'merged')
    // This host performed the merge just now, so the instant is its own.
    yield* completeWork(context, id, finishedWork(id, settled, null, yield* currentInstant))
    yield* logInfo('pull request merged', {
      ...logContext(handoff.issue),
      action: 'pull_request_merge',
      outcome: 'completed',
      error: null,
      pull_request_url: handoff.pullRequestUrl,
      merge_commit_sha: merged.value,
    })
  })

/**
 * Putting a worker on the pull request the review asked to be repaired. Every refusal — a pass that
 * may not dispatch, a denied permission, a missing baseline, no slot — is recorded on the handoff
 * as the reason, so the console says why the repair has not started rather than staying silent.
 */
const performRepair = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry,
  action: Extract<HandoffAction, { _tag: 'Repair' }>,
  permission: RepairPermission,
  executionAttempt: Option.Option<number>,
  repairDispatchAllowed: boolean,
  codeReview: Option.Option<CodeReviewPort>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    if (!repairDispatchAllowed) {
      yield* stageHandoff(context, id, handoff)
      return
    }
    if (permission._tag === 'Denied') {
      yield* stageHandoff(context, id, {
        ...handoff,
        reason: permission.reason,
      })
      return
    }
    const baselineHeadSha = action.headSha
    if (baselineHeadSha === null) {
      yield* stageHandoff(context, id, {
        ...handoff,
        reason: `Cannot dispatch a repair without a pull request head. ${action.reason}`,
      })
      return
    }
    const issue = repairIssue(handoff, permission.issue, baselineHeadSha, action.reason)
    const current = yield* Ref.get(context.state)
    if (!hasSlot(current, issue, handoff.execution.workflow)) {
      if (Option.isNone(executionAttempt)) {
        yield* stageHandoff(context, id, awaitingSlot(handoff, action.reason))
        return
      }
      yield* stageHandoff(
        context,
        id,
        afterRepairDispatched(handoff, false, issue, baselineHeadSha, action.reason),
      )
      yield* context.scheduleRetry(
        issue,
        executionAttempt.value,
        'no available orchestrator slots',
        false,
        true,
      )
      return
    }
    yield* stageHandoff(context, id, handoff)
    const effective: EffectiveWorkflow = {
      workflow: handoff.execution.workflow,
      tracker: handoff.execution.tracker,
      codeReview,
      sourceControl: handoff.execution.sourceControl,
      workspaces: handoff.execution.workspaces,
      loadedAt: handoff.observedAt,
    }
    const attempt = Option.getOrElse(executionAttempt, () => action.attempt)
    const started = yield* dispatch(context, issue, attempt, effective, {
      _tag: 'Repair',
      branchName: handoff.branchName,
      expectedHeadSha: baselineHeadSha,
    })
    yield* stageHandoff(
      context,
      id,
      afterRepairDispatched(handoff, started, issue, baselineHeadSha, action.reason),
    )
  })

/**
 * Carries out the one call an observation asked for and folds its result back into the handoff.
 * Every branch ends with the handoff written, so the state after a pass reflects what actually
 * happened rather than what was proposed.
 */
const perform = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry,
  action: HandoffAction,
  permission: RepairPermission,
  executionAttempt: Option.Option<number>,
  repairDispatchAllowed: boolean,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const codeReview = handoff.execution.codeReview
    if (Option.isNone(codeReview)) {
      yield* stageHandoff(context, id, handoff)
      return
    }
    const capability = codeReview.value
    switch (action._tag) {
      case 'None': {
        yield* stageHandoff(context, id, handoff)
        return
      }
      case 'RequestReview': {
        const requested = yield* capability
          .requestPullRequestReview(handoff.pullRequestNumber, action.headSha)
          .pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => null }))
        yield* stageHandoff(context, id, afterReviewRequested(handoff, action.headSha, requested))
        if (requested === null) {
          yield* logInfo('Codex review requested for pull request head', {
            ...logContext(handoff.issue),
            action: 'pull_request_review_request',
            outcome: 'completed',
            error: null,
            pull_request_url: handoff.pullRequestUrl,
            head_sha: action.headSha,
          })
        }
        return
      }
      case 'ResolveThreads': {
        const resolved = yield* capability
          .resolveReviewThreads(handoff.pullRequestNumber, action.headSha, action.threadIds)
          .pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => null }))
        yield* stageHandoff(context, id, afterThreadsResolved(handoff, resolved))
        return
      }
      case 'Complete': {
        yield* stageHandoff(context, id, handoff)
        yield* context.noteHandoffOutcome(id, handoff, 'merged')
        yield* completeWork(
          context,
          id,
          finishedWork(id, handoff, action.mergedAt, yield* currentInstant),
        )
        return
      }
      case 'NoteClosed': {
        yield* stageHandoff(context, id, handoff)
        yield* context.noteHandoffOutcome(id, handoff, 'intervention_required')
        return
      }
      case 'Merge': {
        yield* performMerge(context, id, handoff, capability, action.headSha)
        return
      }
      case 'Repair': {
        yield* performRepair(
          context,
          id,
          handoff,
          action,
          permission,
          executionAttempt,
          repairDispatchAllowed,
          codeReview,
        )
        return
      }
    }
  })

/** Run the one handoff state machine and its one action interpreter for an observed pull request. */
export const applyHandoffObservation = (
  context: OrchestratorContext,
  id: IssueId,
  handoff: HandoffEntry,
  observation: Parameters<typeof observeHandoff>[1],
  observedAt: Date,
  permission: RepairPermission,
  executionAttempt: Option.Option<number>,
  repairDispatchAllowed: boolean,
): Effect.Effect<void, never, Scope.Scope> => {
  const decision = observeHandoff(handoff, observation, observedAt)
  return perform(
    context,
    id,
    decision.handoff,
    decision.action,
    permission,
    executionAttempt,
    repairDispatchAllowed,
  )
}

export const reconcileHandoffs = (
  context: OrchestratorContext,
  repairDispatchAllowed: boolean,
  onlyIssueId: Option.Option<IssueId> = Option.none(),
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const selected = (id: IssueId): boolean =>
      Option.isNone(onlyIssueId) || onlyIssueId.value === id
    const opening = yield* Ref.get(context.state)
    const eligible = new Map(
      [...opening.handoffs].filter(
        ([id, handoff]) =>
          selected(id) &&
          !skipped(opening, id, handoff) &&
          Option.isSome(handoff.execution.codeReview),
      ),
    )
    const refreshedIssues = yield* refreshHandoffIssues(eligible)
    for (const id of opening.handoffs.keys()) {
      if (!selected(id)) {
        continue
      }
      // Re-read: an earlier handoff in this pass may have taken the last agent slot, or dispatched
      // a repair for this very issue.
      const current = yield* Ref.get(context.state)
      const live = current.handoffs.get(id)
      if (live === undefined || skipped(current, id, live)) {
        continue
      }
      const codeReview = live.execution.codeReview
      if (Option.isNone(codeReview)) {
        continue
      }
      const observedAt = yield* currentInstant
      const inspected = yield* codeReview.value
        .inspectPullRequest(live.pullRequestNumber)
        .pipe(asSettled)
      if (inspected._tag === 'Failed') {
        yield* stageHandoff(
          context,
          id,
          afterInspectionFailed(live, observedAt, inspected.error.message),
        )
        continue
      }
      const refresh = Option.fromNullable(refreshedIssues.get(id)).pipe(
        Option.getOrElse<IssueRefresh>(() => ({
          _tag: 'Failed',
          reason: 'The handoff issue was not included in the eligibility refresh.',
        })),
      )
      yield* applyHandoffObservation(
        context,
        id,
        live,
        inspected.value,
        observedAt,
        repairPermission(live, refresh),
        Option.none(),
        repairDispatchAllowed,
      )
    }
    // One timeline entry per observed transition, not one per poll: an unchanged disposition is
    // not news, and the timeline is a bounded resource.
    const closing = yield* Ref.get(context.state)
    for (const [id, handoff] of closing.handoffs) {
      if (!selected(id)) {
        continue
      }
      if (closing.details.get(id)?.handoff.pullRequest.state !== handoff.state) {
        yield* context.noteHandoffOutcome(
          id,
          handoff,
          handoff.state === 'intervention_required' ? 'intervention_required' : 'pull_request_open',
        )
      }
    }
    // Handoffs are observations, not claim owners. A live worker or queued retry retains its claim;
    // every idle handoff releases one that was restored from an older snapshot or left behind by a
    // completed transition.
    yield* Ref.update(context.state, (current) => {
      let released = current
      for (const id of current.handoffs.keys()) {
        if (selected(id) && !current.running.has(id) && !current.retries.has(id)) {
          released = Transitions.releaseClaim(released, id)
        }
      }
      return released
    })
    yield* context.persistHandoffs
  })
