import { removeCapturedWorkspace } from '@sloppenheimer/adapter-node/captured-cleanup.js'
import { FileSystem } from '@effect/platform'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'

import {
  makeProcessWitness,
  processWitnessDirectory,
  ProcessWitness,
  witnessedProcessesStopped,
} from '@sloppenheimer/adapter-node/process-witness.js'
import { runCommand } from '@sloppenheimer/adapter-node/command.js'
import { hostFileSystem } from './harness/filesystem.js'

it.live('retains a fast command exit while syncing ownership and proves its final settlement', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), 'process-witness-'))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      )
      const fileSystem = yield* FileSystem.FileSystem
      const directory = join(root, 'receipts')
      const witness = makeProcessWitness(fileSystem, directory)
      expect(yield* witnessedProcessesStopped(fileSystem, directory)).toBe(false)
      const result = yield* runCommand({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("retained output"); process.exitCode = 7'],
        cwd: root,
        timeoutMs: 5_000,
        captureLimit: 1_024,
      }).pipe(
        Effect.provideService(ProcessWitness, {
          ...witness,
          started: (key, processId) =>
            Effect.sleep('100 millis').pipe(Effect.zipRight(witness.started(key, processId))),
        }),
      )
      expect(result.code).toBe(7)
      expect(result.stdout).toBe('retained output')
      expect(yield* witnessedProcessesStopped(fileSystem, directory)).toBe(true)
      const unknown = yield* witness.beforeSpawn
      yield* fileSystem.writeFileString(
        join(directory, unknown + '.json'),
        JSON.stringify({
          state: 'running',
          namespace: 'another-kernel',
          processId: 999999,
          startMarker: 'unknown',
        }),
      )
      expect(yield* witnessedProcessesStopped(fileSystem, directory)).toBe(false)
      yield* witness.stopped(unknown)
      yield* witness.beforeSpawn
      expect(yield* witnessedProcessesStopped(fileSystem, directory)).toBe(false)
    }),
  ).pipe(Effect.provide(hostFileSystem)),
)

it.live('removes only the captured workspace after receipt settlement', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), 'captured-cleanup-'))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      )
      const fileSystem = yield* FileSystem.FileSystem
      const workspace = { path: join(root, 'issue', 'run-original'), key: 'run-original' }
      yield* fileSystem.makeDirectory(workspace.path, { recursive: true })
      const witness = makeProcessWitness(fileSystem, processWitnessDirectory(root, workspace.path))
      const receipt = yield* witness.beforeSpawn
      const hooks = {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 1_000,
      }
      const held = yield* removeCapturedWorkspace(fileSystem, hooks, workspace).pipe(Effect.either)
      expect(held._tag).toBe('Left')
      expect(yield* fileSystem.exists(workspace.path)).toBe(true)
      yield* witness.stopped(receipt)
      yield* removeCapturedWorkspace(fileSystem, hooks, workspace)
      expect(yield* fileSystem.exists(workspace.path)).toBe(false)
      // Idempotent settlement after a crash between deletion and the durable completion commit.
      yield* removeCapturedWorkspace(fileSystem, hooks, workspace)
    }),
  ).pipe(Effect.provide(hostFileSystem)),
)
