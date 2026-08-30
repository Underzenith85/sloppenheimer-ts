import { describe, expect, it } from 'vitest'

import { issueIdentifier, type Workspace } from '../../src/domain/domain.js'
import {
  assertResolvedWithinRoot,
  assertVerifiedDirectory,
  assertVerifiedHandle,
  assertVerifiedRoot,
  containedWorkspacePath,
  declaredWorkspacePath,
  isStrictDescendant,
  sameDirectoryIdentity,
  workspaceKey,
  type VerifiedWorkspace,
} from '../../src/domain/workspace-containment.js'
import { WorkspaceError } from '../../src/errors.js'

/**
 * The containment rules are what stop an issue identifier escaping the configured workspace root,
 * so they are exercised here exhaustively and without a filesystem. Every case below is decided by
 * path reasoning alone; the `lstat` and `realpath` calls that feed these rules are covered by the
 * workspace and Codex suites.
 */

const root = '/srv/symphony/workspaces'

const workspaceAt = (path: string): Workspace => ({ path, key: 'key', createdNow: false })

const verified: VerifiedWorkspace = {
  path: `${root}/issue-13`,
  rootPath: root,
  deviceId: 66,
  inode: 4242,
}

const rejection = (act: () => unknown): WorkspaceError => {
  let caught: unknown
  try {
    act()
  } catch (cause: unknown) {
    caught = cause
  }
  expect(caught).toBeInstanceOf(WorkspaceError)
  const error = caught as WorkspaceError
  expect(error.category).toBe('invalid_path')
  return error
}

describe('workspace keys', (): void => {
  it('passes through an already safe identifier', (): void => {
    expect(workspaceKey(issueIdentifier('GH-7'))).toBe('GH-7')
    expect(workspaceKey(issueIdentifier('a.b_c-1'))).toBe('a.b_c-1')
  })

  it('replaces every unsafe character and appends a digest of the original', (): void => {
    expect(workspaceKey(issueIdentifier('owner/repo#7'))).toMatch(/^owner_repo_7-[a-f0-9]{16}$/u)
    expect(workspaceKey(issueIdentifier('../../etc/passwd'))).toMatch(
      /^\.\._\.\._etc_passwd-[a-f0-9]{16}$/u,
    )
  })

  it('is deterministic and distinguishes identifiers that sanitize alike', (): void => {
    const identifier = issueIdentifier('owner/repo#7')
    expect(workspaceKey(identifier)).toBe(workspaceKey(identifier))
    expect(workspaceKey(identifier)).not.toBe(workspaceKey(issueIdentifier('owner_repo#7')))
    expect(workspaceKey(identifier)).not.toBe(workspaceKey(issueIdentifier('owner:repo#7')))
  })

  it('keeps a hostile identifier inside the root once it has been sanitized', (): void => {
    for (const identifier of ['../..', '/etc/passwd', '../../escape', '~/elsewhere', 'a/../..']) {
      const path = containedWorkspacePath(root, workspaceKey(issueIdentifier(identifier)))
      expect(isStrictDescendant(root, path)).toBe(true)
    }
  })

  it('leaves a bare traversal for the containment check to reject', (): void => {
    // `.` and `..` are made entirely of characters the key sanitizer keeps, so they survive it
    // unchanged.  Sanitization is not what contains them; `containedWorkspacePath` is.
    expect(workspaceKey(issueIdentifier('..'))).toBe('..')
    expect(workspaceKey(issueIdentifier('.'))).toBe('.')
    for (const identifier of ['..', '.']) {
      rejection(() => containedWorkspacePath(root, workspaceKey(issueIdentifier(identifier))))
    }
  })
})

describe('workspace path containment', (): void => {
  it('accepts a key that resolves to a directory inside the root', (): void => {
    expect(containedWorkspacePath(root, 'GH-7')).toBe(`${root}/GH-7`)
    expect(containedWorkspacePath('/srv/symphony/../symphony/workspaces', 'GH-7')).toBe(
      `${root}/GH-7`,
    )
  })

  it('rejects a key that escapes or equals the root', (): void => {
    for (const key of ['..', '.', '', './', '../sibling', 'nested/../..', '/etc/passwd']) {
      const error = rejection(() => containedWorkspacePath(root, key))
      expect(error.message).toMatch(/^workspace path escapes or equals root: /u)
    }
  })

  it('treats a nested key as contained', (): void => {
    expect(containedWorkspacePath(root, 'a/b')).toBe(`${root}/a/b`)
  })
})

describe('strict descendancy', (): void => {
  it('is false for the root itself, a parent, and a sibling', (): void => {
    expect(isStrictDescendant(root, root)).toBe(false)
    expect(isStrictDescendant(root, '/srv/symphony')).toBe(false)
    expect(isStrictDescendant(root, '/srv/symphony/other')).toBe(false)
    expect(isStrictDescendant(root, `${root}-suffix`)).toBe(false)
  })

  it('is true for a child at any depth', (): void => {
    expect(isStrictDescendant(root, `${root}/GH-7`)).toBe(true)
    expect(isStrictDescendant(root, `${root}/GH-7/nested/deep`)).toBe(true)
  })
})

describe('launch verification path reasoning', (): void => {
  it('normalizes the root and the declared path before any probe', (): void => {
    expect(
      declaredWorkspacePath('/srv/symphony/../symphony/workspaces', workspaceAt(`${root}/GH-7`)),
    ).toEqual({ normalizedRoot: root, declaredPath: `${root}/GH-7` })
  })

  it('rejects a declared path that is not a strict descendant of the root', (): void => {
    for (const path of [root, '/srv/symphony', '/elsewhere/GH-7', `${root}/../escape`]) {
      const error = rejection(() => declaredWorkspacePath(root, workspaceAt(path)))
      expect(error.message).toMatch(
        /^workspace path is not a strict descendant of the configured root: /u,
      )
    }
  })

  it('rejects a resolved path that leaves the canonical root', (): void => {
    expect(() => {
      assertResolvedWithinRoot(root, `${root}/GH-7`)
    }).not.toThrow()
    const error = rejection(() => {
      assertResolvedWithinRoot(root, '/elsewhere/GH-7')
    })
    expect(error.message).toBe(
      'resolved workspace path escapes the configured root: /elsewhere/GH-7',
    )
  })
})

describe('identity rebinding rules', (): void => {
  it('accepts the root and path captured at verification', (): void => {
    expect(() => {
      assertVerifiedRoot(verified, root)
    }).not.toThrow()
  })

  it('rejects a root that canonically resolves elsewhere now', (): void => {
    const error = rejection(() => {
      assertVerifiedRoot(verified, '/srv/symphony/moved')
    })
    expect(error.message).toBe(`configured workspace root changed since verification: ${root}`)
  })

  it('rejects a verified path that no longer descends from the root', (): void => {
    const escaped: VerifiedWorkspace = { ...verified, path: '/elsewhere/issue-13', rootPath: root }
    const error = rejection(() => {
      assertVerifiedRoot(escaped, root)
    })
    expect(error.message).toBe(
      'verified workspace path no longer descends from the root: /elsewhere/issue-13',
    )
  })

  it('requires the path, device, and inode to all still match', (): void => {
    const identity = { deviceId: verified.deviceId, inode: verified.inode }
    expect(() => {
      assertVerifiedDirectory(verified, verified.path, identity)
    }).not.toThrow()

    for (const [path, current] of [
      [`${root}/issue-13-renamed`, identity],
      [verified.path, { deviceId: 67, inode: verified.inode }],
      [verified.path, { deviceId: verified.deviceId, inode: 4243 }],
    ] as const) {
      const error = rejection(() => {
        assertVerifiedDirectory(verified, path, current)
      })
      expect(error.message).toBe(
        `workspace directory identity changed since verification: ${verified.path}`,
      )
    }
  })

  it('compares an open handle by device and inode only', (): void => {
    expect(sameDirectoryIdentity(verified, { deviceId: 66, inode: 4242 })).toBe(true)
    expect(sameDirectoryIdentity(verified, { deviceId: 66, inode: 4243 })).toBe(false)
    expect(sameDirectoryIdentity(verified, { deviceId: 67, inode: 4242 })).toBe(false)

    expect(() => {
      assertVerifiedHandle(verified, { deviceId: 66, inode: 4242 })
    }).not.toThrow()
    const error = rejection(() => {
      assertVerifiedHandle(verified, { deviceId: 66, inode: 4243 })
    })
    expect(error.message).toBe(
      `workspace handle does not refer to the verified directory: ${verified.path}`,
    )
  })
})
