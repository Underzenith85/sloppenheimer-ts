import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Effect, type Scope } from 'effect'

import { SubprocessError } from '@sloppenheimer/core/domain/errors.js'
import { terminateChildProcess } from '@sloppenheimer/core/support/subprocess.js'

export type ProcessRequest = Readonly<{
  command: string
  args: readonly string[]
  cwd: string
  environment?: Readonly<NodeJS.ProcessEnv>
  terminationGraceMs?: number
}>

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
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const child = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          ...(request.environment === undefined ? {} : { env: request.environment }),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        })
        // Errors can arrive before a reader attaches or after it detaches.
        child.on('error', () => {})
        child.stdin.on('error', () => {})
        child.stdout.on('error', () => {})
        child.stderr.on('error', () => {})
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
      Effect.promise(() => terminateChildProcess(child, request.terminationGraceMs ?? 1_000)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            child.stdin.destroy()
            child.stdout.destroy()
            child.stderr.destroy()
          }),
        ),
      ),
  )
