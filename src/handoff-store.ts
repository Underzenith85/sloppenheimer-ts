import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { dirname } from 'node:path'
import { Effect, Option, ParseResult, Schema } from 'effect'

import { HandoffStoreError } from './errors.js'
import type { HandoffSnapshot } from './domain/handoff.js'

const handoffState = Schema.Literal(
  'merged',
  'closed_without_merge',
  'awaiting_checks',
  'repair_needed',
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

const storeError = (
  operation: 'read' | 'write',
  path: string,
  detail: string,
  cause: unknown,
): HandoffStoreError =>
  new HandoffStoreError({
    operation,
    message: `Could not ${operation} handoff store ${path}${detail}`,
    cause,
  })

/**
 * A platform failure reported the way this store has always reported one. `description` carries the
 * underlying `fs` error's own message, so the operator-visible text is unchanged by reading the
 * filesystem through the platform layer rather than through `node:fs/promises` directly.
 */
const platformStoreError =
  (operation: 'read' | 'write', path: string) =>
  (error: PlatformError): HandoffStoreError =>
    storeError(
      operation,
      path,
      error.description === undefined ? '' : `: ${error.description}`,
      error,
    )

const decodeError = (path: string, detail: string, cause: unknown): HandoffStoreError =>
  new HandoffStoreError({
    operation: 'read',
    message: `Could not decode handoff store ${path}: ${detail}`,
    cause,
  })

const schemaDecodeError = (path: string, error: ParseResult.ParseError): HandoffStoreError =>
  decodeError(
    path,
    ParseResult.ArrayFormatter.formatIssueSync(error.issue)[0]?.message ??
      'handoff store schema rejected the document',
    error,
  )

/**
 * Reads the store, treating a store that has never been written as no handoffs.
 *
 * Absence is decided by the platform error's `reason` rather than by inspecting an `ENOENT` code on
 * an unknown cause, so the one failure this store recovers from is named rather than string-matched.
 */
export const loadHandoffs = (
  path: string,
): Effect.Effect<readonly HandoffSnapshot[], HandoffStoreError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path, 'utf8')),
    Effect.map(Option.some<string>),
    Effect.catchAll((error) =>
      error._tag === 'SystemError' && error.reason === 'NotFound'
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(platformStoreError('read', path)(error)),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<readonly HandoffSnapshot[]>([]),
        onSome: (contents) =>
          Effect.try({
            try: (): unknown => JSON.parse(contents),
            catch: (cause: unknown) => decodeError(path, 'the file is not valid JSON', cause),
          }).pipe(
            Effect.flatMap((parsed) =>
              Schema.decodeUnknown(handoffStoreV1)(parsed).pipe(
                Effect.mapError((error) => schemaDecodeError(path, error)),
              ),
            ),
            Effect.map(({ handoffs }) => handoffs),
          ),
      }),
    ),
  )

/** Written to a sibling temporary file and renamed over the store, so a reader never sees a partial document. */
export const saveHandoffs = (
  path: string,
  handoffs: readonly HandoffSnapshot[],
): Effect.Effect<void, HandoffStoreError, FileSystem.FileSystem> =>
  Effect.try({
    try: () => `${JSON.stringify({ version: 1, handoffs }, null, 2)}\n`,
    catch: (cause: unknown) =>
      storeError('write', path, cause instanceof Error ? `: ${cause.message}` : '', cause),
  }).pipe(
    Effect.flatMap((document) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const temporaryPath = `${path}.tmp`
        yield* fileSystem.makeDirectory(dirname(path), { recursive: true })
        yield* fileSystem.writeFileString(temporaryPath, document, { mode: 0o600 })
        yield* fileSystem.rename(temporaryPath, path)
      }).pipe(Effect.mapError(platformStoreError('write', path))),
    ),
  )
