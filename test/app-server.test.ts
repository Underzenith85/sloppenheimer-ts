import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  codexMaxLineBytes,
  composeSessionId,
  makeLineReader,
  runAgent,
  type AgentEvent,
  type AgentLaunch,
  type AgentResult,
} from '../src/codex.js'
import { issueId, issueIdentifier, type Issue } from '../src/domain.js'
import type { AgentError } from '../src/errors.js'
import type { CodexConfig } from '../src/workflow.js'

const fakeAppServer = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-app-server.ts',
)

const roots: string[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const makeWorkspace = async (): Promise<Readonly<{ root: string; path: string }>> => {
  const root = await mkdtemp(join(tmpdir(), 'symphony-app-server-'))
  roots.push(root)
  const path = join(root, 'issue-14')
  await mkdir(path)
  return { root, path }
}

const issue: Issue = {
  id: issueId('14'),
  nativeRef: null,
  identifier: issueIdentifier('example/symphony#14'),
  title: 'Protocol conformance',
  description: null,
  priority: null,
  state: 'open',
  branchName: null,
  url: 'https://example.test/issues/14',
  assigneeId: null,
  labels: ['symphony'],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
}

type RunOutcome = Readonly<{
  result: AgentResult | null
  error: AgentError | null
  events: readonly AgentEvent[]
}>

const runScenario = async (
  scenario: string,
  overrides: Partial<CodexConfig> = {},
  maxTurns = 1,
): Promise<RunOutcome> => {
  const { root, path } = await makeWorkspace()
  const events: AgentEvent[] = []
  const config: CodexConfig = {
    command: `node ${JSON.stringify(fakeAppServer)} ${scenario}`,
    approvalPolicy: 'never',
    threadSandbox: 'workspace-write',
    turnSandboxPolicy: null,
    turnTimeoutMs: 4_000,
    readTimeoutMs: 2_000,
    stallTimeoutMs: 0,
    ...overrides,
  }
  const launch: AgentLaunch = {
    issue,
    workspace: { path, key: 'issue-14', createdNow: false },
    workspaceRoot: root,
    config,
    prompt: 'do the work',
    maxTurns,
    secretEnvironmentNames: [],
    refreshIssue: () => Effect.succeed(null),
    isRoutable: () => false,
    onEvent: (event) => {
      events.push(event)
    },
  }
  const exit = await Effect.runPromise(Effect.either(runAgent(launch)))
  return exit._tag === 'Right'
    ? { result: exit.right, error: null, events }
    : { result: null, error: exit.left, events }
}

describe('App Server framing', (): void => {
  it('splits lines, strips CR, and never buffers past the framing limit', (): void => {
    const lines: string[] = []
    let overflowed = false
    const read = makeLineReader(
      16,
      (line) => {
        lines.push(line)
      },
      () => {
        overflowed = true
      },
    )

    read(Buffer.from('{"a":1}\r\n{"b'))
    read(Buffer.from('":2}\n'))

    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(overflowed).toBe(false)

    read(Buffer.from('x'.repeat(40)))

    expect(overflowed).toBe(true)
  })

  it('assembles a chunked line without recopying the pending prefix', (): void => {
    const lines: string[] = []
    const read = makeLineReader(
      1024 * 1024,
      (line) => {
        lines.push(line)
      },
      () => {},
    )
    const concat = vi.spyOn(Buffer, 'concat')
    const part = 'y'.repeat(64 * 1024)

    for (let index = 0; index < 8; index += 1) {
      read(Buffer.from(part))
    }
    read(Buffer.from('\n'))

    const copies = concat.mock.calls.length
    concat.mockRestore()

    expect(lines).toEqual([part.repeat(8)])
    // One copy for the whole line rather than one per chunk, so framing stays linear in line size:
    // a permitted 10 MB frame arriving in pipe-sized chunks must not copy hundreds of megabytes.
    expect(copies).toBe(1)
  })

  it('keeps the documented 10 MB protocol line limit', (): void => {
    expect(codexMaxLineBytes).toBe(10 * 1024 * 1024)
  })

  it('rejects a protocol line larger than the framing limit', async (): Promise<void> => {
    const outcome = await runScenario('oversize-line')

    expect(outcome.error?.category).toBe('protocol_error')
    expect(outcome.error?.message).toContain('exceeds')
  }, 30_000)
})

describe('App Server session lifecycle', (): void => {
  it('completes a normal turn and reports thread, turn and session identity', async (): Promise<void> => {
    const outcome = await runScenario('normal')

    expect(outcome.error).toBeNull()
    expect(outcome.result).toEqual({ threadId: 'thread-1', turnId: 'turn-1', turnCount: 1 })
    const started = outcome.events.find((event) => event.event === 'session_started')
    expect(started?.threadId).toBe('thread-1')
    expect(started?.turnId).toBe('turn-1')
    expect(started?.sessionId).toBe(composeSessionId('thread-1', 'turn-1'))
    expect(started?.message).toBe('https://example.test/issues/14')
  })

  it('attributes a notification batched with the turn/start response to that turn', async (): Promise<void> => {
    const outcome = await runScenario('batched-identity')

    expect(outcome.error).toBeNull()
    const message = outcome.events.find((event) => event.event === 'item/agentMessage')
    expect(message?.turnId).toBe('turn-1')
    expect(message?.sessionId).toBe(composeSessionId('thread-1', 'turn-1'))
  }, 30_000)

  it('does not lose a completion that arrives before its waiter exists', async (): Promise<void> => {
    const outcome = await runScenario('immediate-completion')

    expect(outcome.error).toBeNull()
    expect(outcome.result?.turnCount).toBe(1)
  })

  it('reports a failed turn', async (): Promise<void> => {
    const outcome = await runScenario('turn-failed')

    expect(outcome.error?.category).toBe('turn_failed')
    expect(outcome.error?.message).toContain('failed')
  })

  it('reports a cancelled turn announced as turn/failed', async (): Promise<void> => {
    const outcome = await runScenario('turn-cancelled')

    expect(outcome.error?.category).toBe('turn_failed')
  })

  it('surfaces a protocol error returned by thread/start', async (): Promise<void> => {
    const outcome = await runScenario('thread-error')

    expect(outcome.error?.category).toBe('protocol_error')
    expect(outcome.error?.message).toBe('thread/start refused')
  })

  it('rejects a thread/start result without a thread id', async (): Promise<void> => {
    const outcome = await runScenario('thread-missing-id')

    expect(outcome.error?.category).toBe('protocol_error')
    expect(outcome.error?.message).toContain('no thread id')
  })

  it('times out a silent startup instead of stalling', async (): Promise<void> => {
    const outcome = await runScenario('startup-silent', { readTimeoutMs: 250 })

    expect(outcome.error?.category).toBe('read_timeout')
    expect(outcome.error?.message).toContain('initialize')
  })

  it('fails immediately when the process exits during startup', async (): Promise<void> => {
    const outcome = await runScenario('startup-exit', { readTimeoutMs: 5_000 })

    expect(outcome.error?.category).toBe('process_exited')
  })

  it('fails a turn whose process exits mid-turn without waiting for the turn timeout', async (): Promise<void> => {
    const outcome = await runScenario('exit-during-turn', { turnTimeoutMs: 60_000 })

    expect(outcome.error?.category).toBe('process_exited')
  }, 30_000)
})

describe('App Server request handling', (): void => {
  it('auto-approves an approval request and finishes the turn', async (): Promise<void> => {
    const outcome = await runScenario('approval')

    expect(outcome.error).toBeNull()
    expect(outcome.events.map((event) => event.event)).toContain('approval_auto_approved')
  })

  it('declines an unsupported server request without stalling', async (): Promise<void> => {
    const outcome = await runScenario('unsupported-request', { turnTimeoutMs: 1_000 })

    expect(outcome.events.map((event) => event.event)).toContain('unsupported_tool_call')
    expect(outcome.error?.category).toBe('turn_timeout')
  })

  it('fails the turn when Codex requires interactive input', async (): Promise<void> => {
    const outcome = await runScenario('input-required', { turnTimeoutMs: 60_000 })

    expect(outcome.error?.category).toBe('input_required')
  })

  it('reports malformed protocol data and continues', async (): Promise<void> => {
    const outcome = await runScenario('malformed')

    expect(outcome.error).toBeNull()
    expect(outcome.events.filter((event) => event.event === 'malformed').length).toBeGreaterThan(0)
  })

  it('keeps stderr diagnostic and out of the protocol stream', async (): Promise<void> => {
    const outcome = await runScenario('stderr-noise')

    expect(outcome.error).toBeNull()
    const diagnostic = outcome.events.find((event) => event.event === 'diagnostic')
    expect(diagnostic?.message).toContain('diagnostic only')
  })

  it('records absolute token usage reported during a turn', async (): Promise<void> => {
    const outcome = await runScenario('usage')

    expect(outcome.events.find((event) => event.usage !== null)?.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    })
  })
})

const execFileAsync = promisify(execFile)

const codexSchema = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('codex', ['app-server', 'generate-json-schema'], {
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout
  } catch {
    return null
  }
}

describe('installed Codex App Server schema', (): void => {
  it('declares every method and policy value this client sends', async (): Promise<void> => {
    const schema = await codexSchema()
    if (schema === null) {
      // Codex is not installed here; the deterministic suite above still covers the protocol.
      expect(schema).toBeNull()
      return
    }

    for (const method of ['initialize', 'thread/start', 'turn/start']) {
      expect(schema).toContain(method)
    }
    expect(schema).not.toContain('"on-failure"')
  }, 60_000)
})
