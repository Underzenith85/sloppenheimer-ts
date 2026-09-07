import { Effect, Option, Ref } from 'effect'
import type { Issue } from '../../domain/domain.js'
import { issueId } from '../../domain/domain.js'
import type { PreparedRepository, SourceControlPort } from '../../ports/source-control.js'
import { logWarning } from '../../support/logging.js'
import { asSettled } from '../../support/settled.js'
import { captureExecutionSnapshot, stateIsIn } from '../policy.js'
import { scheduleDelivery } from './deliveries.js'
import type { RuntimeCells } from './types.js'
import type { DeliveryRequest, OrchestratorContext } from './types.js'
import { ownIssueFiber } from './execution.js'

type PublicationRecoveryRuntime = Pick<OrchestratorContext, 'durable' | 'state'> &
  Readonly<{ scheduleDelivery: (request: DeliveryRequest) => Effect.Effect<boolean> }>

/** Remote reads run off the mailbox so one unavailable repository cannot block controls or peers. */
export const startPublicationRecovery = (
  cells: RuntimeCells,
  sourceControl: SourceControlPort | null,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const durable = cells.durable
    const records = yield* durable.snapshot
    const workspaces = (yield* Ref.get(cells.state)).lastKnownGood.workspaces
    const concurrency = yield* Effect.makeSemaphore(4)
    for (const record of records) {
      if (
        record.cleanup !== undefined &&
        record.cleanup.state !== 'completed' &&
        record.cleanup.state !== 'intervention'
      ) {
        yield* ownIssueFiber(
          cells.execution,
          'cleanup',
          issueId(record.issueId),
          durable.cleanup(record.issueId, workspaces),
        )
      }
      if (record.status._tag === 'Intervention' && sourceControl !== null) {
        yield* ownIssueFiber(
          cells.execution,
          'recovery',
          issueId(record.issueId),
          concurrency.withPermits(1)(
            recoverPublicationIntervention(
              {
                durable,
                state: cells.state,
                scheduleDelivery: (request) => scheduleDelivery(cells, request),
              },
              record.issueId,
              sourceControl,
            ).pipe(Effect.asVoid),
          ),
        )
      }
    }
  })

/**
 * Says why a recovery stopped where it did.
 *
 * A refusal that only answered `false` left the operator with a record still in intervention, no
 * running agent, and no account of either. `held` is for a refusal this attempt is the authority
 * on — the reconciliation never ran, so nothing else will write it — and replaces the record's
 * reason; everything else is logged and leaves the reason that is already there standing.
 */
const refuseRecovery = (
  runtime: PublicationRecoveryRuntime,
  durableIssueId: string,
  outcome: string,
  reason: string,
  held = false,
): Effect.Effect<boolean> =>
  logWarning('publication recovery refused', {
    issue_id: durableIssueId,
    action: 'publication_recovery',
    outcome,
    error: reason,
  }).pipe(
    Effect.zipRight(held ? runtime.durable.holdRecovery(durableIssueId, reason) : Effect.void),
    Effect.as(false),
  )

/** One reconciliation used by startup and by the operator's explicit attention retry. */
export const recoverPublicationIntervention = (
  runtime: PublicationRecoveryRuntime,
  durableIssueId: string,
  sourceControl: SourceControlPort,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const workspaces = (yield* Ref.get(runtime.state)).lastKnownGood.workspaces
    const record = (yield* runtime.durable.snapshot).find(
      (candidate) => candidate.issueId === durableIssueId,
    )
    const workspace =
      record?.artifact === null || record?.artifact === undefined
        ? null
        : { path: record.artifact.workspacePath, key: record.artifact.workspaceKey }
    if (record?.status._tag !== 'Intervention' || workspace === null) {
      return false
    }
    const effective = (yield* Ref.get(runtime.state)).lastKnownGood
    const fetched = yield* effective.tracker
      .fetchIssuesByIds([issueId(durableIssueId)], { hydrateDependencies: false })
      .pipe(asSettled)
    const issue = fetched._tag === 'Succeeded' ? fetched.value[0] : undefined
    if (issue === undefined) {
      // The tracker is what could not answer, not the remote: the candidate is left exactly as it
      // is, and the reason says which of the two the operator has to look at.
      return yield* refuseRecovery(
        runtime,
        durableIssueId,
        'issue_unavailable',
        fetched._tag === 'Failed'
          ? `The tracker could not be read for this recovery: ${fetched.error.message}`
          : 'The tracker no longer reports this issue; the retained candidate was left untouched.',
      )
    }
    if (stateIsIn(issue.state, effective.workflow.config.tracker.terminalStates)) {
      yield* runtime.durable.queueCleanup(durableIssueId)
      yield* runtime.durable.cleanup(durableIssueId, workspaces)
      return false
    }
    const recovery = runtime.durable.reconcilePublication(
      durableIssueId,
      sourceControl,
      workspaces.confirmStopped(workspace),
    )
    const prepared = yield* workspaces.superviseCaptured(workspace, recovery).pipe(asSettled)
    if (prepared._tag === 'Failed') {
      return yield* refuseRecovery(
        runtime,
        durableIssueId,
        'supervision_failed',
        `Retained workspace ${workspace.key} could not be supervised for recovery: ${prepared.error.message}`,
        true,
      )
    }
    return yield* Option.match(prepared.value, {
      onNone: () => Effect.succeed(false),
      onSome: (value) => resumeRetainedCandidate(runtime, durableIssueId, issue, value),
    })
  })

const resumeRetainedCandidate = (
  runtime: PublicationRecoveryRuntime,
  durableIssueId: string,
  issue: Issue,
  prepared: PreparedRepository,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(runtime.state)
    const effective = state.lastKnownGood
    const record = (yield* runtime.durable.snapshot).find(
      (entry) => entry.issueId === durableIssueId,
    )
    if (record?.intent !== 'active') {
      return false
    }
    const journal = yield* runtime.durable.journal(durableIssueId)
    const execution = {
      ...captureExecutionSnapshot(effective, ''),
      ...(Option.isNone(journal) ? {} : { journal: journal.value }),
    }
    const scheduled = yield* runtime.scheduleDelivery({
      issue,
      execution,
      prepared,
      attempt: 0,
      workerAttempt: null,
      failure: {
        category: 'publication_failed',
        message: 'Recovered retained candidate after restart',
        retryable: true,
        worktreePreserved: true,
      },
      changedFileCount: null,
      repairRun: prepared.target._tag === 'Repair',
    })
    return scheduled
      ? true
      : yield* refuseRecovery(
          runtime,
          durableIssueId,
          'delivery_refused',
          `The reconciled candidate for ${issue.identifier} could not be queued for delivery; the retained workspace is unchanged.`,
        )
  })
