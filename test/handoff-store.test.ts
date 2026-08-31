import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { loadHandoffs, saveHandoffs } from '../src/handoff-store.js'
import type { HandoffSnapshot } from '../src/domain/handoff.js'
import { hostFileSystem } from './harness/filesystem.js'

/** The store reads and writes through `FileSystem`; these tests exercise it against real files. */
const onHost = <Value, Error>(
  effect: Effect.Effect<Value, Error, FileSystem.FileSystem>,
): Effect.Effect<Value, Error> => Effect.provide(effect, hostFileSystem)

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
      repairHeadShas: ['abc'],
      repairObservedHeadShas: ['abc'],
      repairStartedHeadSha: null,
      reviewRequestedHeadSha: 'abc',
      reviewCompletedHeadSha: null,
      observedAt: '2026-08-29T00:00:00.000Z',
    }

    await Effect.runPromise(onHost(saveHandoffs(path, [snapshot])))

    await expect(Effect.runPromise(onHost(loadHandoffs(path)))).resolves.toEqual([snapshot])
    expect(await readFile(path, 'utf8')).toContain('"version": 1')
  })

  it('treats missing state as an empty recovery set', async (): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'symphony-handoff-'))
    directories.push(directory)
    await expect(
      Effect.runPromise(onHost(loadHandoffs(join(directory, 'missing.json')))),
    ).resolves.toEqual([])
  })

  it('surfaces a failing write instead of silently discarding it', async (): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'symphony-handoff-'))
    directories.push(directory)
    const path = join(directory, 'handoffs.json')
    await mkdir(`${path}.tmp`)

    const result = await Effect.runPromise(Effect.either(onHost(saveHandoffs(path, []))))
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.operation).toBe('write')
      expect(result.left.message).toContain(`Could not write handoff store ${path}`)
    }
  })

  it.each([
    ['unparseable JSON', '{'],
    ['a wrong envelope', '{}'],
    ['an unsupported version', '{"version":2,"handoffs":[]}'],
    ['a malformed entry', '{"version":1,"handoffs":[null]}'],
    [
      'an invalid observation date',
      '{"version":1,"handoffs":[{"issueId":"41","identifier":"example/symphony#41","pullRequestUrl":"https://github.com/example/symphony/pull/42","branchName":"symphony/issue-41","state":"awaiting_checks","headSha":null,"reason":null,"repairAttempts":0,"observedAt":"not-a-date"}]}',
    ],
  ])('surfaces %s as a decode failure', async (_case, contents): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'symphony-handoff-'))
    directories.push(directory)
    const path = join(directory, 'handoffs.json')
    await writeFile(path, contents)

    const result = await Effect.runPromise(Effect.either(onHost(loadHandoffs(path))))
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.operation).toBe('read')
      expect(result.left.message).toContain(`Could not decode handoff store ${path}`)
    }
  })
})
