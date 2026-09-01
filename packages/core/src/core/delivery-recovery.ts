/**
 * Rediscovering work a previous process left in a workspace and never published.
 *
 * A retained delivery lives in two places: the scheduler's own queue, which a restart empties, and
 * the workspace on disk, which it does not. The workspace is the authoritative one — it is where
 * the diff actually is — so recovery asks it rather than trying to persist a queue that could only
 * ever describe it.
 *
 * The host's preparation already answers the hard half: it preserves a worktree that is on the
 * expected branch and carries uncommitted edits or a commit past the baseline, and resets one that
 * does not. So a prepared workspace that inspects as changed is, by construction, work a previous
 * run produced and did not deliver.
 *
 * Nothing here counts as a repair attempt. No agent is dispatched, no repair identity is created,
 * and the budget an operator's intervention threshold is measured against is untouched: what is
 * recovered is a publication, and it is settled by the same state machine a turn's own postflight
 * goes through.
 */

import { Effect, Option, Ref, type Scope } from 'effect'

import type { Issue, IssueId } from '../domain/domain.js'
import { issueBranchName } from '../domain/handoff.js'
import { logInfo, logWarning } from '../support/logging.js'
import { asSettled } from '../support/settled.js'
import { settlePostflight } from './delivery.js'
import { captureExecutionSnapshot, identifierIssueNumber, logContext } from './policy.js'
import { runPostflight } from './postflight.js'
import type { OrchestratorContext } from './runtime.js'
import type { EffectiveWorkflow, HandoffEntry, RuntimeState } from './state.js'
import type { PreparedRepository, SourceControlPort, SourceControlTarget } from '../ports/index.js'
import * as Transitions from './transitions.js'

/**
 * Where a retained worktree belongs.
 *
 * A handoff with a head is a pull request this work was being repaired against, and publishing to
 * it has to respect the same expected-head lease the repair itself did. A handoff without one is
 * still that pull request's branch; only an issue with no handoff at all falls back to the branch
 * the naming convention gives it.
 */
const targetFor = (issue: Issue, handoff: HandoffEntry | undefined): SourceControlTarget => {
  if (handoff === undefined) {
    return { _tag: 'Normal', branchName: issue.branchName ?? issueBranchName(issue) }
  }
  return handoff.headSha === null
    ? { _tag: 'Normal', branchName: handoff.branchName }
    : { _tag: 'Repair', branchName: handoff.branchName, expectedHeadSha: handoff.headSha }
}

/**
 * Whether something is already acting on this issue, and so this scan has nothing left to examine.
 *
 * Deliberately not the claim: an issue with an open handoff is claimed for as long as its pull
 * request lives, and that pull request is exactly what unpublished work is owed. A running worker,
 * a queued retry and a retained delivery each end in a postflight of their own, which is what makes
 * them an answer rather than a gap.
 */
const alreadyHandled = (state: RuntimeState, issue: Issue): boolean =>
  state.running.has(issue.id) || state.retries.has(issue.id) || state.deliveries.has(issue.id)

/**
 * Whether an operator has stopped this issue. A paused workspace is left unexamined rather than
 * counted as handled: publishing from it would ignore the pause, and calling it examined would let
 * the resume put an agent into a workspace nobody has looked at.
 */
const operatorPaused = (state: RuntimeState, issue: Issue): boolean =>
  Option.exists(identifierIssueNumber(issue.identifier), (issueNumber) =>
    state.pausedIssueNumbers.has(issueNumber),
  )

/**
 * Publishes what the inspection found, and hands the outcome to the same settlement a turn's own
 * postflight goes through.
 */
const publishRetained = (
  context: OrchestratorContext,
  issue: Issue,
  effective: EffectiveWorkflow,
  sourceControl: SourceControlPort,
  handoff: HandoffEntry | undefined,
  prepared: PreparedRepository,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const outcome = yield* runPostflight(sourceControl, issue, prepared)
    yield* settlePostflight(
      context,
      {
        issue,
        // The workflow in force, with no prompt: nothing here launches an agent, and the ports the
        // settlement needs are the ones this process is running under.
        execution: handoff?.execution ?? captureExecutionSnapshot(effective, ''),
        // No worker attempt owns this work: the process that produced it is gone. A retry that
        // follows starts the agent's numbering afresh, which is the truthful reading.
        attempt: null,
        repairRun: handoff !== undefined,
      },
      outcome,
      1,
    )
  })

/**
 * One issue's workspace, examined and published if it holds anything.
 *
 * Answers whether the workspace was examined conclusively. `false` is a host that could not look —
 * an unreadable workspace, a preparation or inspection that failed — and it keeps the whole scan
 * unfinished, because the alternative is deciding there is no retained work on the strength of not
 * having looked.
 */
const recoverIssue = (
  context: OrchestratorContext,
  issue: Issue,
): Effect.Effect<boolean, never, Scope.Scope> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(context.state)
    const effective = current.lastKnownGood
    const sourceControl = effective.sourceControl
    if (sourceControl === null || alreadyHandled(current, issue)) {
      // Something is already acting on this issue, or nothing here can publish: either way this
      // pass has nothing to examine, and neither is a failure to look.
      return true
    }
    if (operatorPaused(current, issue)) {
      return false
    }
    const exists = yield* effective.workspaces.exists(issue.identifier).pipe(asSettled)
    if (exists._tag === 'Failed') {
      yield* logWarning('delivery recovery could not inspect the workspace; retrying later', {
        ...logContext(issue),
        action: 'delivery_recovery',
        outcome: 'failed',
        error: exists.error.message,
      })
      return false
    }
    if (!exists.value) {
      return true
    }
    const workspace = yield* effective.workspaces.create(issue.identifier).pipe(asSettled)
    if (workspace._tag === 'Failed') {
      yield* logWarning('delivery recovery could not open the workspace; retrying later', {
        ...logContext(issue),
        action: 'delivery_recovery',
        outcome: 'failed',
        error: workspace.error.message,
      })
      return false
    }
    const handoff = current.handoffs.get(issue.id)
    const prepared = yield* sourceControl
      .prepare(issue, workspace.value, targetFor(issue, handoff))
      .pipe(asSettled)
    if (prepared._tag === 'Failed') {
      yield* logWarning('delivery recovery could not prepare the repository; retrying later', {
        ...logContext(issue),
        action: 'delivery_recovery',
        outcome: 'failed',
        error: prepared.error.message,
      })
      return false
    }
    const inspected = yield* sourceControl.inspect(prepared.value).pipe(asSettled)
    if (inspected._tag === 'Failed') {
      // Not the same as a clean workspace, and treating it as one would let this pass dispatch an
      // agent onto changes it never looked at.
      yield* logWarning('delivery recovery could not read the worktree; retrying later', {
        ...logContext(issue),
        action: 'delivery_recovery',
        outcome: 'failed',
        error: inspected.error.message,
      })
      return false
    }
    if (inspected.value._tag === 'Clean') {
      // Nothing was retained. The issue is left exactly as it was found, so the ordinary dispatch
      // path decides what happens to it.
      return true
    }
    yield* logInfo('rediscovered unpublished agent work', {
      ...logContext(issue),
      action: 'delivery_recovery',
      outcome: 'recovered',
      branch: prepared.value.target.branchName,
      changed_files: inspected.value.dirtyFileCount,
    })
    yield* publishRetained(context, issue, effective, sourceControl, handoff, prepared.value)
    return true
  })

/**
 * Looks through the active issues once, for work a previous process left behind.
 *
 * Placed after startup handoff recovery — which is what tells it whether a retained worktree is a
 * repair of an existing pull request or normal work on the issue's own branch — and before either
 * a repair or a dispatch can put an agent on the issue. That order is the point: publishing what
 * is already there costs a push, while letting a repair start first costs a whole turn and one of
 * the repair budget an operator's intervention threshold is measured against.
 *
 * It fetches the active issues itself rather than reading the dispatch pass's fetch, because it
 * has to run before the stage that would dispatch them. That is one extra tracker call in the
 * lifetime of a process.
 *
 * Answers whether it looked, so the pass reports the stage it actually performed.
 */
export const recoverRetainedDeliveries = (
  context: OrchestratorContext,
): Effect.Effect<boolean, never, Scope.Scope> =>
  Effect.gen(function* () {
    const opening = yield* Ref.get(context.state)
    const outstanding = opening.deliveryRecoveryFinished && opening.unexaminedWorkspaces.size === 0
    if (outstanding || !opening.startupRecoveryFinished) {
      return false
    }
    const effective = opening.lastKnownGood
    if (effective.sourceControl === null) {
      yield* Ref.update(context.state, (current) =>
        Transitions.finishDeliveryRecovery(current, new Set()),
      )
      return true
    }
    const candidates = yield* effective.tracker
      .fetchIssuesByStates(effective.workflow.config.tracker.activeStates, null, {
        hydrateDependencies: false,
      })
      .pipe(asSettled)
    if (candidates._tag === 'Failed') {
      // Nothing is concluded from a tracker that could not be reached: the flag stays down and the
      // next pass looks again, because work left in a workspace does not expire.
      yield* logWarning('delivery recovery issue fetch failed; retrying on the next pass', {
        action: 'delivery_recovery',
        outcome: 'failed',
        error: candidates.error.message,
      })
      return false
    }
    // Deliberately not filtered by dispatch eligibility. A change that already exists is owed a
    // publication whether or not the issue would be dispatched again: a routing label removed
    // between the failed publication and this restart says nothing about the diff on disk.
    const unexamined = new Set<IssueId>()
    for (const issue of candidates.value) {
      if (!(yield* recoverIssue(context, issue))) {
        unexamined.add(issue.id)
      }
    }
    // The scan has run either way. What it could not read is carried as the set dispatch refuses,
    // so one unreadable workspace holds back its own issue rather than every issue — and the next
    // pass looks at it again.
    yield* Ref.update(context.state, (current) =>
      Transitions.finishDeliveryRecovery(current, unexamined),
    )
    return true
  })
