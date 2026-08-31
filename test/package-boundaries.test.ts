import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

/**
 * The workspace's dependency direction, as the manifests must declare it (#109).
 *
 * This is the half of the boundary that `.oxlintrc.json` cannot state: a lint rule denies an
 * import, while a manifest decides what a package can resolve at all. `packages/core` names no
 * adapter package, so a published or independently installed core has no adapter to reach for, and
 * the two provider adapters name each other nowhere.
 *
 * It is asserted rather than assumed because pnpm installs the composition root's own dependencies
 * at the repository root, and Node's directory walk reaches them from inside every package here.
 * Adding an adapter to `packages/core/package.json` would therefore start resolving quietly; this
 * fails instead, beside the lint rule that denies the import itself.
 */
const permittedWorkspaceDependencies: Readonly<Record<string, readonly string[]>> = {
  '@symphony/core': [],
  '@symphony/adapter-node': ['@symphony/core'],
  '@symphony/adapter-github': ['@symphony/adapter-node', '@symphony/core'],
  '@symphony/adapter-codex': ['@symphony/adapter-node', '@symphony/core'],
}

type Manifest = Readonly<{
  name: string
  private: boolean
  dependencies?: Readonly<Record<string, string>>
  devDependencies?: Readonly<Record<string, string>>
  version?: string
}>

const readManifest = (directory: string): Manifest => {
  const parsed: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${directory}/package.json is not an object`)
  }
  return parsed as Manifest
}

const packageDirectories = readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const manifests = new Map(
  packageDirectories.map((directory) => {
    const manifest = readManifest(join(repoRoot, 'packages', directory))
    return [manifest.name, manifest] as const
  }),
)

const workspaceDependenciesOf = (manifest: Manifest): readonly string[] =>
  Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => name.startsWith('@symphony/'))
    .sort()

describe('workspace package dependency direction', () => {
  it('declares exactly the packages the structure calls for', () => {
    expect([...manifests.keys()].sort()).toStrictEqual(
      Object.keys(permittedWorkspaceDependencies).sort(),
    )
  })

  it.each([...manifests.keys()].sort())('%s depends only on the packages beneath it', (name) => {
    const manifest = manifests.get(name)
    expect(manifest).toBeDefined()
    expect(workspaceDependenciesOf(manifest as Manifest)).toStrictEqual(
      [...(permittedWorkspaceDependencies[name] ?? [])].sort(),
    )
  })

  it.each([...manifests.keys()].sort())('%s stays private and unversioned as a product', (name) => {
    const manifest = manifests.get(name) as Manifest
    expect(manifest.private).toBe(true)
  })

  it('keeps the composition root at the repository root', () => {
    const root = readManifest(repoRoot)
    expect(root.name).toBe('symphony-ts')
    expect(root.private).toBe(true)
    expect(workspaceDependenciesOf(root)).toStrictEqual([...manifests.keys()].sort())
  })
})
