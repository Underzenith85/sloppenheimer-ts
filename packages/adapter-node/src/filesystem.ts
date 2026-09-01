import { type FileSystem } from '@effect/platform'
import { SystemError, type PlatformError } from '@effect/platform/Error'
import { rmdir } from 'node:fs/promises'
import { Effect } from 'effect'

import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'

/**
 * The filesystem questions the workspace adapters ask that `FileSystem` does not answer directly,
 * and the shape they report a host's refusal in.
 */

/**
 * Whether `path` is itself a symbolic link, without following it.
 *
 * `FileSystem` offers no `lstat`, and its `stat` follows links: a link pointing at a directory
 * reports as a directory, so the substitution the workspace rules exist to reject would pass.
 * `readLink` answers what `lstat` was asked here — it succeeds only for a symbolic link, and
 * reports `NotFound` for a path that is not there, which is the one other case the callers
 * distinguish. It is therefore failed on rather than answered, and every other failure means the
 * path is present but is not a link.
 */
export const isSymbolicLink = (
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<boolean, PlatformError> =>
  fileSystem.readLink(path).pipe(
    Effect.as(true),
    Effect.catchAll((error) =>
      error._tag === 'SystemError' && error.reason === 'NotFound'
        ? Effect.fail(error)
        : Effect.succeed(false),
    ),
  )

/**
 * Removes a directory only while it is empty, and reports whether it went.
 *
 * `FileSystem.remove` cannot ask this question: without `recursive` it refuses a directory outright,
 * and with it, a directory that stopped being empty between the check and the call is deleted along
 * with whatever appeared inside it. `rmdir` makes emptiness and removal one decision the kernel
 * takes, so a workspace created while cleanup was scanning survives instead of being swept up with
 * the container it was created in. A directory already gone is reported the same way, because the
 * caller wanted it gone either way.
 */
export const removeDirectoryIfEmpty = (path: string): Effect.Effect<boolean, PlatformError> =>
  Effect.tryPromise({
    try: () => rmdir(path).then(() => true),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) => {
      const code = (cause as NodeJS.ErrnoException).code
      return code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT'
        ? Effect.succeed(false)
        : Effect.fail(
            new SystemError({
              reason: 'Unknown',
              module: 'FileSystem',
              method: 'remove',
              pathOrDescriptor: path,
              description: `could not remove the empty directory: ${path}`,
              cause,
            }),
          )
    }),
  )

/**
 * Whether a path holds a real directory: absent is `false`, and anything that is not a directory —
 * a file, or a symbolic link pointing somewhere else — is a rejection rather than an answer, so
 * nothing the workspace adapters enumerate, write into or remove can be a substituted path.
 *
 * The absent case is named by the platform error's `reason` rather than by matching an `ENOENT`
 * code on an unknown cause; every other platform failure is left for the calling operation to
 * report under its own category.
 */
export const realDirectoryExists = (
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<boolean, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    if (yield* isSymbolicLink(fileSystem, path)) {
      return yield* Effect.fail(
        new WorkspaceError({
          category: 'invalid_path',
          message: `path exists and is not a directory: ${path}`,
        }),
      )
    }
    const info = yield* fileSystem.stat(path)
    if (info.type !== 'Directory') {
      return yield* Effect.fail(
        new WorkspaceError({
          category: 'invalid_path',
          message: `path exists and is not a directory: ${path}`,
        }),
      )
    }
    return true
  }).pipe(
    Effect.catchIf(
      (error) => error._tag === 'SystemError' && error.reason === 'NotFound',
      () => Effect.succeed(false),
    ),
  )

/**
 * The one shape every operation reports through: a containment or lease rejection is already the
 * answer and travels unchanged, and anything else becomes this operation's own category.
 */
const workspaceFailure =
  (category: 'create_failed' | 'inspect_failed' | 'remove_failed', message: string) =>
  (cause: WorkspaceError | PlatformError): WorkspaceError =>
    cause instanceof WorkspaceError ? cause : new WorkspaceError({ category, message, cause })

/** Applies that shape to an operation's error channel. */
export const reportedAs =
  (category: 'create_failed' | 'inspect_failed' | 'remove_failed', message: string) =>
  <Value>(
    effect: Effect.Effect<Value, WorkspaceError | PlatformError>,
  ): Effect.Effect<Value, WorkspaceError> =>
    Effect.mapError(effect, workspaceFailure(category, message))
