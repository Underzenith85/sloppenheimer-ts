import { FileSystem } from '@effect/platform'
import { resolve } from 'node:path'
import { Effect, Option, type Scope } from 'effect'

import type { Workspace } from '@sloppenheimer/core/domain/domain.js'
import {
  declaredWorkspacePath,
  rejectWorkspace,
  resolvedWithinRootRejection,
  verifiedDirectoryRejection,
  verifiedHandleRejection,
  verifiedRootRejection,
  type DirectoryIdentity,
  type VerifiedWorkspace,
} from '@sloppenheimer/core/domain/workspace-containment.js'
import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import { isSymbolicLink } from './filesystem.js'

/**
 * The filesystem half of workspace containment. Every rule and every rejection message lives in
 * `domain/workspace-containment.ts`; this module only asks the questions the rules compare — the
 * directory's own identity, its canonical path, and an open handle on it — and sequences them.
 */

/**
 * Every rejection carries its own message, so a rule that rejected already says what is wrong and
 * travels unchanged. Anything else — a platform failure — becomes the one rejection the step is
 * entitled to report.
 */
const rejectedAs =
  (message: string) =>
  <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ): Effect.Effect<Value, WorkspaceError, Requirements> =>
    Effect.mapError(effect, (cause: unknown) =>
      cause instanceof WorkspaceError ? cause : rejectWorkspace(message),
    )

/**
 * Fails with a rule's rejection when it produced one. The rules decide and return; sequencing that
 * decision into the error channel is this module's half of the work.
 */
const rejecting = (rejection: Option.Option<WorkspaceError>): Effect.Effect<void, WorkspaceError> =>
  Option.match(rejection, {
    onNone: () => Effect.void,
    onSome: (error) => Effect.fail(error),
  })

/**
 * The device and inode a rule compares. `File.Info` reports the inode optionally, because not every
 * platform backend has one to report; a directory whose inode cannot be read can never be re-bound,
 * so it is rejected here rather than verified against a value that is not there.
 */
const directoryIdentityOf = (
  path: string,
  info: FileSystem.File.Info,
): Effect.Effect<DirectoryIdentity, WorkspaceError> =>
  Option.match(info.ino, {
    onNone: () =>
      Effect.fail(rejectWorkspace(`workspace directory identity is unavailable: ${path}`)),
    onSome: (inode) => Effect.succeed({ deviceId: info.dev, inode }),
  })

/**
 * What the path is, without following it: a symbolic link and a non-directory are each rejected on
 * their own terms, and a path the filesystem cannot describe at all is reported as absent.
 */
const directoryIdentity = (
  path: string,
): Effect.Effect<DirectoryIdentity, WorkspaceError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    if (yield* isSymbolicLink(fileSystem, path)) {
      return yield* Effect.fail(rejectWorkspace(`workspace path is a symbolic link: ${path}`))
    }
    const info = yield* fileSystem.stat(path)
    if (info.type !== 'Directory') {
      return yield* Effect.fail(rejectWorkspace(`workspace path is not a directory: ${path}`))
    }
    return yield* directoryIdentityOf(path, info)
  }).pipe(rejectedAs(`workspace directory is not present: ${path}`))

const canonicalRoot = (
  root: string,
): Effect.Effect<string, WorkspaceError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.realPath(resolve(root))),
    rejectedAs(`configured workspace root is not present: ${resolve(root)}`),
  )

/**
 * The single containment invariant every executor must satisfy immediately before launching an
 * agent. Creation-time checks are not enough: a `Workspace` value can be stale, forged, or the
 * directory can have been replaced since it was produced.
 *
 * Returns the canonical workspace path, the canonical root it was checked against, and the device
 * and inode that path resolved to, so every later consumer can confirm it is the same directory.
 */
export const verifyWorkspaceForLaunch = (
  root: string,
  workspace: Workspace,
): Effect.Effect<VerifiedWorkspace, WorkspaceError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const { normalizedRoot, declaredPath } = yield* declaredWorkspacePath(root, workspace)
    yield* directoryIdentity(declaredPath)
    const rootPath = yield* canonicalRoot(normalizedRoot)
    const realWorkspace = yield* fileSystem.realPath(declaredPath)
    yield* rejecting(resolvedWithinRootRejection(rootPath, realWorkspace))
    const resolved = yield* directoryIdentity(realWorkspace)
    return {
      path: realWorkspace,
      rootPath,
      deviceId: resolved.deviceId,
      inode: resolved.inode,
    }
  }).pipe(rejectedAs('workspace containment could not be verified'))

/**
 * Re-binds a verified workspace at a path-consuming boundary. Both the root and the workspace are
 * compared against the canonical values captured at verification, so a directory renamed and
 * replaced between verification and use is rejected instead of followed. The root is compared
 * canonically, so a configured root that is itself a symlink still verifies.
 */
export const assertWorkspaceIdentity = (
  root: string,
  verified: VerifiedWorkspace,
): Effect.Effect<void, WorkspaceError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const rootPath = yield* canonicalRoot(root)
    yield* rejecting(verifiedRootRejection(verified, rootPath))
    const resolved = yield* directoryIdentity(verified.path)
    const current = yield* fileSystem.realPath(verified.path)
    yield* rejecting(verifiedDirectoryRejection(verified, current, resolved))
  }).pipe(rejectedAs('workspace identity could not be confirmed'))

/**
 * Verifies containment and then holds an open handle on the verified directory for the caller's
 * scope. Holding the handle keeps the inode allocated, so a directory deleted and recreated at the
 * same path is guaranteed a different inode and cannot pass the identity check.
 *
 * `FileSystem.open` is scoped, so the handle is released with the caller's scope rather than
 * through a release this module has to write and swallow the failure of.
 */
export const openVerifiedWorkspace = (
  root: string,
  workspace: Workspace,
): Effect.Effect<VerifiedWorkspace, WorkspaceError, FileSystem.FileSystem | Scope.Scope> =>
  verifyWorkspaceForLaunch(root, workspace).pipe(
    Effect.flatMap((verified) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) => fileSystem.open(verified.path, { flag: 'r' })),
        rejectedAs(`workspace directory could not be held open: ${verified.path}`),
        Effect.flatMap((handle) =>
          handle.stat.pipe(
            Effect.flatMap((held) => directoryIdentityOf(verified.path, held)),
            Effect.flatMap((identity) => rejecting(verifiedHandleRejection(verified, identity))),
            Effect.as(verified),
            rejectedAs(`workspace handle could not be confirmed: ${verified.path}`),
          ),
        ),
      ),
    ),
    // With the correct inode pinned, confirm the path still resolves to it.
    Effect.tap((verified) => assertWorkspaceIdentity(root, verified)),
  )
