import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'

import {
  runAgent,
  type AgentEvent,
  type AgentLaunch,
  type AgentResult,
} from '@symphony/adapter-codex/codex.js'
import type { AgentError } from '@symphony/core/domain/errors.js'
import { issueId, issueIdentifier, type Issue } from '@symphony/core/domain/domain.js'
import type { AgentRunnerConfig } from '@symphony/core/ports/agent-runner.js'
import { fakeAppServerCommand, type FakeAppServerScenario } from '../harness/fake-app-server.js'
import { hostFileSystem } from '../harness/filesystem.js'

/** Launch verification reads the workspace through `FileSystem`; the host's is bound here. */
const runAgentOnHost = (launch: AgentLaunch): Effect.Effect<AgentResult, AgentError> =>
  runAgent(launch).pipe(Effect.provide(hostFileSystem))

const issue: Issue = {
  id: issueId('fake-issue'),
  nativeRef: null,
  identifier: issueIdentifier('fake/repository#19'),
  title: 'Exercise the App Server boundary',
  description: null,
  priority: null,
  state: 'open',
  branchName: null,
  url: null,
  assigneeId: null,
  labels: [],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
}

type ScenarioOutcome = Readonly<{ events: readonly AgentEvent[]; result: AgentResult }>

const runScenario = (
  scenario: FakeAppServerScenario,
  timeoutMs = 1_000,
): Effect.Effect<ScenarioOutcome, AgentError> =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-conformance-'))
      await mkdir(join(workspaceRoot, 'fake'))
      return workspaceRoot
    }),
    (workspaceRoot) => {
      const events: AgentEvent[] = []
      const configuredPolicies = scenario === 'configured-policies'
      const expectation = configuredPolicies
        ? {
            approvalPolicy: 'on-request',
            threadSandbox: 'read-only',
            turnSandboxPolicy: { type: 'readOnly', networkAccess: false },
          }
        : undefined
      const config: AgentRunnerConfig = {
        command: fakeAppServerCommand(scenario, expectation),
        settings: {
          approvalPolicy: expectation?.approvalPolicy ?? 'never',
          threadSandbox: expectation?.threadSandbox ?? 'workspace-write',
          turnSandboxPolicy: expectation?.turnSandboxPolicy ?? null,
        },
        readTimeoutMs: scenario === 'read-timeout' ? timeoutMs : 1_000,
        turnTimeoutMs: scenario === 'turn-timeout' ? timeoutMs : 1_000,
        stallTimeoutMs: 0,
      }
      return runAgentOnHost({
        issue,
        workspace: { path: join(workspaceRoot, 'fake'), key: 'fake', createdNow: true },
        workspaceRoot,
        config,
        prompt: 'conformance prompt',
        maxTurns: 1,
        secretEnvironmentNames: [],
        refreshIssue: () => Effect.succeed(null),
        isRoutable: () => false,
        onEvent: (event) => events.push(event),
      }).pipe(Effect.map((result): ScenarioOutcome => ({ events, result })))
    },
    // Released on failure and interruption alike, which the `finally` this replaces could not
    // promise once the run became an interruptible fiber.
    (workspaceRoot) => Effect.promise(() => rm(workspaceRoot, { force: true, recursive: true })),
  )

// `live` throughout: every scenario spawns the fake App Server as a real child process and leans
// on real read and turn timeouts, so the suite needs the wall clock.
describe('Core Conformance Codex App Server client', (): void => {
  it.live('uses JSONL framing, extracts identities, and emits usage telemetry', () =>
    Effect.gen(function* () {
      const { events, result } = yield* runScenario('complete')

      expect(result).toEqual({ threadId: 'thread-1', turnId: 'turn-1', turnCount: 1 })
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'session_started', threadId: 'thread-1' }),
          expect.objectContaining({
            event: 'turn/usage',
            usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
          }),
        ]),
      )
    }),
  )

  it.live('keeps diagnostic stderr separate from protocol stdout', () =>
    Effect.gen(function* () {
      const { events } = yield* runScenario('diagnostic')
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'diagnostic',
            message: 'warning: this is diagnostic only',
          }),
        ]),
      )
    }),
  )

  it.live('answers approval requests according to the documented session policy', () =>
    Effect.gen(function* () {
      const { events } = yield* runScenario('approval')
      expect(events).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: 'approval_auto_approved' })]),
      )
    }),
  )

  it.live('answers file-change approval requests according to the documented session policy', () =>
    Effect.gen(function* () {
      const { events } = yield* runScenario('file-approval')
      expect(events).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: 'approval_auto_approved' })]),
      )
    }),
  )

  it.live('preserves configured approval and sandbox policies', () =>
    Effect.gen(function* () {
      const { result } = yield* runScenario('configured-policies')
      expect(result.turnCount).toBe(1)
    }),
  )

  it.live('rejects unsupported client requests without stalling the turn', () =>
    Effect.gen(function* () {
      const { events, result } = yield* runScenario('unsupported-tool')
      expect(result.turnCount).toBe(1)
      expect(events).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: 'unsupported_tool_call' })]),
      )
    }),
  )

  it.live('fails user-input requests immediately instead of waiting indefinitely', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(runScenario('user-input'))
      expect(failure.message).toContain('Codex requested interactive input')
    }),
  )

  it.live('enforces request and response read timeouts', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(runScenario('read-timeout', 30))
      expect(failure.message).toContain('initialize response timed out')
    }),
  )

  it.live('enforces turn timeouts', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(runScenario('turn-timeout', 30))
      expect(failure.message).toContain('turn turn-1 produced no output')
    }),
  )
})
