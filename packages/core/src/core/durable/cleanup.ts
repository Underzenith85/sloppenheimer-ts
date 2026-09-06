import { Clock, Effect, Ref } from 'effect'

import type { DurableWorkflow } from '../../domain/durable-workflow.js'
import type { WorkspaceManagerPort } from '../../ports/workspace.js'
import { WorkspaceError } from '../../domain/errors.js'
import type { Writer } from './run-journal.js'

export const queueCleanup = (write: Writer, issueId: string): Effect.Effect<void> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      write(issueId, (current) => {
        if (current.artifact === null || current.cleanup !== undefined) {
          return current
        }
        return {
          ...current,
          intent: 'cancelled',
          cleanup: {
            workspacePath: current.artifact.workspacePath,
            workspaceKey: current.artifact.workspaceKey,
            state: 'queued',
            attempts: 0,
            dueAt: now,
            reason: null,
          },
        }
      }),
    ),
  )

/** A failed cleanup remains durable even when the tracker no longer returns its issue. */
export const runCleanup = (
  records: Ref.Ref<ReadonlyMap<string, DurableWorkflow>>,
  write: Writer,
  issueId: string,
  workspaces: Pick<WorkspaceManagerPort, 'removeCaptured'>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (;;) {
      const before = (yield* Ref.get(records)).get(issueId)
      const cleanup = before?.cleanup
      if (
        before === undefined ||
        cleanup === undefined ||
        cleanup.state === 'completed' ||
        cleanup.state === 'intervention'
      ) {
        return
      }
      yield* Effect.sleep(Math.max(0, cleanup.dueAt - (yield* Clock.currentTimeMillis)))
      const attempt = cleanup.attempts + 1
      const claimed = { ...cleanup, attempts: attempt, state: 'running' as const }
      yield* write(issueId, (current) =>
        current.cleanup === cleanup
          ? {
              ...current,
              cleanup: claimed,
            }
          : current,
      )
      if ((yield* Ref.get(records)).get(issueId)?.cleanup !== claimed) {
        return
      }
      const remove = workspaces.removeCaptured
      const result = yield* (
        remove === undefined
          ? Effect.fail(
              new WorkspaceError({
                category: 'remove_failed',
                message: 'Captured cleanup capability is unavailable',
              }),
            )
          : remove({ path: cleanup.workspacePath, key: cleanup.workspaceKey })
      ).pipe(
        Effect.timeoutFail({
          duration: 60_000,
          onTimeout: () =>
            new WorkspaceError({ category: 'remove_failed', message: 'Cleanup deadline expired' }),
        }),
        Effect.either,
      )
      const now = yield* Clock.currentTimeMillis
      yield* write(issueId, (current) => {
        if (current.cleanup !== claimed) {
          return current
        }
        return {
          ...current,
          cleanup: {
            ...cleanup,
            attempts: attempt,
            state: result._tag === 'Right' ? 'completed' : attempt >= 5 ? 'intervention' : 'retry',
            dueAt: now + 1_000 * 2 ** attempt,
            reason: result._tag === 'Right' ? null : result.left.message,
          },
        }
      })
    }
  })
