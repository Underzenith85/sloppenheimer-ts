import type { FileSystem } from '@effect/platform'
import { SystemError, type PlatformError } from '@effect/platform/Error'
import { rmdir } from 'node:fs/promises'
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
