import { FileSystem } from '@effect/platform'
import { resolve } from 'node:path'
import { Clock, Effect, Option, Ref } from 'effect'

import type { HandoffSnapshot } from '../../domain/handoff.js'
import { currentInstant } from '../../support/clock.js'
import { logError } from '../../support/logging.js'
import { loadCompletions, saveCompletions } from '../completion-store.js'
import { loadHandoffs, saveHandoffs } from '../handoff-store.js'
import {
  completionWindowMs,
  publishedCompletedWork,
  type CompletedSnapshot,
  type EffectiveWorkflow,
  type HandoffStoreError,
  type RuntimeState,
} from '../state.js'
import * as Transitions from '../transitions.js'
import type { RuntimeCells, RuntimeStore, RuntimeStores } from './types.js'

/** What a startup read of the persisted stores leaves for the initial state to open against. */
export type RestoredState = Readonly<{
  handoffs: readonly HandoffSnapshot[]
  completions: readonly CompletedSnapshot[]
  storeReadFailed: boolean
  storeError: HandoffStoreError | null
}>

/**
 * Where a store lives right now.
 *
 * The root is read from the workflow in force rather than from the one the host booted with: a
 * reload may move `workspaceRoot`, and a store written beside a root the host has left is one the
 * next startup would read nothing from. Both stores follow the same root, because they describe
 * one host's state and a restart reads them from one directory.
 */
export const storePath = (store: RuntimeStore, workspaceRoot: string): string =>
  resolve(workspaceRoot, '.sloppenheimer', store.file)

const rootOf = (state: RuntimeState): string => state.lastKnownGood.workflow.config.workspaceRoot

/**
 * Binds both stores to the workflow the orchestrator adopted and reads them, answering with what
 * the initial state opens against.
 *
 * Every completion comes from a merged handoff, so the two stores are under one gate: a
 * handoff-disabled run has nothing to record in either and must not write its empty lists over what
 * an earlier enabled run left behind.
 */
export const openStores = (
  bootstrap: EffectiveWorkflow,
): Effect.Effect<
  Readonly<{ stores: RuntimeStores; restored: RestoredState }>,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const disabled = Option.isNone(bootstrap.codeReview)
    const bound = (file: string): RuntimeStore => ({
      file,
      disabled,
      onHostFileSystem: (effect) =>
        Effect.provideService(effect, FileSystem.FileSystem, fileSystem),
    })
    const handoffs = bound('handoffs.json')
    const completions = bound('completions.json')
    const workspaceRoot = bootstrap.workflow.config.workspaceRoot
    const restoredHandoffs = yield* restoreHandoffs(handoffs, workspaceRoot)
    const restoredCompletions = yield* restoreCompletions(completions, workspaceRoot)
    return {
      stores: {
        handoffs,
        // A read that failed leaves a document this host has not seen, so it stops writing too:
        // replacing what it could not read would destroy the history it failed to restore.
        completions: { ...completions, disabled: disabled || restoredCompletions.readFailed },
      },
      restored: { ...restoredHandoffs, completions: restoredCompletions.completions },
    }
  })

/**
 * Reads the persisted handoffs at startup. A read that fails answers with an empty list and says
 * so, which is what stops `persistHandoffs` writing that emptiness back over the store.
 */
const restoreHandoffs = (
  store: RuntimeStore,
  workspaceRoot: string,
): Effect.Effect<Omit<RestoredState, 'completions'>> => {
  const path = storePath(store, workspaceRoot)
  return store.disabled
    ? Effect.succeed({ handoffs: [], storeReadFailed: false, storeError: null })
    : store.onHostFileSystem(loadHandoffs(path)).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            logError('handoff store read failed; preserving store during recovery', {
              action: 'handoff_store_read',
              outcome: 'failed',
              path,
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
}

/**
 * Reads the finished work an earlier host recorded, restored to the window the console shows and
 * no further: a completion outside it would be read back and never rendered.
 *
 * A read failure loses history rather than a claim, so it degrades the way the handoff store's
 * does — logged, nothing restored, startup carries on. It is deliberately not folded into the
 * snapshot's `handoff_recovery`, which reports on recovering pull requests.
 */
const restoreCompletions = (
  store: RuntimeStore,
  workspaceRoot: string,
): Effect.Effect<Readonly<{ completions: readonly CompletedSnapshot[]; readFailed: boolean }>> => {
  const path = storePath(store, workspaceRoot)
  return store.disabled
    ? Effect.succeed({ completions: [], readFailed: false })
    : Effect.all([store.onHostFileSystem(loadCompletions(path)), Clock.currentTimeMillis]).pipe(
        Effect.map(([completions, now]) => ({
          completions: completions
            .filter((completion) => now - Date.parse(completion.finishedAt) <= completionWindowMs)
            .sort((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt))
            .slice(0, publishedCompletedWork),
          readFailed: false,
        })),
        Effect.catchAll((error) =>
          logError('completion store read failed; preserving store', {
            action: 'completion_store_read',
            outcome: 'failed',
            path,
            error: error.message,
          }).pipe(Effect.as({ completions: [] as readonly CompletedSnapshot[], readFailed: true })),
        ),
      )
}

/**
 * Writes the current handoffs back to the store. It is a no-op while handoff is disabled, while
 * startup recovery is still running, and after a read that failed: in each of those the in-memory
 * list is not yet the whole truth, and the file on disk is.
 */
export const persistHandoffs = (cells: RuntimeCells): Effect.Effect<void> =>
  Effect.gen(function* () {
    const store = cells.stores.handoffs
    const current = yield* Ref.get(cells.state)
    if (store.disabled || !current.startupRecoveryFinished || current.storeReadFailed) {
      return
    }
    const path = storePath(store, rootOf(current))
    yield* store.onHostFileSystem(saveHandoffs(path, Transitions.handoffSnapshots(current))).pipe(
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
            path,
            error: error.message,
          })
        }),
      ),
    )
  })

/**
 * Written whenever this host finishes a piece of work, so the Finished view survives a restart. A
 * failure is logged and dropped: the completion is already recorded in memory and published, and
 * losing the history of it must not disturb the merge that produced it.
 */
export const persistCompletions = (cells: RuntimeCells): Effect.Effect<void> =>
  Effect.gen(function* () {
    const store = cells.stores.completions
    if (store.disabled) {
      return
    }
    const current = yield* Ref.get(cells.state)
    const path = storePath(store, rootOf(current))
    yield* store
      .onHostFileSystem(saveCompletions(path, Transitions.publishedCompletions(current)))
      .pipe(
        Effect.catchAll((error) =>
          logError('completion store write failed', {
            action: 'completion_store_write',
            outcome: 'failed',
            path,
            error: error.message,
          }),
        ),
      )
  })
