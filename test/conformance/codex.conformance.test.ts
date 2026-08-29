import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { runAgent, type AgentEvent, type AgentResult } from '../../src/codex.js'
import { issueId, issueIdentifier, type Issue, type Workspace } from '../../src/domain.js'
import type { CodexConfig } from '../../src/workflow.js'
import { fakeAppServerCommand, type FakeAppServerScenario } from '../harness/fake-app-server.js'

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

const workspace: Workspace = { path: process.cwd(), key: 'fake', createdNow: false }

const runScenario = async (
  scenario: FakeAppServerScenario,
  timeoutMs = 1_000,
): Promise<Readonly<{ events: readonly AgentEvent[]; result: AgentResult }>> => {
  const events: AgentEvent[] = []
  const config: CodexConfig = {
    command: fakeAppServerCommand(scenario),
    approvalPolicy: 'never',
    threadSandbox: 'workspace-write',
    turnSandboxPolicy: null,
    readTimeoutMs: scenario === 'read-timeout' ? timeoutMs : 1_000,
    turnTimeoutMs: scenario === 'turn-timeout' ? timeoutMs : 1_000,
    stallTimeoutMs: 0,
  }
  const run = (): Promise<AgentResult> =>
    Effect.runPromise(
      runAgent(
        issue,
        workspace,
        config,
        'conformance prompt',
        1,
        [],
        () => Effect.succeed(null),
        () => false,
        (event) => events.push(event),
      ),
    )
  return { events, result: await run() }
}

describe('Core Conformance Codex App Server client', (): void => {
  it('uses JSONL framing, extracts identities, and emits usage telemetry', async (): Promise<void> => {
    const { events, result } = await runScenario('complete')

    expect(result).toEqual({ threadId: 'thread-fake', turnId: 'turn-fake', turnCount: 1 })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'session_started', message: 'thread-fake-turn-fake' }),
        expect.objectContaining({
          event: 'turn/usageUpdated',
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        }),
      ]),
    )
  })

  it('keeps diagnostic stderr separate from protocol stdout', async (): Promise<void> => {
    const { events } = await runScenario('diagnostic')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'diagnostic', message: 'fake diagnostic' }),
      ]),
    )
  })

  it('answers approval requests according to the documented session policy', async (): Promise<void> => {
    const { events } = await runScenario('approval')
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'approval_auto_approved' })]),
    )
  })

  it('rejects unsupported client requests without stalling the turn', async (): Promise<void> => {
    const { events, result } = await runScenario('unsupported-tool')
    expect(result.turnCount).toBe(1)
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'unsupported_tool_call' })]),
    )
  })

  it('fails user-input requests immediately instead of waiting indefinitely', async (): Promise<void> => {
    await expect(runScenario('user-input')).rejects.toThrow('Codex requested interactive input')
  })

  it('enforces request and response read timeouts', async (): Promise<void> => {
    await expect(runScenario('read-timeout', 30)).rejects.toThrow('initialize response timed out')
  })

  it('enforces turn timeouts', async (): Promise<void> => {
    await expect(runScenario('turn-timeout', 30)).rejects.toThrow('turn turn-fake timed out')
  })
})
