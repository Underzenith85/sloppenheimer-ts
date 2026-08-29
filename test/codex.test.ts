import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CodexConnection,
  makeCodexEnvironment,
  type CodexProcess,
  type CodexRuntime,
} from '../src/codex.js'
import type { JsonObject, JsonValue, Workspace } from '../src/domain.js'
import type { AgentError } from '../src/errors.js'
import type { CodexConfig } from '../src/workflow.js'

const config: CodexConfig = {
  command: 'fake app-server',
  approvalPolicy: 'never',
  threadSandbox: 'workspace-write',
  turnSandboxPolicy: null,
  turnTimeoutMs: 1_000,
  readTimeoutMs: 500,
  stallTimeoutMs: 30_000,
}

const workspace: Workspace = { path: '/tmp/symphony-test', key: 'test', createdNow: false }

const objectFrom = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

class FakeCodexProcess implements CodexProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 42
  readonly #events = new EventEmitter()
  #input = ''
  exitCode: number | null = null
  respondToInitialize = true
  completeTurnImmediately = false
  rejectTurnStart = false

  constructor() {
    this.stdin.on('data', (chunk: Buffer) => {
      this.#input += chunk.toString('utf8')
      for (;;) {
        const newline = this.#input.indexOf('\n')
        if (newline < 0) {
          break
        }
        const line = this.#input.slice(0, newline)
        this.#input = this.#input.slice(newline + 1)
        this.#handleInput(line)
      }
    })
  }

  onceError(listener: (error: Error) => void): void {
    this.#events.once('error', listener)
  }

  onceExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#events.once('exit', listener)
  }

  kill(_signal: NodeJS.Signals): boolean {
    return true
  }

  notify(method: string, params: JsonObject = {}): void {
    this.#send({ method, params })
  }

  malformed(): void {
    this.stdout.write('{not json}\n')
  }

  requestInput(): void {
    this.#send({ id: 99, method: 'item/tool/requestUserInput', params: {} })
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code
    this.#events.emit('exit', code, signal)
  }

  #handleInput(line: string): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(line) as unknown
    } catch {
      return
    }
    const message = objectFrom(decoded)
    if (message === null || typeof message['id'] !== 'number') {
      return
    }
    const id = message['id']
    const method = message['method']
    if (method === 'initialize' && this.respondToInitialize) {
      this.#respond(id, {})
    } else if (method === 'thread/start') {
      this.#respond(id, { thread: { id: 'thread-1' } })
    } else if (method === 'turn/start') {
      if (this.rejectTurnStart) {
        this.#send({ id, error: { code: -32000, message: 'turn rejected' } })
        return
      }
      this.#respond(id, { turn: { id: 'turn-1' } })
      if (this.completeTurnImmediately) {
        this.notify('turn/completed', {
          turn: { id: 'turn-1', status: 'completed' },
        })
      }
    }
  }

  #respond(id: number, result: JsonValue): void {
    this.#send({ id, result })
  }

  #send(message: JsonObject): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }
}

const makeHarness = (
  process: FakeCodexProcess,
  exitOnSignal: NodeJS.Signals | null = 'SIGTERM',
): Readonly<{
  connection: CodexConnection
  signals: NodeJS.Signals[]
}> => {
  const signals: NodeJS.Signals[] = []
  let treeAlive = true
  const runtime: CodexRuntime = {
    spawn: () => process,
    signalProcessTree: (_child, signal) => {
      if (!treeAlive) {
        return false
      }
      signals.push(signal)
      if (signal === exitOnSignal) {
        treeAlive = false
        process.exit(null, signal)
      }
      return true
    },
    shutdownGraceMs: 5_000,
    forceKillWaitMs: 1_000,
  }
  return {
    connection: new CodexConnection(config.command, workspace.path, config, [], () => {}, runtime),
    signals,
  }
}

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
  }
}

const categoryOf = (error: unknown): AgentError['category'] | null => {
  const candidate = objectFrom(error)
  return candidate !== null && typeof candidate['category'] === 'string'
    ? (candidate['category'] as AgentError['category'])
    : null
}

const startupCategory = (cwd: string, cause: Error): AgentError['category'] | null => {
  const runtime: CodexRuntime = {
    spawn: () => {
      throw cause
    },
    signalProcessTree: () => false,
    shutdownGraceMs: 5_000,
    forceKillWaitMs: 1_000,
  }
  try {
    new CodexConnection(config.command, cwd, config, [], () => {}, runtime)
    return null
  } catch (error: unknown) {
    return categoryOf(error)
  }
}

afterEach((): void => {
  vi.useRealTimers()
})

describe('Codex child environment', (): void => {
  it('removes custom tracker secrets and every GitHub authentication alias', (): void => {
    const secret = 'custom-tracker-secret'
    const environment = makeCodexEnvironment(
      {
        CUSTOM_GITHUB_TOKEN: secret,
        GITHUB_TOKEN: 'github-token',
        GH_TOKEN: 'gh-token',
        SAFE_VALUE: 'visible',
      },
      ['CUSTOM_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'],
    )

    expect(environment).toEqual({ SAFE_VALUE: 'visible' })
    expect(JSON.stringify(environment)).not.toContain(secret)
  })

  it('never removes authentication sources required by Codex itself', (): void => {
    const environment = makeCodexEnvironment(
      {
        OPENAI_API_KEY: 'openai-key',
        CODEX_ACCESS_TOKEN: 'codex-access-token',
        CUSTOM_GITHUB_TOKEN: 'tracker-token',
      },
      ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CUSTOM_GITHUB_TOKEN'],
    )

    expect(environment).toEqual({
      OPENAI_API_KEY: 'openai-key',
      CODEX_ACCESS_TOKEN: 'codex-access-token',
    })
  })
})

describe('Codex app-server lifecycle', (): void => {
  it('maps missing executable and invalid cwd startup failures', (): void => {
    const missing = Object.assign(new Error('spawn failed'), { code: 'ENOENT' })

    expect(startupCategory('/tmp', missing)).toBe('codex_not_found')
    expect(startupCategory('/tmp/symphony-ts-missing-cwd-issue-15', missing)).toBe(
      'invalid_workspace_cwd',
    )
  })

  it('keeps an active turn alive by resetting silence timeout on valid output', async (): Promise<void> => {
    vi.useFakeTimers()
    const process = new FakeCodexProcess()
    const { connection } = makeHarness(process)
    const threadId = await connection.initialize(config, workspace)
    const turn = connection.runTurn(threadId, workspace, config, 'work')
    await flushPromises()

    await vi.advanceTimersByTimeAsync(900)
    process.notify('item/started', { item: { id: 'one' } })
    await vi.advanceTimersByTimeAsync(900)
    process.notify('item/completed', { item: { id: 'one' } })
    await vi.advanceTimersByTimeAsync(900)
    process.notify('turn/completed', {
      turn: { id: 'turn-1', status: 'completed' },
    })

    await expect(turn).resolves.toBe('turn-1')
    await connection.stop()
  })

  it('settles a turn that completes in the same read batch as turn/start', async (): Promise<void> => {
    vi.useFakeTimers()
    const process = new FakeCodexProcess()
    process.completeTurnImmediately = true
    const { connection } = makeHarness(process)
    const threadId = await connection.initialize(config, workspace)

    await expect(connection.runTurn(threadId, workspace, config, 'work')).resolves.toBe('turn-1')
    await connection.stop()
  })

  it('times out a silent turn and ignores malformed output as activity', async (): Promise<void> => {
    vi.useFakeTimers()
    const process = new FakeCodexProcess()
    const { connection } = makeHarness(process)
    const threadId = await connection.initialize(config, workspace)
    const turn = connection.runTurn(threadId, workspace, config, 'work')
    const rejection = turn.catch((error: unknown) => categoryOf(error))
    await flushPromises()

    await vi.advanceTimersByTimeAsync(900)
    process.malformed()
    await vi.advanceTimersByTimeAsync(100)

    await expect(rejection).resolves.toBe('turn_timeout')
    await connection.stop()
  })

  it('maps a startup request timeout to response_timeout', async (): Promise<void> => {
    vi.useFakeTimers()
    const process = new FakeCodexProcess()
    process.respondToInitialize = false
    const { connection } = makeHarness(process)
    const initialization = connection
      .initialize(config, workspace)
      .catch((error: unknown) => categoryOf(error))

    await vi.advanceTimersByTimeAsync(config.readTimeoutMs)

    await expect(initialization).resolves.toBe('response_timeout')
    await connection.stop()
  })

  it('maps an abnormal app-server exit to port_exit', async (): Promise<void> => {
    vi.useFakeTimers()
    const process = new FakeCodexProcess()
    const { connection } = makeHarness(process)
    const threadId = await connection.initialize(config, workspace)
    const turn = connection
      .runTurn(threadId, workspace, config, 'work')
      .catch((error: unknown) => categoryOf(error))
    await flushPromises()

    process.exit(17, null)

    await expect(turn).resolves.toBe('port_exit')
    await connection.stop()
  })

  it('maps a protocol response error to response_error', async (): Promise<void> => {
    vi.useFakeTimers()
    const process = new FakeCodexProcess()
    process.rejectTurnStart = true
    const { connection } = makeHarness(process)
    const threadId = await connection.initialize(config, workspace)

    await expect(
      connection
        .runTurn(threadId, workspace, config, 'work')
        .catch((error: unknown) => categoryOf(error)),
    ).resolves.toBe('response_error')
    await connection.stop()
  })

  it('maps an interactive request to turn_input_required', async (): Promise<void> => {
    vi.useFakeTimers()
    const process = new FakeCodexProcess()
    const { connection } = makeHarness(process)
    const threadId = await connection.initialize(config, workspace)
    const turn = connection
      .runTurn(threadId, workspace, config, 'work')
      .catch((error: unknown) => categoryOf(error))
    await flushPromises()

    process.requestInput()

    await expect(turn).resolves.toBe('turn_input_required')
    await connection.stop()
  })

  it('maps cancellation reported by the app-server to turn_cancelled', async (): Promise<void> => {
    vi.useFakeTimers()
    const process = new FakeCodexProcess()
    const { connection } = makeHarness(process)
    const threadId = await connection.initialize(config, workspace)
    const turn = connection
      .runTurn(threadId, workspace, config, 'work')
      .catch((error: unknown) => categoryOf(error))
    await flushPromises()

    process.notify('turn/completed', {
      turn: { id: 'turn-1', status: 'cancelled' },
    })

    await expect(turn).resolves.toBe('turn_cancelled')
    await connection.stop()
  })

  it('settles active work once and escalates graceful process-tree shutdown', async (): Promise<void> => {
    vi.useFakeTimers()
    const process = new FakeCodexProcess()
    const { connection, signals } = makeHarness(process, 'SIGKILL')
    const threadId = await connection.initialize(config, workspace)
    const turn = connection
      .runTurn(threadId, workspace, config, 'work')
      .catch((error: unknown) => categoryOf(error))
    await flushPromises()

    const firstStop = connection.stop()
    const secondStop = connection.stop()
    await expect(turn).resolves.toBe('turn_cancelled')
    expect(signals).toEqual(['SIGTERM'])

    await vi.advanceTimersByTimeAsync(5_000)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    await expect(Promise.all([firstStop, secondStop])).resolves.toEqual([undefined, undefined])
  })

  it('settles a pending request once when shutdown is repeated', async (): Promise<void> => {
    vi.useFakeTimers()
    const process = new FakeCodexProcess()
    process.respondToInitialize = false
    const { connection } = makeHarness(process)
    const initialization = connection
      .initialize(config, workspace)
      .catch((error: unknown) => categoryOf(error))

    const firstStop = connection.stop()
    const secondStop = connection.stop()

    await expect(initialization).resolves.toBe('turn_cancelled')
    await expect(Promise.all([firstStop, secondStop])).resolves.toEqual([undefined, undefined])
  })

  it('stops the process tree with SIGTERM when graceful shutdown succeeds', async (): Promise<void> => {
    vi.useFakeTimers()
    const process = new FakeCodexProcess()
    const { connection, signals } = makeHarness(process)
    await connection.initialize(config, workspace)

    await connection.stop()

    expect(signals).toEqual(['SIGTERM'])
  })
})
