import type { Readable } from 'node:stream'
import { ProcessWitness } from './process-witness.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Effect, Option, type Scope } from 'effect'

import { SubprocessError } from '@sloppenheimer/core/domain/errors.js'
import {
  childProcessGroupIsAlive,
  terminateChildProcess,
} from '@sloppenheimer/core/support/subprocess.js'

export type ProcessRequest = Readonly<{
  command: string
  args: readonly string[]
  cwd: string
  environment?: Readonly<NodeJS.ProcessEnv>
  terminationGraceMs?: number
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void
}>

type ProcessClose = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
// A fast command can close while its ownership receipt is being synced, before a reader attaches.
const interruptedOutput = new WeakSet<Readable>()
export const observedOutputInterrupted = (stream: Readable): boolean =>
  interruptedOutput.has(stream)
const processErrors = new WeakMap<ChildProcessWithoutNullStreams, Error>()
export const observedProcessError = (child: ChildProcessWithoutNullStreams): Error | undefined =>
  processErrors.get(child)
const closedProcesses = new WeakMap<ChildProcessWithoutNullStreams, ProcessClose>()
export const observedProcessClose = (
  child: ChildProcessWithoutNullStreams,
): ProcessClose | undefined => closedProcesses.get(child)

/**
 * The single acquisition boundary for commands and streaming agent transports.
 * The caller decides whether bytes are protocol or bounded diagnostics.
 * The scope waits for bounded process-tree termination before releasing its enclosing workspace.
 * The termination helper may exhaust its reap bound; this is not evidence for adopting a
 * retained workspace after a host crash.
 */
export const openProcess = (
  request: ProcessRequest,
): Effect.Effect<ChildProcessWithoutNullStreams, SubprocessError, Scope.Scope> =>
  Effect.gen(function* () {
    const witness = yield* Effect.serviceOption(ProcessWitness)
    const key = Option.isNone(witness) ? undefined : yield* witness.value.beforeSpawn
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const child = spawn(request.command, [...request.args], {
            cwd: request.cwd,
            ...(request.environment === undefined ? {} : { env: request.environment }),
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
          })
          // Errors can arrive before a reader attaches or after it detaches.
          child.on('error', (error) => processErrors.set(child, error))
          child.stdin.on('error', () => {})
          child.stdout.on('error', () => interruptedOutput.add(child.stdout))
          child.stderr.on('error', () => interruptedOutput.add(child.stderr))
          child.once('close', (code, signal) => closedProcesses.set(child, { code, signal }))
          return child
        },
        catch: (cause) =>
          new SubprocessError({
            category: 'spawn_failed',
            message: 'failed to start subprocess',
            cause,
          }),
      }),
      (child) =>
        Effect.promise(() => terminateChildProcess(child, request.terminationGraceMs ?? 1_000))
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                child.stdin.destroy()
                child.stdout.destroy()
                child.stderr.destroy()
              }),
            ),
          )
          .pipe(
            Effect.zipRight(
              Effect.suspend(() => {
                if (childProcessGroupIsAlive(child)) {
                  return Effect.dieMessage(
                    'Subprocess termination could not be confirmed; workspace remains owned',
                  )
                }
                return Option.isSome(witness) && key !== undefined
                  ? witness.value.stopped(key).pipe(Effect.orDie)
                  : Effect.void
              }),
            ),
          ),
    )
    yield* Effect.sync(() => request.onSpawn?.(child))
    if (Option.isSome(witness) && key !== undefined) {
      yield* witness.value.started(key, child.pid)
    }
    return child
  })
