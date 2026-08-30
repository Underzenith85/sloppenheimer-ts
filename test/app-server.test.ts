import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Effect, Fiber } from 'effect'
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
import { codexApprovalPolicies, codexSandboxModes, type CodexConfig } from '../src/workflow.js'

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
): Promise<RunOutcome & Readonly<{ path: string }>> => {
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
    ? { result: exit.right, error: null, events, path }
    : { result: null, error: exit.left, events, path }
}

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
  return predicate()
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

  it('accepts a maximum-length line whose CRLF is split across chunks', (): void => {
    const lines: string[] = []
    let overflowed = false
    const read = makeLineReader(
      8,
      (line) => {
        lines.push(line)
      },
      () => {
        overflowed = true
      },
    )

    read(Buffer.from('12345678\r'))
    read(Buffer.from('\n'))

    // The CR is stripped once the line completes, so where the chunk boundary fell must not decide
    // whether a valid maximum-length line is accepted.
    expect(overflowed).toBe(false)
    expect(lines).toEqual(['12345678'])
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
    expect(started?.turnId).toBeNull()
    expect(started?.sessionId).toBe(composeSessionId('thread-1', null))
    expect(started?.message).toBeNull()
    const turnStartedIndex = outcome.events.findIndex((event) => event.event === 'turn_started')
    const turnCompletedIndex = outcome.events.findIndex((event) => event.event === 'turn/completed')
    expect(turnStartedIndex).toBeGreaterThanOrEqual(0)
    expect(turnStartedIndex).toBeLessThan(turnCompletedIndex)
    expect(outcome.events[turnStartedIndex]?.turnCount).toBe(1)
    expect(outcome.events[turnCompletedIndex]?.turnCount).toBe(1)
  })

  it('attributes a notification from the thread and turn ids it carries', async (): Promise<void> => {
    const outcome = await runScenario('carried-identity')

    expect(outcome.error).toBeNull()
    const started = outcome.events.find((event) => event.event === 'item/started')
    expect(started?.threadId).toBe('thread-1')
    expect(started?.turnId).toBe('turn-1')
    expect(started?.sessionId).toBe(composeSessionId('thread-1', 'turn-1'))
  }, 30_000)

  it('attributes an approval that arrives before the turn/start response', async (): Promise<void> => {
    const outcome = await runScenario('approval-before-response')

    expect(outcome.error).toBeNull()
    const approved = outcome.events.find((event) => event.event === 'approval_auto_approved')
    expect(approved?.threadId).toBe('thread-1')
    expect(approved?.turnId).toBe('turn-1')
    expect(approved?.sessionId).toBe(composeSessionId('thread-1', 'turn-1'))
  }, 30_000)

  it('answers a server request that carries a string id', async (): Promise<void> => {
    const outcome = await runScenario('string-request-id', { turnTimeoutMs: 2_000 })

    expect(outcome.error).toBeNull()
    expect(outcome.result?.turnCount).toBe(1)
    expect(outcome.events.map((event) => event.event)).toContain('approval_auto_approved')
  }, 30_000)

  it('keeps a completed turn completed when the session then dies', async (): Promise<void> => {
    const outcome = await runScenario('complete-then-exit')

    expect(outcome.error).toBeNull()
    expect(outcome.result?.turnCount).toBe(1)
  }, 30_000)

  it('keeps the first settlement when a later notification contradicts it', async (): Promise<void> => {
    const outcome = await runScenario('failed-then-completed')

    expect(outcome.result).toBeNull()
    expect(outcome.error?.category).toBe('turn_failed')
    expect(
      outcome.events
        .filter((event) => event.event === 'turn/failed' || event.event === 'turn/completed')
        .map((event) => event.event),
    ).toEqual(['turn/failed'])
  }, 30_000)

  it('fails a turn whose completion omitted a status', async (): Promise<void> => {
    const outcome = await runScenario('turn-no-status')

    expect(outcome.result).toBeNull()
    expect(outcome.error?.category).toBe('turn_failed')
    expect(outcome.events.map((event) => event.event)).toContain('malformed')
  }, 30_000)

  it('reports a recorded turn failure in preference to a buffered completion', async (): Promise<void> => {
    const outcome = await runScenario('input-then-completion')

    expect(outcome.result).toBeNull()
    expect(outcome.error?.category).toBe('input_required')
    expect(
      outcome.events.filter((event) => event.event.startsWith('turn/')).map((event) => event.event),
    ).toEqual(['turn/terminated'])
  }, 30_000)

  it('answers a permissions approval with a grant that widens nothing', async (): Promise<void> => {
    const outcome = await runScenario('permissions-approval')

    // The turn proceeds because the response is one the server can decode, and it carries no
    // additional filesystem or network permission: the sandbox stays the one the workflow declared.
    expect(outcome.error).toBeNull()
    expect(outcome.result?.turnCount).toBe(1)
    const events = outcome.events.map((event) => event.event)
    expect(events).toContain('permissions_grant_withheld')
    expect(events).not.toContain('unsupported_tool_call')
    expect(events).not.toContain('approval_auto_approved')
  }, 30_000)

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
    const startedIndex = outcome.events.findIndex((event) => event.event === 'turn_started')
    const completedIndex = outcome.events.findIndex((event) => event.event === 'turn/completed')
    expect(startedIndex).toBeGreaterThanOrEqual(0)
    expect(startedIndex).toBeLessThan(completedIndex)
    expect(outcome.events[completedIndex]?.turnCount).toBe(1)
  })

  it('reports a failed turn', async (): Promise<void> => {
    const outcome = await runScenario('turn-failed')

    expect(outcome.error?.category).toBe('turn_failed')
    expect(outcome.error?.message).toContain('failed')
  })

  it('reports a cancelled turn announced as turn/failed', async (): Promise<void> => {
    const outcome = await runScenario('turn-cancelled')

    // The specific status the server reported must survive; `turn/failed` does not flatten it.
    expect(outcome.error?.message).toContain('cancelled')
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
    expect(outcome.error).toBeNull()
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

  it('buffers split stderr records before redacting credentials', async (): Promise<void> => {
    const outcome = await runScenario('split-stderr-secret')
    const diagnostics = outcome.events
      .filter((event) => event.event === 'diagnostic')
      .map((event) => event.message)

    expect(diagnostics).toContain('Authorization=[REDACTED]')
    expect(JSON.stringify(diagnostics)).not.toContain('split-secret')
  })

  it('suppresses every line of a multiline PEM diagnostic', async (): Promise<void> => {
    const outcome = await runScenario('pem-stderr-secret')
    const diagnostics = outcome.events
      .filter((event) => event.event === 'diagnostic')
      .map((event) => event.message)

    expect(diagnostics).toContain('PRIVATE_KEY=[REDACTED]')
    expect(JSON.stringify(diagnostics)).not.toContain('c2VjcmV0LXByaXZhdGUta2V5LWJvZHk')
    expect(JSON.stringify(diagnostics)).not.toContain('END PRIVATE KEY')
  })

  it('suppresses every line of an ASCII-armored PGP private key', async (): Promise<void> => {
    const outcome = await runScenario('pgp-stderr-secret')
    const diagnostics = outcome.events
      .filter((event) => event.event === 'diagnostic')
      .map((event) => event.message)

    expect(diagnostics).toContain('[REDACTED PEM PRIVATE KEY]')
    expect(JSON.stringify(diagnostics)).not.toContain('c2VjcmV0LXBncC1wcml2YXRlLWtleQ')
    expect(JSON.stringify(diagnostics)).not.toContain('PGP PRIVATE KEY BLOCK')
  })

  it('flushes an unterminated final stderr record before shutdown', async (): Promise<void> => {
    const outcome = await runScenario('unterminated-stderr-secret')
    const diagnostics = outcome.events
      .filter((event) => event.event === 'diagnostic')
      .map((event) => event.message)

    expect(diagnostics).toContain('Authorization=[REDACTED]')
    expect(JSON.stringify(diagnostics)).not.toContain('final-secret')
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

const schemaArguments = ['app-server', 'generate-json-schema'] as const
const bufferLimit = { maxBuffer: 64 * 1024 * 1024 } as const

/**
 * The schema of the installed Codex, or null when Codex is absent. Only a missing executable is a
 * skip: any other failure — a rejected invocation above all — must fail the test rather than be
 * swallowed into a silent pass that checks nothing.
 */
const codexSchema = async (): Promise<string | null> => {
  const help = await execFileAsync('codex', [...schemaArguments, '--help'], bufferLimit).catch(
    (cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw cause
    },
  )
  if (help === null) {
    return null
  }
  if (!help.stdout.includes('--out')) {
    const { stdout } = await execFileAsync('codex', [...schemaArguments], bufferLimit)
    return stdout
  }
  // This build writes a bundle of schema files into a directory instead of printing to stdout.
  const directory = await mkdtemp(join(tmpdir(), 'symphony-codex-schema-'))
  roots.push(directory)
  await execFileAsync('codex', [...schemaArguments, '--out', directory], bufferLimit)
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  const contents = await Promise.all(
    files.map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
  )
  return contents.join('\n')
}

describe('installed Codex App Server schema', (): void => {
  it('declares every method and policy value this client sends', async (): Promise<void> => {
    const schema = await codexSchema()
    if (schema === null) {
      // Codex is not installed here; the deterministic suite above still covers the protocol.
      expect(schema).toBeNull()
      return
    }

    // A schema that came back empty means the invocation produced nothing, not that it agreed.
    expect(schema.length).toBeGreaterThan(0)

    for (const method of [
      'initialize',
      'thread/start',
      'turn/start',
      // Every server-initiated request this client answers, each with its own response shape.
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
    ]) {
      expect(schema).toContain(method)
    }
    // The permissions grant this client sends must still be the shape the schema declares.
    expect(schema).toContain('GrantedPermissionProfile')
    expect(schema).toContain('PermissionGrantScope')
    // Every policy this client can send must be declared. A build that also offers values Symphony
    // never sends is still compatible, so the check is one-directional.
    for (const policy of codexApprovalPolicies) {
      expect(schema).toContain(`"${policy}"`)
    }
    for (const mode of codexSandboxModes) {
      expect(schema).toContain(`"${mode}"`)
    }
  }, 60_000)
})

describe('App Server timeouts and shutdown', (): void => {
  it('treats turn_timeout_ms as a silence timeout that activity re-arms', async (): Promise<void> => {
    // The turn runs far longer than turn_timeout_ms but is never silent for that long.
    const outcome = await runScenario('heartbeat', { turnTimeoutMs: 300 })

    expect(outcome.error).toBeNull()
    expect(outcome.result?.turnCount).toBe(1)
    expect(
      outcome.events.filter((event) => event.event === 'turn/progress').length,
    ).toBeGreaterThanOrEqual(5)
  }, 30_000)

  it('expires a turn that goes silent for longer than the silence timeout', async (): Promise<void> => {
    const outcome = await runScenario('silent-turn', { turnTimeoutMs: 300 })

    expect(outcome.error?.category).toBe('turn_timeout')
    expect(outcome.error?.message).toContain('no output')
  }, 30_000)

  it('keeps the read timeout distinct from the turn silence timeout', async (): Promise<void> => {
    const outcome = await runScenario('startup-silent', {
      readTimeoutMs: 200,
      turnTimeoutMs: 60_000,
    })

    expect(outcome.error?.category).toBe('read_timeout')
  }, 30_000)

  it('reports a cancelled turn with its own category', async (): Promise<void> => {
    const outcome = await runScenario('turn-cancelled')

    expect(outcome.error?.category).toBe('turn_cancelled')
  })

  it('reports the current protocol interrupted status as cancellation', async (): Promise<void> => {
    const outcome = await runScenario('turn-interrupted')

    expect(outcome.error?.category).toBe('turn_cancelled')
  })

  it('merges sparse rate-limit notifications into the initial full snapshot', async (): Promise<void> => {
    const outcome = await runScenario('sparse-rate-limit-before-read')
    const baseline = outcome.events.find((event) => event.event === 'account/rateLimits/read')

    expect(baseline?.rateLimits).toEqual({
      limitId: 'codex',
      credits: { hasCredits: true, unlimited: false, balance: '20' },
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_730_948_100 },
      secondary: { usedPercent: 5, windowDurationMins: 1_440, resetsAt: 1_730_948_200 },
    })
    expect(
      outcome.events.filter(
        (event) => event.event === 'account/rateLimits/updated' && event.rateLimits !== null,
      ),
    ).toEqual([])
  })

  it('terminates the whole App Server process tree on shutdown', async (): Promise<void> => {
    const outcome = await runScenario('spawn-grandchild', { turnTimeoutMs: 400 })
    const pidFile = join(outcome.path, 'grandchild.pid')
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim())

    expect(outcome.error?.category).toBe('turn_timeout')
    expect(Number.isSafeInteger(grandchild)).toBe(true)
    expect(grandchild).toBeGreaterThan(0)
    // Already gone when the run returns: shutdown does not finish while the group is alive.
    expect(processIsAlive(grandchild)).toBe(false)
  }, 30_000)

  it('still forces termination when a descendant ignores SIGTERM', async (): Promise<void> => {
    const outcome = await runScenario('stubborn-grandchild', { turnTimeoutMs: 400 })
    const grandchild = Number((await readFile(join(outcome.path, 'grandchild.pid'), 'utf8')).trim())

    expect(outcome.error?.category).toBe('turn_timeout')
    expect(grandchild).toBeGreaterThan(0)
    expect(processIsAlive(grandchild)).toBe(false)
  }, 40_000)

  it('reaps a descendant left behind when the App Server itself dies', async (): Promise<void> => {
    const outcome = await runScenario('orphan-after-crash', { turnTimeoutMs: 30_000 })
    const grandchild = Number((await readFile(join(outcome.path, 'grandchild.pid'), 'utf8')).trim())

    // The leader exiting is not shutdown completing: the descendant is still in its process group,
    // and it ignores SIGTERM, so only a group-level escalation clears it.
    expect(outcome.error?.category).toBe('process_exited')
    expect(grandchild).toBeGreaterThan(0)
    expect(processIsAlive(grandchild)).toBe(false)
  }, 40_000)

  it('does not let parseable garbage keep a silent turn alive', async (): Promise<void> => {
    const outcome = await runScenario('garbage-heartbeat', { turnTimeoutMs: 600 })

    expect(outcome.error?.category).toBe('turn_timeout')
  }, 30_000)

  it('does not let notifications naming no turn keep a turn alive', async (): Promise<void> => {
    const outcome = await runScenario('unattributed-heartbeat', { turnTimeoutMs: 600 })

    expect(outcome.error?.category).toBe('turn_timeout')
  }, 30_000)

  it('finishes shutdown as soon as the group empties, not after the whole grace', async (): Promise<void> => {
    const started = Date.now()
    const outcome = await runScenario('slow-exiting-grandchild', { turnTimeoutMs: 400 })
    const elapsed = Date.now() - started
    const grandchild = Number((await readFile(join(outcome.path, 'grandchild.pid'), 'utf8')).trim())

    expect(processIsAlive(grandchild)).toBe(false)
    // The descendant leaves ~400ms after SIGTERM. Waiting on the leader's exit alone would have
    // meant sitting out the full 5s escalation grace before anyone looked again.
    expect(elapsed).toBeLessThan(3_000)
  }, 30_000)

  it('does not let responses matching no pending request keep a turn alive', async (): Promise<void> => {
    const outcome = await runScenario('unmatched-response-heartbeat', { turnTimeoutMs: 600 })

    expect(outcome.error?.category).toBe('turn_timeout')
    expect(outcome.events.map((event) => event.event)).toContain('unmatched_response')
  }, 30_000)

  it('does not let traffic for an older turn keep the current one alive', async (): Promise<void> => {
    const outcome = await runScenario('stale-turn-heartbeat', { turnTimeoutMs: 600 })

    expect(outcome.error?.category).toBe('turn_timeout')
  }, 30_000)

  it('settles a cancelled session once and leaves no process tree behind', async (): Promise<void> => {
    const { root, path } = await makeWorkspace()
    const config: CodexConfig = {
      command: `node ${JSON.stringify(fakeAppServer)} spawn-grandchild`,
      approvalPolicy: 'never',
      threadSandbox: 'workspace-write',
      turnSandboxPolicy: null,
      turnTimeoutMs: 60_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 0,
    }
    const fiber = Effect.runFork(
      runAgent({
        issue,
        workspace: { path, key: 'issue-14', createdNow: false },
        workspaceRoot: root,
        config,
        prompt: 'do the work',
        maxTurns: 1,
        secretEnvironmentNames: [],
        refreshIssue: () => Effect.succeed(null),
        isRoutable: () => false,
        onEvent: () => undefined,
      }),
    )
    const pidFile = join(path, 'grandchild.pid')
    await waitFor(() => existsSync(pidFile))
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim())

    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(grandchild).toBeGreaterThan(0)
    expect(processIsAlive(grandchild)).toBe(false)
  }, 30_000)
})
