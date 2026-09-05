import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { runCommand } from '@sloppenheimer/adapter-node/command.js'

it.live('bounds capture while draining both output pipes', () =>
  Effect.gen(function* () {
    const result = yield* runCommand({
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write('a'.repeat(100000)); process.stderr.write('b'.repeat(100000))",
      ],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      captureLimit: 256,
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toHaveLength(256)
    expect(result.stderr).toHaveLength(256)
    expect(result.stdoutBytes).toBe(100_000)
    expect(result.stderrBytes).toBe(100_000)
    expect(result.stdoutTruncated).toBe(true)
  }),
)

it.live('settles a hung child at its own deadline', () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      runCommand({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
        timeoutMs: 50,
        captureLimit: 256,
        terminationGraceMs: 25,
      }),
    )
    expect(failure.category).toBe('timed_out')
  }),
)

it.live('reports an asynchronous spawn failure on the typed channel', () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      runCommand({
        command: '/nonexistent/sloppenheimer-command',
        args: [],
        cwd: process.cwd(),
        timeoutMs: 500,
        captureLimit: 256,
      }),
    )
    expect(failure.category).toBe('spawn_failed')
  }),
)
