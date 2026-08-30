import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { codexApprovalPolicies, codexSandboxModes } from '../src/config/workflow.js'

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

/** The schema of the installed Codex. Every failure propagates. */
const codexSchema = async (): Promise<string> => {
  const help = await execFileAsync('codex', [...schemaArguments, '--help'], bufferLimit)
  if (!help.stdout.includes('--out')) {
    const { stdout } = await execFileAsync('codex', [...schemaArguments], bufferLimit)
    return stdout
  }
  const directory = await mkdtemp(join(tmpdir(), 'symphony-codex-schema-'))
  roots.push(directory)
  await execFileAsync('codex', [...schemaArguments, '--out', directory], bufferLimit)
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  const contents = await Promise.all(
    files.map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
  )
  return contents.join('\n')
}

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
})
