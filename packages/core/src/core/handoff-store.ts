import type { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { HandoffStoreError } from '../domain/errors.js'
import type { HandoffSnapshot } from '../domain/handoff.js'
import { loadStoreDocument, saveStoreDocument, type StoreFailure } from './json-store.js'

const handoffState = Schema.Literal(
  'merged',
  'closed_without_merge',
  'awaiting_checks',
  'repair_needed',
  'rebase_needed',
  'ready_to_merge',
  'merging',
  'intervention_required',
).annotations({ message: () => 'handoff state is not recognized' })

const repairAttempts = Schema.Number.pipe(
  Schema.filter((value) => Number.isSafeInteger(value) && value >= 0),
).annotations({ message: () => 'repairAttempts must be a non-negative safe integer' })

const observedAt = Schema.String.pipe(
  Schema.filter((value) => !Number.isNaN(Date.parse(value))),
).annotations({ message: () => 'observedAt must be a date string' })

const nullableString = Schema.NullOr(Schema.String)

const handoffSnapshot = Schema.Struct({
  issueId: Schema.String,
  identifier: Schema.String,
  pullRequestUrl: Schema.String,
  branchName: Schema.String,
  state: handoffState,
  headSha: nullableString,
  reason: nullableString,
  repairAttempts,
  repairHeadShas: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
  repairObservedHeadShas: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
  repairStartedHeadSha: Schema.optionalWith(nullableString, { exact: true }),
  repairWorkerStarted: Schema.optionalWith(Schema.Boolean, { exact: true }),
  reviewRequestedHeadSha: Schema.optionalWith(nullableString, { exact: true }),
  reviewCompletedHeadSha: Schema.optionalWith(nullableString, { exact: true }),
  observedAt,
}).annotations({ message: () => 'handoff snapshot is malformed' })

/** Versioned at the envelope so a future format is added as another schema union member. */
const handoffStoreV1 = Schema.Struct({
  version: Schema.Literal(1),
  handoffs: Schema.Array(handoffSnapshot),
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
