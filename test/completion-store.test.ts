import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileSystem } from '@effect/platform'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterEach, describe, expect } from 'vitest'

import { loadCompletions, saveCompletions } from '@sloppenheimer/core/core/completion-store.js'
import { issueId } from '@sloppenheimer/core/domain/domain.js'
import type { CompletedSnapshot } from '@sloppenheimer/core'
import { hostFileSystem } from './harness/filesystem.js'

/** The store reads and writes through `FileSystem`; these tests exercise it against real files. */
const onHost = <Value, Error>(
  effect: Effect.Effect<Value, Error, FileSystem.FileSystem>,
): Effect.Effect<Value, Error> => Effect.provide(effect, hostFileSystem)

const directories: string[] = []

/** A fresh store directory, registered for cleanup, as an effect the tests can sequence. */
const makeDirectory = (): Effect.Effect<string> =>
  Effect.promise(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppenheimer-completion-'))
    directories.push(directory)
    return directory
  })

afterEach(async (): Promise<void> => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('completion persistence', (): void => {
  it.effect('atomically round-trips versionable completion snapshots', () =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory()
      const path = join(directory, 'state', 'completions.json')
      const snapshot: CompletedSnapshot = {
        issueId: issueId('41'),
        identifier: 'example/sloppenheimer#41',
        title: 'Persist recent completions',
        url: 'https://github.com/example/sloppenheimer/issues/41',
        outcome: 'merged',
        finishedAt: '2026-08-29T00:00:00.000Z',
        pullRequestUrl: 'https://github.com/example/sloppenheimer/pull/42',
      }

      yield* onHost(saveCompletions(path, [snapshot]))

      expect(yield* onHost(loadCompletions(path))).toEqual([snapshot])
      expect(yield* Effect.promise(() => readFile(path, 'utf8'))).toContain('"version": 1')
    }),
  )

  it.effect('treats missing state as no finished work rather than a failure', () =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory()

      expect(yield* onHost(loadCompletions(join(directory, 'missing.json')))).toEqual([])
    }),
  )

  it.effect('surfaces a failing write instead of silently discarding it', () =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory()
      const path = join(directory, 'completions.json')
      yield* Effect.promise(() => mkdir(`${path}.tmp`))

      const failure = yield* Effect.flip(onHost(saveCompletions(path, [])))

      expect(failure.operation).toBe('write')
      expect(failure.message).toContain(`Could not write completion store ${path}`)
    }),
  )

  it.effect.each([
    ['unparseable JSON', '{'],
    ['a wrong envelope', '{}'],
    ['an unsupported version', '{"version":2,"completions":[]}'],
    ['a malformed entry', '{"version":1,"completions":[null]}'],
    [
      'an unrecognized outcome',
      '{"version":1,"completions":[{"issueId":"41","identifier":"example/sloppenheimer#41","title":"t","url":null,"outcome":"abandoned","finishedAt":"2026-08-29T00:00:00.000Z","pullRequestUrl":null}]}',
    ],
    [
      'an invalid completion date',
      '{"version":1,"completions":[{"issueId":"41","identifier":"example/sloppenheimer#41","title":"t","url":null,"outcome":"merged","finishedAt":"not-a-date","pullRequestUrl":null}]}',
    ],
  ] as const)('surfaces %s as a decode failure', ([, contents]) =>
    Effect.gen(function* () {
      const directory = yield* makeDirectory()
      const path = join(directory, 'completions.json')
      yield* Effect.promise(() => writeFile(path, contents))

      const failure = yield* Effect.flip(onHost(loadCompletions(path)))

      expect(failure.operation).toBe('read')
      expect(failure.message).toContain(`Could not decode completion store ${path}`)
    }),
  )
})
