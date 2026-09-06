import { FileSystem } from '@effect/platform'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context, Effect, Schema } from 'effect'

import { SubprocessError } from '@sloppenheimer/core/domain/errors.js'
import { processGroupIsAlive } from '@sloppenheimer/core/support/subprocess.js'
import { hostOwner, processStartMarker } from './workspace-lease.js'

const witnessSchema = Schema.Struct({
  namespace: Schema.NullOr(Schema.String),
  processId: Schema.NullOr(Schema.Int),
  startMarker: Schema.NullOr(Schema.String),
  state: Schema.Literal('starting', 'running', 'stopped'),
})
type Witness = typeof witnessSchema.Type

export class ProcessWitness extends Context.Tag('sloppenheimer/ProcessWitness')<
  ProcessWitness,
  Readonly<{
    beforeSpawn: Effect.Effect<string, SubprocessError>
    started: (key: string, processId: number | undefined) => Effect.Effect<void, SubprocessError>
    stopped: (key: string) => Effect.Effect<void, SubprocessError>
  }>
>() {}

export const processWitnessDirectory = (root: string, workspacePath: string): string =>
  join(
    root,
    '.sloppenheimer',
    'processes',
    createHash('sha256').update(workspacePath).digest('hex'),
  )

/** A starting marker precedes spawn. A crash in the spawn/record gap therefore fails closed. */
export const makeProcessWitness = (
  fileSystem: FileSystem.FileSystem,
  directory: string,
): ProcessWitness['Type'] => {
  const write = (key: string, value: Witness): Effect.Effect<void, SubprocessError> =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(directory, { recursive: true })
        const temporary = join(directory, key + '.pending')
        const file = yield* fileSystem.open(temporary, { flag: 'w', mode: 0o600 })
        yield* file.writeAll(new TextEncoder().encode(JSON.stringify(value)))
        yield* file.sync
        yield* fileSystem.rename(temporary, join(directory, key + '.json'))
        const parent = yield* fileSystem.open(directory, { flag: 'r' })
        yield* parent.sync
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SubprocessError({
            category: 'spawn_failed',
            message: 'Process ownership evidence could not be persisted',
            cause,
          }),
      ),
    )
  return {
    beforeSpawn: Effect.gen(function* () {
      const key = randomUUID()
      yield* write(key, {
        namespace: hostOwner.namespace,
        processId: null,
        startMarker: null,
        state: 'starting',
      })
      return key
    }),
    started: (key, processId) =>
      write(key, {
        namespace: hostOwner.namespace,
        processId: processId ?? null,
        startMarker: processId === undefined ? null : processStartMarker(processId),
        state: processId === undefined ? 'stopped' : 'running',
      }),
    stopped: (key) =>
      write(key, {
        namespace: hostOwner.namespace,
        processId: null,
        startMarker: null,
        state: 'stopped',
      }),
  }
}

/** Reads captured process groups, including orphaned descendants whose leader has exited. */
export const witnessedProcessesStopped = (
  fileSystem: FileSystem.FileSystem,
  directory: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!(yield* fileSystem.exists(directory))) {
      return false
    }
    const entries = yield* fileSystem.readDirectory(directory)
    if (entries.length === 0) {
      return false
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) {
        return false
      }
      const witness = yield* Schema.decodeUnknown(Schema.parseJson(witnessSchema))(
        yield* fileSystem.readFileString(join(directory, name)),
      )
      if (witness.state === 'stopped') {
        continue
      }
      if (
        witness.state === 'starting' ||
        witness.namespace === null ||
        witness.namespace !== hostOwner.namespace ||
        witness.processId === null
      ) {
        return false
      }
      if (processGroupIsAlive(witness.processId)) {
        return false
      }
    }
    return true
  }).pipe(Effect.catchAll(() => Effect.succeed(false)))
