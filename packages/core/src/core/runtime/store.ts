import { FileSystem } from '@effect/platform'
import { resolve } from 'node:path'
import { Effect, Option, Ref } from 'effect'

import type { HandoffSnapshot } from '../../domain/handoff.js'
import { currentInstant } from '../../support/clock.js'
import { logError } from '../../support/logging.js'
import { loadHandoffs, saveHandoffs } from '../handoff-store.js'
import type { EffectiveWorkflow, HandoffStoreError } from '../state.js'
import * as Transitions from '../transitions.js'
import type { HandoffStore, RuntimeCells } from './types.js'

/** What a startup read of the persisted store leaves for the initial state to open against. */
export type RestoredHandoffs = Readonly<{
  handoffs: readonly HandoffSnapshot[]
  storeReadFailed: boolean
  storeError: HandoffStoreError | null
}>

/**
 * Binds the handoff store to the workflow the orchestrator adopted. The filesystem is captured
 * once, so an operation that persists from a forked fiber carries no context of its own.
 */
export const handoffStoreFor = (
  bootstrap: EffectiveWorkflow,
): Effect.Effect<HandoffStore, never, FileSystem.FileSystem> =>
  Effect.map(FileSystem.FileSystem, (fileSystem) => ({
    path: resolve(bootstrap.workflow.config.workspaceRoot, '.sloppenheimer', 'handoffs.json'),
    disabled: Option.isNone(bootstrap.codeReview),
    onHostFileSystem: (effect) => Effect.provideService(effect, FileSystem.FileSystem, fileSystem),
  }))

/**
 * Reads the persisted handoffs at startup. A read that fails answers with an empty list and says
 * so, which is what stops `persistHandoffs` writing that emptiness back over the store.
 */
export const restoreHandoffs = (store: HandoffStore): Effect.Effect<RestoredHandoffs> =>
  store.disabled
    ? Effect.succeed({ handoffs: [], storeReadFailed: false, storeError: null })
    : store.onHostFileSystem(loadHandoffs(store.path)).pipe(
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

/**
 * Writes the current handoffs back to the store. It is a no-op while handoff is disabled, while
 * startup recovery is still running, and after a read that failed: in each of those the in-memory
 * list is not yet the whole truth, and the file on disk is.
 */
export const persistHandoffs = (cells: RuntimeCells): Effect.Effect<void> =>
  Effect.gen(function* () {
    const store = cells.handoffStore
    const current = yield* Ref.get(cells.state)
    if (store.disabled || !current.startupRecoveryFinished || current.storeReadFailed) {
      return
    }
    yield* store
      .onHostFileSystem(saveHandoffs(store.path, Transitions.handoffSnapshots(current)))
      .pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            const observedAt = yield* currentInstant
            yield* Ref.update(cells.state, (failing) =>
              Transitions.setHandoffStoreError(Transitions.noteRecovery(failing, { failed: 1 }), {
                operation: error.operation,
                message: error.message,
                observedAt,
              }),
            )
            yield* logError('handoff store write failed', {
              action: 'handoff_store_write',
              outcome: 'failed',
              path: store.path,
              error: error.message,
            })
          }),
        ),
      )
  })
