import { Effect, Option, Ref } from 'effect'
import { issueId } from '../../domain/domain.js'
import type { SourceControlPort } from '../../ports/source-control.js'
import { asSettled } from '../../support/settled.js'
import { captureExecutionSnapshot } from '../policy.js'
import { scheduleDelivery } from './deliveries.js'
import type { RuntimeCells } from './types.js'
import { ownIssueFiber } from './execution.js'

/** Remote reads run off the mailbox so one unavailable repository cannot block controls or peers. */
export const startPublicationRecovery = (
  cells: RuntimeCells,
  sourceControl: SourceControlPort | null,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const durable = cells.durable
    if (durable === undefined) {
      return
    }
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
        const workspace =
          record.artifact === null
            ? null
            : { path: record.artifact.workspacePath, key: record.artifact.workspaceKey }
        const recovery = durable.reconcilePublication(
          record.issueId,
          sourceControl,
          workspace === null ? Effect.succeed(false) : workspaces.confirmStopped?.(workspace),
        )
        yield* ownIssueFiber(
          cells.execution,
          'recovery',
          issueId(record.issueId),
          concurrency.withPermits(1)(
            Effect.flatMap(
              (workspace === null
                ? recovery
                : (workspaces.superviseCaptured?.(workspace, recovery) ?? recovery)
              ).pipe(Effect.catchAll(() => Effect.succeed(Option.none()))),
              (prepared) =>
                Option.match(prepared, {
                  onNone: () => Effect.void,
                  onSome: (value) => resumeRetainedCandidate(cells, record.issueId, value),
                }),
            ),
          ),
        )
      }
    }
  })

const resumeRetainedCandidate = (
  cells: RuntimeCells,
  durableIssueId: string,
  prepared: import('../../ports/source-control.js').PreparedRepository,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(cells.state)
    const effective = state.lastKnownGood
    const fetched = yield* effective.tracker
      .fetchIssuesByIds([issueId(durableIssueId)])
      .pipe(asSettled)
    const issue = fetched._tag === 'Succeeded' ? fetched.value[0] : undefined
    const record = (yield* cells.durable?.snapshot ?? Effect.succeed([])).find(
      (entry) => entry.issueId === durableIssueId,
    )
    if (issue === undefined || record?.intent !== 'active') {
      return
    }
    const journal = yield* cells.durable?.journal(durableIssueId) ?? Effect.succeed(Option.none())
    const execution = {
      ...captureExecutionSnapshot(effective, ''),
      ...(Option.isNone(journal) ? {} : { journal: journal.value }),
    }
    yield* scheduleDelivery(cells, {
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
  })
