import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Effect, ParseResult, Schema } from 'effect'

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
  reviewRequestedHeadSha: Schema.optionalWith(nullableString, { exact: true }),
  reviewCompletedHeadSha: Schema.optionalWith(nullableString, { exact: true }),
  observedAt,
}).annotations({ message: () => 'handoff snapshot is malformed' })

/** Versioned at the envelope so a future format is added as another schema union member. */
const handoffStoreV1 = Schema.Struct({
  version: Schema.Literal(1),
  handoffs: Schema.Array(handoffSnapshot),
}).annotations({ message: () => 'handoff store envelope is not version 1 or contains bad data' })

const storeError = (operation: 'read' | 'write', path: string, cause: unknown): HandoffStoreError =>
  new HandoffStoreError({
    operation,
    message: `Could not ${operation} handoff store ${path}${cause instanceof Error ? `: ${cause.message}` : ''}`,
    cause,
  })

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

export const loadHandoffs = (
  path: string,
): Effect.Effect<readonly HandoffSnapshot[], HandoffStoreError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(path, 'utf8')
      } catch (cause: unknown) {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'ENOENT'
        ) {
          return null
        }
        throw cause
      }
    },
    catch: (cause: unknown) => storeError('read', path, cause),
  }).pipe(
    Effect.flatMap((contents) => {
      if (contents === null) {
        return Effect.succeed<readonly HandoffSnapshot[]>([])
      }
      return Effect.try({
        try: (): unknown => JSON.parse(contents),
        catch: (cause: unknown) => decodeError(path, 'the file is not valid JSON', cause),
      }).pipe(
        Effect.flatMap((parsed) =>
          Schema.decodeUnknown(handoffStoreV1)(parsed).pipe(
            Effect.mapError((error) => schemaDecodeError(path, error)),
          ),
        ),
        Effect.map(({ handoffs }) => handoffs),
      )
    }),
  )

export const saveHandoffs = (
  path: string,
  handoffs: readonly HandoffSnapshot[],
): Effect.Effect<void, HandoffStoreError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      const temporaryPath = `${path}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, handoffs }, null, 2)}\n`, {
        mode: 0o600,
      })
      await rename(temporaryPath, path)
    },
    catch: (cause: unknown) => storeError('write', path, cause),
  })
