import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileSystem } from '@effect/platform'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { loadHandoffs, saveHandoffs } from '@sloppenheimer/core/core/handoff-store.js'
import type { HandoffSnapshot } from '@sloppenheimer/core/domain/handoff.js'
import { hostFileSystem } from './harness/filesystem.js'

/** The store reads and writes through `FileSystem`; these tests exercise it against real files. */
const onHost = <Value, Error>(
  effect: Effect.Effect<Value, Error, FileSystem.FileSystem>,
): Effect.Effect<Value, Error> => Effect.provide(effect, hostFileSystem)

const directories: string[] = []

/** A fresh store directory, registered for cleanup, as an effect the tests can sequence. */
const makeDirectory = (): Effect.Effect<string> =>
  Effect.promise(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppenheimer-handoff-'))
    directories.push(directory)
    return directory
  })

afterEach(async (): Promise<void> => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('handoff persistence', (): void => {
  it.effect('atomically round-trips versionable handoff snapshots', () =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory()
      const path = join(directory, 'state', 'handoffs.json')
      const snapshot: HandoffSnapshot = {
        issueId: '41',
        identifier: 'example/sloppenheimer#41',
        pullRequestUrl: 'https://github.com/example/sloppenheimer/pull/42',
        branchName: 'sloppenheimer/issue-41',
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

      yield* onHost(saveHandoffs(path, [snapshot]))

      expect(yield* onHost(loadHandoffs(path))).toEqual([snapshot])
      expect(yield* Effect.promise(() => readFile(path, 'utf8'))).toContain('"version": 1')
    }),
  )

  it.effect('treats missing state as an empty recovery set', () =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory()

      expect(yield* onHost(loadHandoffs(join(directory, 'missing.json')))).toEqual([])
    }),
  )

  it.effect('surfaces a failing write instead of silently discarding it', () =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory()
      const path = join(directory, 'handoffs.json')
      yield* Effect.promise(() => mkdir(`${path}.tmp`))

      const failure = yield* Effect.flip(onHost(saveHandoffs(path, [])))

      expect(failure.operation).toBe('write')
      expect(failure.message).toContain(`Could not write handoff store ${path}`)
    }),
  )

  it.effect.each([
    ['unparseable JSON', '{'],
    ['a wrong envelope', '{}'],
    ['an unsupported version', '{"version":2,"handoffs":[]}'],
    ['a malformed entry', '{"version":1,"handoffs":[null]}'],
    [
      'an invalid observation date',
      '{"version":1,"handoffs":[{"issueId":"41","identifier":"example/sloppenheimer#41","pullRequestUrl":"https://github.com/example/sloppenheimer/pull/42","branchName":"sloppenheimer/issue-41","state":"awaiting_checks","headSha":null,"reason":null,"repairAttempts":0,"observedAt":"not-a-date"}]}',
    ],
  ] as const)('surfaces %s as a decode failure', ([, contents]) =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory()
      const path = join(directory, 'handoffs.json')
      yield* Effect.promise(() => writeFile(path, contents))

      const failure = yield* Effect.flip(onHost(loadHandoffs(path)))

      expect(failure.operation).toBe('read')
      expect(failure.message).toContain(`Could not decode handoff store ${path}`)
    }),
  )
})
