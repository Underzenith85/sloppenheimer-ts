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

import type { Issue } from '../domain/domain.js'
import { issueBranchName } from '../domain/handoff.js'
import { logInfo, logWarning } from '../support/logging.js'
import { asSettled } from '../support/settled.js'
import { settlePostflight } from './delivery.js'
import {
  captureExecutionSnapshot,
  identifierIssueNumber,
  issueIsActive,
  logContext,
} from './policy.js'
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
 * request lives, and that pull request is exactly what unpublished work is owed. A running worker
 * is already in the workspace, and a retained delivery publishes from it without an agent; each
 * ends in a postflight of its own, which is what makes it an answer rather than a gap.
 *
 * A queued retry is not on that list, because what it ends in is an agent placed into a workspace.
 * It answers for the workspace it is continuing in — and that is stated where it is true, by the
 * retry taking that workspace back when a cancellation had recorded it unread. It cannot answer for
 * a workspace nobody has read at all: after a reload moves the workspace root, the directory the
 * retry is about to enter is a different one, and may hold another process's retained work.
 */
const alreadyHandled = (state: RuntimeState, issue: Issue): boolean =>
  state.running.has(issue.id) || state.deliveries.has(issue.id)

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
        // A handoff's own ports, because a repair's verdict is judged against the workflow that
        // created its pull request — but always this process's workspace manager, because that is
        // the one that opened the workspace being published from. A reload may have moved the root
        // since the handoff was created, and a delivery carrying the older manager would later
        // remove a directory under a root the files are not under.
        execution:
          handoff === undefined
            ? captureExecutionSnapshot(effective, '')
            : {
                ...handoff.execution,
                workspaces: effective.workspaces,
                workspaceRoot: effective.workflow.config.workspaceRoot,
              },
        // No worker attempt owns this work: the process that produced it is gone. A retry that
        // follows starts the agent's numbering afresh, which is the truthful reading.
        attempt: null,
        // The repair identity, not the handoff. A pull request being open says nothing about what
        // produced the change in this workspace: an ordinary continuation leaves one behind too,
        // and it is owed the continuation its turn was owed rather than the claim being given up
        // the way a delivered repair's is.
        repairRun: handoff !== undefined && Option.isSome(handoff.repair),
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
    if (!issueIsActive(issue, effective.workflow.config.tracker)) {
      // The issue is finished with, so what is in its workspace goes with it rather than reaching
      // the remote. Publishing here would put a branch — and a pull request's next head — behind
      // work nobody asked for any more, which is the one case the policy calls a discard.
      yield* effective.workspaces.remove(issue.identifier).pipe(
        Effect.catchAll((error) =>
          logWarning('terminal workspace cleanup failed', {
            ...logContext(issue),
            action: 'workspace_cleanup',
            outcome: 'failed',
            error: error.message,
          }),
        ),
      )
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
 * Looks at every candidate whose workspace this process has not examined yet, for work a previous
 * one left behind.
 *
 * Per issue rather than once for the host: an issue that is inactive when the host starts, or that
 * the tracker has not reported yet, becomes a candidate later and arrives with whatever its
 * workspace holds — and a scan that had declared itself finished would hand that workspace straight
 * to an agent. The dispatch pass calls this with the candidates it already fetched, so covering
 * them costs no tracker call of its own, and after the first pass there is normally nothing left to
 * look at.
 *
 * Answers whether it looked at anything.
 */
export const examineWorkspaces = (
  context: OrchestratorContext,
  candidates: readonly Issue[],
): Effect.Effect<boolean, never, Scope.Scope> =>
  Effect.gen(function* () {
    const opening = yield* Ref.get(context.state)
    // Deliberately not filtered by dispatch eligibility. A change that already exists is owed a
    // publication whether or not the issue would be dispatched again: a routing label removed
    // between the failed publication and a restart says nothing about the diff on disk.
    const outstanding = candidates.filter((issue) => !opening.examinedWorkspaces.has(issue.id))
    if (outstanding.length === 0) {
      return false
    }
    for (const issue of outstanding) {
      const examined =
        opening.lastKnownGood.sourceControl === null ? true : yield* recoverIssue(context, issue)
      yield* Ref.update(context.state, (current) =>
        Transitions.noteWorkspaceExamined(current, issue.id, examined),
      )
    }
    return true
  })

/** What one startup sweep amounted to, which is what decides whether repairs may dispatch. */
export type SweepOutcome = 'skipped' | 'completed' | 'failed'

/**
 * The one sweep that runs before the first reconciliation.
 *
 * It exists for the ordering: a restored handoff's repair is dispatched by the reconciliation pass,
 * which runs before any candidate fetch, so without this a repair could be the first thing to enter
 * a workspace nobody had looked at — costing a whole turn and one of the repair budget to
 * rediscover work a push would have delivered. It fetches the active issues itself, which is one
 * extra tracker call in the lifetime of a process; everything after it rides on the dispatch pass's
 * own fetch through {@link examineWorkspaces}.
 */
export const sweepRetainedDeliveries = (
  context: OrchestratorContext,
): Effect.Effect<SweepOutcome, never, Scope.Scope> =>
  Effect.gen(function* () {
    const opening = yield* Ref.get(context.state)
    if (opening.startupSweepFinished || !opening.startupRecoveryFinished) {
      return 'skipped'
    }
    const effective = opening.lastKnownGood
    const candidates = yield* effective.tracker
      .fetchIssuesByStates(effective.workflow.config.tracker.activeStates, null, {
        hydrateDependencies: false,
      })
      .pipe(asSettled)
    if (candidates._tag === 'Failed') {
      // Nothing is concluded from a tracker that could not be reached: the sweep stays unfinished
      // and the next pass runs it, because work left in a workspace does not expire.
      yield* logWarning('delivery recovery issue fetch failed; retrying on the next pass', {
        action: 'delivery_recovery',
        outcome: 'failed',
        error: candidates.error.message,
      })
      return 'failed'
    }
    // The handoffs as well as the fetch. An open handoff keeps the workflow that created its pull
    // request, and a repair is judged against that one — so an issue this fetch omits, because a
    // reload narrowed the active states out from under it, is still an issue reconciliation can
    // put a repair into moments from now. A handoff's workspace is owed a look for as long as the
    // handoff lives, whatever the current workflow makes of its issue.
    const opened = yield* Ref.get(context.state)
    const byId = new Map(candidates.value.map((issue) => [issue.id, issue] as const))
    const missing = [...opened.handoffs.values()]
      .map((handoff) => handoff.issue)
      .filter((issue) => !byId.has(issue.id))
    // Fetched rather than taken from the handoff. The record persisted there is as old as the
    // handoff, and the very reason this fetch omitted the issue may be that it went terminal while
    // the host was down — which is a decision about the work in its workspace, not a gap.
    const refreshed =
      missing.length === 0
        ? { _tag: 'Succeeded' as const, value: [] as readonly Issue[] }
        : yield* effective.tracker
            .fetchIssuesByIds(missing.map((issue) => issue.id))
            .pipe(asSettled)
    if (refreshed._tag === 'Failed') {
      yield* logWarning('delivery recovery handoff refresh failed; retrying on the next pass', {
        action: 'delivery_recovery',
        outcome: 'failed',
        error: refreshed.error.message,
      })
      return 'failed'
    }
    for (const issue of refreshed.value) {
      byId.set(issue.id, issue)
    }
    yield* examineWorkspaces(context, [...byId.values()])
    yield* Ref.update(context.state, Transitions.finishStartupSweep)
    return 'completed'
  })
