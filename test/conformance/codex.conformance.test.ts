import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { runAgent, type AgentEvent, type AgentResult } from '../../src/codex.js'
import { issueId, issueIdentifier, type Issue } from '../../src/domain.js'
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

const runScenario = async (
  scenario: FakeAppServerScenario,
  timeoutMs = 1_000,
): Promise<Readonly<{ events: readonly AgentEvent[]; result: AgentResult }>> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-conformance-'))
  const workspacePath = join(workspaceRoot, 'fake')
  await mkdir(workspacePath)
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
  try {
    const result = await Effect.runPromise(
      runAgent({
        issue,
        workspace: { path: workspacePath, key: 'fake', createdNow: true },
        workspaceRoot,
        config,
        prompt: 'conformance prompt',
        maxTurns: 1,
        secretEnvironmentNames: [],
        refreshIssue: () => Effect.succeed(null),
        isRoutable: () => false,
        onEvent: (event) => events.push(event),
      }),
    )
    return { events, result }
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true })
  }
}

describe('Core Conformance Codex App Server client', (): void => {
  it('uses JSONL framing, extracts identities, and emits usage telemetry', async (): Promise<void> => {
    const { events, result } = await runScenario('complete')

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
  })

  it('keeps diagnostic stderr separate from protocol stdout', async (): Promise<void> => {
    const { events } = await runScenario('diagnostic')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'diagnostic',
          message: 'warning: this is diagnostic only',
        }),
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
    await expect(runScenario('turn-timeout', 30)).rejects.toThrow('turn turn-1 produced no output')
  })
})
