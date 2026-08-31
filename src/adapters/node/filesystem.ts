import type { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Effect } from 'effect'

/**
 * The filesystem questions the workspace adapters ask that `FileSystem` does not answer directly.
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
