import type { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { HandoffStoreError } from '../domain/errors.js'
import { handoffSnapshotSchema, type HandoffSnapshot } from '../domain/handoff.js'
import { loadStoreDocument, saveStoreDocument, type StoreFailure } from './json-store.js'

/** Versioned at the envelope so a future format is added as another schema union member. */
const handoffStoreV1 = Schema.Struct({
  version: Schema.Literal(1),
  handoffs: Schema.Array(handoffSnapshotSchema),
}).annotations({ message: () => 'handoff store envelope is not version 1 or contains bad data' })

const label = 'handoff store'

const fail: StoreFailure<HandoffStoreError> = (operation, message, cause) =>
  new HandoffStoreError({ operation, message, cause })

export const loadHandoffs = (
  path: string,
): Effect.Effect<readonly HandoffSnapshot[], HandoffStoreError, FileSystem.FileSystem> =>
  loadStoreDocument({
    path,
    label,
    schema: handoffStoreV1,
    absent: { version: 1, handoffs: [] } as const,
    fail,
  }).pipe(Effect.map(({ handoffs }) => handoffs))

export const saveHandoffs = (
  path: string,
  handoffs: readonly HandoffSnapshot[],
): Effect.Effect<void, HandoffStoreError, FileSystem.FileSystem> =>
  saveStoreDocument({ path, label, document: { version: 1, handoffs }, fail })
