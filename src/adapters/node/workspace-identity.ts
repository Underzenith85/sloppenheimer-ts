import type { Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Effect, type Scope } from 'effect'

import type { Workspace } from '../../domain/domain.js'
import {
  assertResolvedWithinRoot,
  assertVerifiedDirectory,
  assertVerifiedHandle,
  assertVerifiedRoot,
  declaredWorkspacePath,
  rejectWorkspace,
  type VerifiedWorkspace,
} from '../../domain/workspace-containment.js'
import { WorkspaceError } from '../../errors.js'

/**
 * The filesystem half of workspace containment. Every rule and every rejection message lives in
 * `domain/workspace-containment.ts`; this module only asks the questions the rules compare —
 * `lstat`, `realpath`, and an open directory handle — and sequences them.
 */

const directoryIdentity = async (path: string): Promise<Stats> => {
  let info: Stats
  try {
    info = await lstat(path)
  } catch {
    throw rejectWorkspace(`workspace directory is not present: ${path}`)
  }
  if (info.isSymbolicLink()) {
    throw rejectWorkspace(`workspace path is a symbolic link: ${path}`)
  }
  if (!info.isDirectory()) {
    throw rejectWorkspace(`workspace path is not a directory: ${path}`)
  }
  return info
}

const canonicalRoot = async (root: string): Promise<string> => {
  try {
    return await realpath(resolve(root))
  } catch {
    throw rejectWorkspace(`configured workspace root is not present: ${resolve(root)}`)
  }
}

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
): Effect.Effect<VerifiedWorkspace, WorkspaceError> =>
  Effect.tryPromise({
    try: async () => {
      const { normalizedRoot, declaredPath } = declaredWorkspacePath(root, workspace)
      await directoryIdentity(declaredPath)
      const rootPath = await canonicalRoot(normalizedRoot)
      const realWorkspace = await realpath(declaredPath)
      assertResolvedWithinRoot(rootPath, realWorkspace)
      const resolved = await directoryIdentity(realWorkspace)
      return { path: realWorkspace, rootPath, deviceId: resolved.dev, inode: resolved.ino }
    },
    catch: (cause: unknown) =>
      cause instanceof WorkspaceError
        ? cause
        : rejectWorkspace('workspace containment could not be verified'),
  })

/**
 * Re-binds a verified workspace at a path-consuming boundary. Both the root and the workspace are
 * compared against the canonical values captured at verification, so a directory renamed and
 * replaced between verification and use is rejected instead of followed. The root is compared
 * canonically, so a configured root that is itself a symlink still verifies.
 */
export const assertWorkspaceIdentity = (
  root: string,
  verified: VerifiedWorkspace,
): Effect.Effect<void, WorkspaceError> =>
  Effect.tryPromise({
    try: async () => {
      const rootPath = await canonicalRoot(root)
      assertVerifiedRoot(verified, rootPath)
      const resolved = await directoryIdentity(verified.path)
      const current = await realpath(verified.path)
      assertVerifiedDirectory(verified, current, { deviceId: resolved.dev, inode: resolved.ino })
    },
    catch: (cause: unknown) =>
      cause instanceof WorkspaceError
        ? cause
        : rejectWorkspace('workspace identity could not be confirmed'),
  })

/**
 * Verifies containment and then holds an open handle on the verified directory for the caller's
 * scope. Holding the handle keeps the inode allocated, so a directory deleted and recreated at the
 * same path is guaranteed a different inode and cannot pass the identity check.
 */
export const openVerifiedWorkspace = (
  root: string,
  workspace: Workspace,
): Effect.Effect<VerifiedWorkspace, WorkspaceError, Scope.Scope> =>
  verifyWorkspaceForLaunch(root, workspace).pipe(
    Effect.flatMap((verified) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => open(verified.path, 'r'),
          catch: (cause: unknown) =>
            cause instanceof WorkspaceError
              ? cause
              : rejectWorkspace(`workspace directory could not be held open: ${verified.path}`),
        }),
        (handle) => Effect.promise(() => handle.close().catch(() => undefined)),
      ).pipe(
        Effect.flatMap((handle) =>
          Effect.tryPromise({
            try: async () => {
              const held = await handle.stat()
              assertVerifiedHandle(verified, { deviceId: held.dev, inode: held.ino })
              return verified
            },
            catch: (cause: unknown) =>
              cause instanceof WorkspaceError
                ? cause
                : rejectWorkspace(`workspace handle could not be confirmed: ${verified.path}`),
          }),
        ),
      ),
    ),
    // With the correct inode pinned, confirm the path still resolves to it.
    Effect.tap((verified) => assertWorkspaceIdentity(root, verified)),
  )
