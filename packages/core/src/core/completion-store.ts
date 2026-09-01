import type { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { issueId } from '../domain/domain.js'
import { CompletionStoreError } from '../domain/errors.js'
import { loadStoreDocument, saveStoreDocument, type StoreFailure } from './json-store.js'
import type { CompletedSnapshot } from './state.js'

/**
 * What this host has finished, kept beside the handoffs it is still following.
 *
 * Reconciliation deletes a merged handoff from the handoff store the moment it completes, so
 * without this file the finished work would exist nowhere on disk and a restart inside the
 * console's Finished window would empty a view that had a pull request merged minutes earlier.
 */
const nullableString = Schema.NullOr(Schema.String)

const finishedAt = Schema.String.pipe(
  Schema.filter((value) => !Number.isNaN(Date.parse(value))),
).annotations({ message: () => 'finishedAt must be a date string' })

const completedSnapshot = Schema.Struct({
  issueId: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: nullableString,
  outcome: Schema.Literal('merged'),
  finishedAt,
  pullRequestUrl: nullableString,
}).annotations({ message: () => 'completion snapshot is malformed' })

/** Versioned at the envelope so a future format is added as another schema union member. */
const completionStoreV1 = Schema.Struct({
  version: Schema.Literal(1),
  completions: Schema.Array(completedSnapshot),
}).annotations({ message: () => 'completion store envelope is not version 1 or contains bad data' })

const label = 'completion store'

const fail: StoreFailure<CompletionStoreError> = (operation, message, cause) =>
  new CompletionStoreError({ operation, message, cause })

export const loadCompletions = (
  path: string,
): Effect.Effect<readonly CompletedSnapshot[], CompletionStoreError, FileSystem.FileSystem> =>
  loadStoreDocument({
    path,
    label,
    schema: completionStoreV1,
    absent: { version: 1, completions: [] } as const,
    fail,
    // The issue identity is branded on the way back in, at the boundary that reads it, so nothing
    // downstream has to remember that a restored completion came from an untyped document.
  }).pipe(
    Effect.map(({ completions }) =>
      completions.map((entry) => ({ ...entry, issueId: issueId(entry.issueId) })),
    ),
  )

export const saveCompletions = (
  path: string,
  completions: readonly CompletedSnapshot[],
): Effect.Effect<void, CompletionStoreError, FileSystem.FileSystem> =>
  saveStoreDocument({ path, label, document: { version: 1, completions }, fail })
