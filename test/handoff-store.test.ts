import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Logger } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { loadHandoffs, saveHandoffs } from '../src/handoff-store.js'
import type { HandoffSnapshot } from '../src/handoff.js'

const directories: string[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('handoff persistence', (): void => {
  it('atomically round-trips versionable handoff snapshots', async (): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'symphony-handoff-'))
    directories.push(directory)
    const path = join(directory, 'state', 'handoffs.json')
    const snapshot: HandoffSnapshot = {
      issueId: '41',
      identifier: 'example/symphony#41',
      pullRequestUrl: 'https://github.com/example/symphony/pull/42',
      branchName: 'symphony/issue-41',
      state: 'awaiting_checks',
      headSha: 'abc',
      reason: null,
      repairAttempts: 0,
      observedAt: '2026-08-29T00:00:00.000Z',
    }

    await Effect.runPromise(saveHandoffs(path, [snapshot]))

    await expect(Effect.runPromise(loadHandoffs(path))).resolves.toEqual([snapshot])
    expect(await readFile(path, 'utf8')).toContain('"version": 1')
  })

  it('treats missing or malformed state as an empty recovery set', async (): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'symphony-handoff-'))
    directories.push(directory)
    await expect(Effect.runPromise(loadHandoffs(join(directory, 'missing.json')))).resolves.toEqual(
      [],
    )
  })

  it('logs a failing write instead of silently discarding it', async (): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'symphony-handoff-'))
    directories.push(directory)
    const path = join(directory, 'handoffs.json')
    await mkdir(`${path}.tmp`)
    const logs: string[] = []
    const logger = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message }: Readonly<{ message: unknown }>) => {
        logs.push(JSON.stringify(message))
      }),
    )

    await expect(
      Effect.runPromise(saveHandoffs(path, []).pipe(Effect.provide(logger))),
    ).resolves.toBeUndefined()
    expect(logs).toContainEqual(expect.stringContaining('handoff persistence save failed'))
    expect(logs).toContainEqual(expect.stringContaining('handoff_save'))
    expect(logs).toContainEqual(expect.stringContaining(path))
    expect(logs).toContainEqual(expect.stringContaining('EISDIR'))
  })
})
