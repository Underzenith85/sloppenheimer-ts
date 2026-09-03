import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileSystem } from '@effect/platform'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { loadHandoffs, saveHandoffs } from '@sloppenheimer/core/core/handoff-store.js'
import {
  handoffStates,
  type HandoffSnapshot,
  type HandoffState,
} from '@sloppenheimer/core/domain/handoff.js'
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

  /**
   * A snapshot carrying every optional field the runtime writes. Each state is round-tripped with
   * it, so a state or a field the schema forgets fails here rather than on the next start.
   */
  const fullSnapshot = (state: HandoffState): HandoffSnapshot => ({
    issueId: '41',
    identifier: 'example/sloppenheimer#41',
    pullRequestUrl: 'https://github.com/example/sloppenheimer/pull/42',
    branchName: 'sloppenheimer/issue-41',
    state,
    headSha: 'abc',
    reason: 'Failed CI checks: quality',
    repairAttempts: 1,
    repairHeadShas: ['abc'],
    repairObservedHeadShas: ['aaa', 'abc'],
    repairStartedHeadSha: 'aaa',
    repairWorkerStarted: true,
    repairPublication: 'delivery_failed',
    repairPublishedHeadSha: 'abd',
    reviewRequestedHeadSha: 'abc',
    reviewCompletedHeadSha: 'abc',
    observedAt: '2026-08-29T00:00:00.000Z',
  })

  it.effect.each(handoffStates.map((state) => [state] as const))(
    'round-trips a %s handoff with every optional field',
    ([state]) =>
      Effect.gen(function* () {
        const directory = yield* makeDirectory()
        const path = join(directory, 'handoffs.json')
        const snapshot = fullSnapshot(state)

        yield* onHost(saveHandoffs(path, [snapshot]))

        expect(yield* onHost(loadHandoffs(path))).toStrictEqual([snapshot])
      }),
  )

  it.effect('reads a snapshot written before the optional fields existed as lacking them', () =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory()
      const path = join(directory, 'handoffs.json')
      const snapshot: HandoffSnapshot = {
        issueId: '41',
        identifier: 'example/sloppenheimer#41',
        pullRequestUrl: 'https://github.com/example/sloppenheimer/pull/42',
        branchName: 'sloppenheimer/issue-41',
        state: 'repair_needed',
        headSha: null,
        reason: null,
        repairAttempts: 0,
        observedAt: '2026-08-29T00:00:00.000Z',
      }

      yield* onHost(saveHandoffs(path, [snapshot]))

      expect(yield* onHost(loadHandoffs(path))).toStrictEqual([snapshot])
    }),
  )

  it.effect('reads back the store a failed delivery leaves behind', () =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory()
      const path = join(directory, 'handoffs.json')
      yield* Effect.promise(() =>
        writeFile(
          path,
          '{"version":1,"handoffs":[{"issueId":"41","identifier":"example/sloppenheimer#41","pullRequestUrl":"https://github.com/example/sloppenheimer/pull/42","branchName":"sloppenheimer/issue-41","state":"delivery_failed","headSha":"abc","reason":"The changes have not reached the pull request","repairAttempts":0,"repairHeadShas":[],"repairObservedHeadShas":["abc"],"repairStartedHeadSha":"abc","repairWorkerStarted":true,"repairPublication":"delivery_failed","repairPublishedHeadSha":null,"reviewRequestedHeadSha":null,"reviewCompletedHeadSha":null,"observedAt":"2026-08-29T00:00:00.000Z"}]}',
        ),
      )

      const [restored] = yield* onHost(loadHandoffs(path))

      expect(restored).toMatchObject({
        state: 'delivery_failed',
        repairPublication: 'delivery_failed',
        repairPublishedHeadSha: null,
      })
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
      'an unknown state',
      '{"version":1,"handoffs":[{"issueId":"41","identifier":"example/sloppenheimer#41","pullRequestUrl":"https://github.com/example/sloppenheimer/pull/42","branchName":"sloppenheimer/issue-41","state":"delivering","headSha":null,"reason":null,"repairAttempts":0,"observedAt":"2026-08-29T00:00:00.000Z"}]}',
    ],
    [
      'an unknown repair publication',
      '{"version":1,"handoffs":[{"issueId":"41","identifier":"example/sloppenheimer#41","pullRequestUrl":"https://github.com/example/sloppenheimer/pull/42","branchName":"sloppenheimer/issue-41","state":"repair_needed","headSha":null,"reason":null,"repairAttempts":0,"repairPublication":"lost","observedAt":"2026-08-29T00:00:00.000Z"}]}',
    ],
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
