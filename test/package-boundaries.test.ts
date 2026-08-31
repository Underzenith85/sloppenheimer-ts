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

/**
 * The package specifiers a package's sources import, as npm names.
 *
 * A scoped name carries two segments, and a deep import contributes only the name: `NodeStream`
 * reached through `@effect/platform-node/NodeStream` is still a dependency on
 * `@effect/platform-node`. Relative specifiers stay inside the package and Node builtins need no
 * declaration, so neither is a dependency.
 */
const importedPackagesOf = (directory: string): ReadonlySet<string> => {
  const imported = new Set<string>()
  const sources = readdirSync(join(directory, 'src'), { recursive: true, withFileTypes: true })
  for (const entry of sources) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue
    }
    const contents = readFileSync(join(entry.parentPath, entry.name), 'utf8')
    for (const [, specifier] of contents.matchAll(/from '([^']+)'/gu)) {
      if (specifier === undefined || specifier.startsWith('.') || specifier.startsWith('node:')) {
        continue
      }
      const segments = specifier.split('/')
      const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
      if (name !== undefined) {
        imported.add(name)
      }
    }
  }
  return imported
}

const packageDirectories = readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const manifests = new Map(
  packageDirectories.map((directory) => {
    const path = join(repoRoot, 'packages', directory)
    return [readManifest(path).name, { manifest: readManifest(path), path }] as const
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
    const entry = manifests.get(name)
    expect(entry).toBeDefined()
    expect(workspaceDependenciesOf((entry as { manifest: Manifest }).manifest)).toStrictEqual(
      [...(permittedWorkspaceDependencies[name] ?? [])].sort(),
    )
  })

  it.each([...manifests.keys()].sort())('%s stays private and unversioned as a product', (name) => {
    expect((manifests.get(name) as { manifest: Manifest }).manifest.private).toBe(true)
  })

  it('keeps the composition root at the repository root', () => {
    const root = readManifest(repoRoot)
    expect(root.name).toBe('symphony-ts')
    expect(root.private).toBe(true)
    expect(workspaceDependenciesOf(root)).toStrictEqual([...manifests.keys()].sort())
  })

  /*
   * Every package a source imports must be declared by the package that imports it. pnpm installs
   * the composition root's dependencies at the repository root, and Node's directory walk reaches
   * them from inside every package here, so an undeclared import resolves anyway — until the
   * workspace is installed with a filter that excludes the root, and then it does not. That makes
   * a package's build depend on the install layout rather than on its own manifest, which is
   * exactly what these manifests exist to state.
   */
  it.each([...manifests.keys()].sort())('%s declares every package it imports', (name) => {
    const entry = manifests.get(name) as { manifest: Manifest; path: string }
    const declared = new Set([
      ...Object.keys(entry.manifest.dependencies ?? {}),
      ...Object.keys(entry.manifest.devDependencies ?? {}),
    ])
    const undeclared = [...importedPackagesOf(entry.path)]
      .filter((imported) => !declared.has(imported))
      .sort()
    expect(undeclared).toStrictEqual([])
  })
})
