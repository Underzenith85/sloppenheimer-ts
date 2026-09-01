import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { dirname } from 'node:path'
import { Effect, Option, ParseResult, Schema } from 'effect'

/**
 * What both of the orchestrator's on-disk stores are made of.
 *
 * A store is one versioned JSON envelope under `.sloppenheimer/`, read once at startup and
 * rewritten whole. The mechanics are the same for each of them — a store that has never been
 * written is an empty one, a malformed document is a named decode failure rather than a crash, and
 * a write lands atomically — so they are stated once here, and each store supplies only its
 * envelope schema and its own error vocabulary.
 *
 * The error is a parameter rather than a shared type: the stores fail independently and an operator
 * reading the message is entitled to be told which one failed.
 */
export type StoreFailure<Failure> = (
  operation: 'read' | 'write',
  message: string,
  cause: unknown,
) => Failure

/**
 * A platform failure reported the way these stores have always reported one. `description` carries
 * the underlying `fs` error's own message, so the operator-visible text is unchanged by reading the
 * filesystem through the platform layer rather than through `node:fs/promises` directly.
 */
const platformFailure =
  <Failure>(
    operation: 'read' | 'write',
    label: string,
    path: string,
    fail: StoreFailure<Failure>,
  ) =>
  (error: PlatformError): Failure =>
    fail(
      operation,
      `Could not ${operation} ${label} ${path}${error.description === undefined ? '' : `: ${error.description}`}`,
      error,
    )

/**
 * Reads the store, treating a store that has never been written as an empty one.
 *
 * Absence is decided by the platform error's `reason` rather than by inspecting an `ENOENT` code on
 * an unknown cause, so the one failure this store recovers from is named rather than string-matched.
 */
export const loadStoreDocument = <Decoded, Encoded, Failure>(options: {
  readonly path: string
  /** How the store names itself in an operator-visible failure, such as `handoff store`. */
  readonly label: string
  readonly schema: Schema.Schema<Decoded, Encoded>
  /** What a store that has never been written decodes to. */
  readonly absent: Decoded
  readonly fail: StoreFailure<Failure>
}): Effect.Effect<Decoded, Failure, FileSystem.FileSystem> => {
  const { path, label, schema, absent, fail } = options
  const decodeFailure = (detail: string, cause: unknown): Failure =>
    fail('read', `Could not decode ${label} ${path}: ${detail}`, cause)
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path, 'utf8')),
    Effect.map(Option.some<string>),
    Effect.catchAll((error) =>
      error._tag === 'SystemError' && error.reason === 'NotFound'
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(platformFailure('read', label, path, fail)(error)),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(absent),
        onSome: (contents) =>
          Effect.try({
            try: (): unknown => JSON.parse(contents),
            catch: (cause: unknown) => decodeFailure('the file is not valid JSON', cause),
          }).pipe(
            Effect.flatMap((parsed) =>
              Schema.decodeUnknown(schema)(parsed).pipe(
                Effect.mapError((error: ParseResult.ParseError) =>
                  decodeFailure(
                    ParseResult.ArrayFormatter.formatIssueSync(error.issue)[0]?.message ??
                      `${label} schema rejected the document`,
                    error,
                  ),
                ),
              ),
            ),
          ),
      }),
    ),
  )
}

/** Written to a sibling temporary file and renamed over the store, so a reader never sees a partial document. */
export const saveStoreDocument = <Failure>(options: {
  readonly path: string
  readonly label: string
  readonly document: unknown
  readonly fail: StoreFailure<Failure>
}): Effect.Effect<void, Failure, FileSystem.FileSystem> => {
  const { path, label, document, fail } = options
  return Effect.try({
    try: () => `${JSON.stringify(document, null, 2)}\n`,
    catch: (cause: unknown) =>
      fail(
        'write',
        `Could not write ${label} ${path}${cause instanceof Error ? `: ${cause.message}` : ''}`,
        cause,
      ),
  }).pipe(
    Effect.flatMap((serialized) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const temporaryPath = `${path}.tmp`
        yield* fileSystem.makeDirectory(dirname(path), { recursive: true })
        yield* fileSystem.writeFileString(temporaryPath, serialized, { mode: 0o600 })
        yield* fileSystem.rename(temporaryPath, path)
      }).pipe(Effect.mapError(platformFailure('write', label, path, fail))),
    ),
  )
}
