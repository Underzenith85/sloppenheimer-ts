/** Repair stays inside the admitted worker and its workspace lease, before candidate verification. */
import { Clock, Effect, MutableRef } from 'effect'
import type { Workspace } from '../domain/domain.js'
import { SourceControlError } from '../domain/errors.js'
import type { ResolvePublicationConflict } from '../ports/source-control.js'
import type { SessionLaunch } from './dispatch.js'
import { publicationEligibility } from './publication-eligibility.js'
import { runSession } from './run-session.js'
import { enterRunPhase } from './run-phase.js'

export const resolvePublicationConflict =
  (launch: SessionLaunch, workspace: Workspace): ResolvePublicationConflict =>
  (conflict) =>
    Effect.gen(function* () {
      const journal = launch.execution.journal?.publication
      if (journal?.repairing === undefined) {
        return yield* Effect.fail(
          new SourceControlError({
            category: 'rebase_conflict',
            message: 'Publication conflict requires durable repair admission',
            retryable: false,
            worktreePreserved: true,
          }),
        )
      }
      yield* publicationEligibility(
        launch.context.state,
        launch.issue,
        launch.execution,
        MutableRef.get(launch.sessionPorts).tracker,
      )
      yield* journal.repairing(conflict)
      const now = yield* Clock.currentTimeMillis
      const record = (yield* launch.context.durable.snapshot).find(
        (current) => current.issueId === launch.issue.id,
      )
      const remaining = Math.max(1, (record?.budgetDeadline ?? now) - now)
      const prompt = `${launch.execution.prompt}\n\n## Publication conflict repair\n\nThe host has paused its rebase of ${conflict.originalHeadSha} onto ${conflict.baseSha} at commit ${conflict.stoppedCommitSha}.\nConflicted paths: ${JSON.stringify(conflict.paths)}\nResolve these conflicts in the current worktree, preserving the intended implementation and the protected base changes. Later commits may still need to replay. Edit ordinary files only; do not stage, commit, abort, continue, rebase, or push. The host will continue this exact rebase and verify the final candidate. Do not run the full verification until the host has finished replaying all commits.\n`
      yield* runSession(launch, workspace, { conflictRepair: true, prompt }).pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlError({
              category: 'conflict_repair_failed',
              message: 'Publication conflict repair agent failed: ' + cause.message,
              retryable: false,
              worktreePreserved: true,
              cause,
            }),
        ),
        Effect.timeoutFail({
          duration: remaining,
          onTimeout: () =>
            new SourceControlError({
              category: 'conflict_repair_failed',
              message: 'Publication conflict repair exceeded the workflow deadline',
              retryable: false,
              worktreePreserved: true,
            }),
        }),
        Effect.ensuring(enterRunPhase(launch.context, launch.issue.id, launch.runId, 'Postflight')),
      )
    })
