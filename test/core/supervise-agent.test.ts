import { it } from '@effect/vitest'
import { Deferred, Effect, Fiber, TestClock } from 'effect'
import { expect } from 'vitest'

import { superviseAgent } from '@sloppenheimer/core/core/supervise-agent.js'
import type { AgentLaunch, AgentRunnerPort } from '@sloppenheimer/core/ports/agent-runner.js'
import { anIssue } from '../harness/fixtures.js'
import { codexRunnerConfig } from '../harness/codex-runner-config.js'

const launch = (): AgentLaunch => ({
  issue: anIssue(),
  workspace: { key: 'run', path: '/workspace/run' },
  workspaceRoot: '/workspace',
  config: codexRunnerConfig({ stallTimeoutMs: 100 }),
  prompt: 'Implement the assignment',
  maxTurns: 1,
  secretEnvironmentNames: [],
  refreshIssue: () => Effect.succeed(null),
  isRoutable: () => true,
  onEvent: () => {},
})

it.effect('ends a silent delegation without a tracker poll and waits for its finalizer', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const runner: AgentRunnerPort = {
      kind: 'test',
      run: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Effect.never),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        ),
    }
    const fiber = yield* Effect.fork(superviseAgent(runner, launch()).pipe(Effect.flip))
    yield* Deferred.await(started)
    yield* TestClock.adjust(101)
    const error = yield* Fiber.join(fiber)
    expect(error.message).toBe('agent stalled')
    expect(yield* Deferred.isDone(stopped)).toBe(true)
  }),
)
