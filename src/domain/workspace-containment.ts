import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Either, Option } from 'effect'

import { WorkspaceError } from '../errors.js'
import type { IssueIdentifier, Workspace } from './domain.js'

/**
 * Workspace containment policy: the rules that decide whether a path may be treated as an issue
 * workspace, and every rejection they produce.
 *
 * The module imports neither `node:fs` nor `node:child_process` by design. Asking the filesystem
 * what a path resolves to, and what inode it holds, belongs to the adapter; comparing the answers
 * belongs here, so the rules that stop an issue identifier escaping the configured workspace root
 * can be exercised exhaustively without a filesystem.
 *
 * Every rule returns its rejection rather than throwing it. A rule that produces a path returns
 * `Either`, and a rule that only decides returns `Option` of the rejection — `none` for a pass — so
 * a caller inside `Effect.gen` puts the rejection in the error channel instead of recovering it
 * from the defect channel, and the compiler requires it to be handled.
 */

export const rejectWorkspace = (message: string): WorkspaceError =>
  new WorkspaceError({ category: 'invalid_path', message })

export const workspaceKey = (identifier: IssueIdentifier): string => {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/gu, '_')
  if (sanitized === identifier) {
    return sanitized
  }
  const suffix = createHash('sha256').update(identifier).digest('hex').slice(0, 16)
  return `${sanitized}-${suffix}`
}

/**
 * The directory inside the root that holds workspaces which have been retired but not yet deleted.
 *
 * The name is reserved by construction rather than by an exclusion rule: `workspaceKey` replaces
 * every character outside `[A-Za-z0-9._-]`, so no key can contain an `@` and no issue identifier,
 * however hostile, can be sanitized into this name. A rule that instead excluded a spellable name
 * such as `.trash` would have to be kept in step with the sanitizer forever.
 */
export const trashDirectoryName = '@trash'

export const isStrictDescendant = (root: string, candidate: string): boolean => {
  const difference = relative(root, candidate)
  return (
    difference !== '' &&
    !isAbsolute(difference) &&
    difference !== '..' &&
    !difference.startsWith(`..${sep}`)
  )
}

export const containedWorkspacePath = (
  root: string,
  key: string,
): Either.Either<string, WorkspaceError> => {
  const normalizedRoot = resolve(root)
  const candidate = resolve(normalizedRoot, key)
  if (!isStrictDescendant(normalizedRoot, candidate)) {
    return Either.left(rejectWorkspace(`workspace path escapes or equals root: ${candidate}`))
  }
  return Either.right(candidate)
}

export const containedTrashRoot = (root: string): Either.Either<string, WorkspaceError> =>
  containedWorkspacePath(root, trashDirectoryName)

/**
 * Where a workspace goes when it is retired, so that its canonical path is free for reuse before
 * anything is deleted.
 *
 * `unique` separates successive removals of one key, and separates both from an entry stranded by
 * an earlier crash; the caller supplies it so this stays a function of its inputs. It is appended
 * to the key rather than replacing it, because an operator looking in the trash root should be able
 * to tell which workspace an entry came from.
 *
 * The entry is contained against the trash root by the same rule that contains a workspace against
 * the workspace root, so a key that would escape is rejected here too.
 */
export const containedTrashEntryPath = (
  root: string,
  key: string,
  unique: string,
): Either.Either<string, WorkspaceError> =>
  Either.flatMap(containedTrashRoot(root), (trashRoot) =>
    containedWorkspacePath(trashRoot, `${key}-${unique}`),
  )

/**
 * The identity of a verified workspace directory. The path alone is not enough: a path string is
 * re-resolved by the kernel at every consumer, so the directory that a later consumer enters is
 * only known to be the verified one if its filesystem identity still matches.
 */
export type VerifiedWorkspace = Readonly<{
  /** The canonical path of the verified directory. */
  path: string
  /** The canonical path of the configured root it was verified against. */
  rootPath: string
  deviceId: number
  inode: number
}>

/** What a filesystem probe reports about a directory, reduced to the values the rules compare. */
export type DirectoryIdentity = Readonly<{
  deviceId: number
  inode: number
}>

/**
 * The precondition of launch verification, checked before the declared path is handed to the
 * filesystem at all. Returns the normalized root and declared path the probes then run against.
 */
export const declaredWorkspacePath = (
  root: string,
  workspace: Workspace,
): Either.Either<Readonly<{ normalizedRoot: string; declaredPath: string }>, WorkspaceError> => {
  const normalizedRoot = resolve(root)
  const declaredPath = resolve(workspace.path)
  if (!isStrictDescendant(normalizedRoot, declaredPath)) {
    return Either.left(
      rejectWorkspace(
        `workspace path is not a strict descendant of the configured root: ${declaredPath}`,
      ),
    )
  }
  return Either.right({ normalizedRoot, declaredPath })
}

/**
 * The declared path being contained is not enough: the kernel follows links, so what the path
 * actually resolves to must descend from the canonical root as well.
 */
export const resolvedWithinRootRejection = (
  rootPath: string,
  resolvedPath: string,
): Option.Option<WorkspaceError> => {
  if (!isStrictDescendant(rootPath, resolvedPath)) {
    return Option.some(
      rejectWorkspace(`resolved workspace path escapes the configured root: ${resolvedPath}`),
    )
  }
  return Option.none()
}

/**
 * Re-checks a verified workspace against the root as it canonically resolves now. A configured
 * root that moved, or a verified path that no longer descends from it, is rejected rather than
 * re-derived.
 */
export const verifiedRootRejection = (
  verified: VerifiedWorkspace,
  rootPath: string,
): Option.Option<WorkspaceError> => {
  if (rootPath !== verified.rootPath) {
    return Option.some(
      rejectWorkspace(`configured workspace root changed since verification: ${verified.rootPath}`),
    )
  }
  if (!isStrictDescendant(rootPath, verified.path)) {
    return Option.some(
      rejectWorkspace(`verified workspace path no longer descends from the root: ${verified.path}`),
    )
  }
  return Option.none()
}

export const sameDirectoryIdentity = (
  verified: VerifiedWorkspace,
  identity: DirectoryIdentity,
): boolean => identity.deviceId === verified.deviceId && identity.inode === verified.inode

/**
 * The rebinding rule: the verified path must still be its own canonical form and must still hold
 * the device and inode captured at verification, so a directory renamed and replaced in between is
 * rejected instead of followed.
 */
export const verifiedDirectoryRejection = (
  verified: VerifiedWorkspace,
  resolvedPath: string,
  identity: DirectoryIdentity,
): Option.Option<WorkspaceError> => {
  if (resolvedPath !== verified.path || !sameDirectoryIdentity(verified, identity)) {
    return Option.some(
      rejectWorkspace(`workspace directory identity changed since verification: ${verified.path}`),
    )
  }
  return Option.none()
}

/**
 * Opening a directory resolves a path, so the handle itself is checked: only if it refers to the
 * verified inode does holding it actually keep that inode allocated.
 */
export const verifiedHandleRejection = (
  verified: VerifiedWorkspace,
  identity: DirectoryIdentity,
): Option.Option<WorkspaceError> => {
  if (!sameDirectoryIdentity(verified, identity)) {
    return Option.some(
      rejectWorkspace(
        `workspace handle does not refer to the verified directory: ${verified.path}`,
      ),
    )
  }
  return Option.none()
}
