import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { codexApprovalPolicies, codexSandboxModes } from '@sloppenheimer/adapter-codex/settings.js'

const execFileAsync = promisify(execFile)
const schemaArguments = ['app-server', 'generate-json-schema'] as const
const bufferLimit = { maxBuffer: 64 * 1024 * 1024 } as const
const roots: string[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

/**
 * Whether a `codex` executable is on PATH. Only a missing executable is a skip: any other failure —
 * a rejected invocation above all — must fail the test rather than be swallowed into a silent pass
 * that checks nothing, so anything but `ENOENT` leaves the check enabled.
 */
const codexIsInstalled = ((): boolean => {
  const probe = spawnSync('codex', ['--version'], { stdio: 'ignore', timeout: 30_000 })
  const error: NodeJS.ErrnoException | undefined = probe.error
  return error?.code !== 'ENOENT'
})()

/** The schema of the installed Codex, one string per generated document. Every failure propagates. */
const codexSchemaDocuments = async (): Promise<readonly string[]> => {
  const help = await execFileAsync('codex', [...schemaArguments, '--help'], bufferLimit)
  if (!help.stdout.includes('--out')) {
    const { stdout } = await execFileAsync('codex', [...schemaArguments], bufferLimit)
    return [stdout]
  }
  const directory = await mkdtemp(join(tmpdir(), 'sloppenheimer-codex-schema-'))
  roots.push(directory)
  await execFileAsync('codex', [...schemaArguments, '--out', directory], bufferLimit)
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  return await Promise.all(
    files.map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
  )
}

const codexSchema = async (): Promise<string> => (await codexSchemaDocuments()).join('\n')

const isSchemaObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Every property a named request schema declares, gathered from wherever the generator put it: a
 * document per type, whose own `title` names it, or a bundle carrying every type under
 * `definitions`. Both forms are read, so the answer does not depend on which layout Codex emits.
 */
const declaredProperties = (documents: readonly string[], name: string): readonly string[] => {
  const declared = new Set<string>()
  for (const document of documents) {
    const parsed: unknown = JSON.parse(document)
    if (!isSchemaObject(parsed)) {
      continue
    }
    const definitions = parsed['definitions']
    const candidates: readonly unknown[] = [
      parsed['title'] === name ? parsed : null,
      isSchemaObject(definitions) ? definitions[name] : null,
    ]
    for (const candidate of candidates) {
      if (!isSchemaObject(candidate) || !isSchemaObject(candidate['properties'])) {
        continue
      }
      for (const property of Object.keys(candidate['properties'])) {
        declared.add(property)
      }
    }
  }
  return [...declared]
}

/** Field names a protocol would plausibly use for a human-readable thread or turn title. */
const titleFields = ['title', 'name', 'label', 'displayName', 'threadTitle', 'turnTitle'] as const

// SPEC 17.8: a check that cannot run is reported as skipped, never as a silent pass.
const installedCodex = codexIsInstalled ? it : it.skip

describe('installed Codex App Server schema', (): void => {
  if (!codexIsInstalled) {
    it.skip('codex executable unavailable: install Codex to run this check', (): void => {})
  }

  installedCodex(
    'declares every method and policy value this client sends',
    async (): Promise<void> => {
      const schema = await codexSchema()

      expect(schema.length).toBeGreaterThan(0)
      for (const method of [
        'initialize',
        'thread/start',
        'turn/start',
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
        'item/tool/requestUserInput',
      ]) {
        expect(schema).toContain(method)
      }
      expect(schema).toContain('GrantedPermissionProfile')
      expect(schema).toContain('PermissionGrantScope')
      for (const policy of codexApprovalPolicies) {
        expect(schema).toContain(`"${policy}"`)
      }
      for (const mode of codexSandboxModes) {
        expect(schema).toContain(`"${mode}"`)
      }
      expect(schema).toContain('experimentalApi')
    },
    60_000,
  )

  installedCodex(
    'still offers no thread or turn title for issue-identifying metadata',
    async (): Promise<void> => {
      const documents = await codexSchemaDocuments()
      const threadStart = declaredProperties(documents, 'ThreadStartParams')
      const turnStart = declaredProperties(documents, 'TurnStartParams')

      // Reading nothing would pass every assertion below, so prove the schemas were found first.
      expect(threadStart).toContain('cwd')
      expect(turnStart).toContain('threadId')
      // SPEC 10.2 asks for issue-identifying metadata "when the targeted protocol supports turn or
      // session titles". It does not: neither request accepts one, and the `name` a thread reads
      // back with is server-derived with no method to set it. Conformance matrix 17.5 records the
      // deviation; this check fails the moment a field or method appears to carry it, which is the
      // signal to send `<issue.identifier>: <issue.title>` and drop the deviation.
      for (const field of titleFields) {
        expect(threadStart).not.toContain(field)
        expect(turnStart).not.toContain(field)
      }
      const schema = documents.join('\n')
      for (const method of [
        'thread/rename',
        'thread/setTitle',
        'thread/setName',
        'thread/update',
      ]) {
        expect(schema).not.toContain(method)
      }
    },
    60_000,
  )
})
