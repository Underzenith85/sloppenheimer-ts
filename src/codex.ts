import { spawn, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { Effect } from 'effect'

import type { Issue, JsonObject, JsonValue, Workspace } from './domain.js'
import { codexAuthenticationEnvironmentNames } from './env-reference.js'
import { AgentError } from './errors.js'
import type { CodexConfig } from './workflow.js'

export const makeCodexEnvironment = (
  environment: NodeJS.ProcessEnv,
  secretEnvironmentNames: readonly string[],
): NodeJS.ProcessEnv => {
  const blockedEnvironmentNames = new Set(
    secretEnvironmentNames.filter((name) => !codexAuthenticationEnvironmentNames.has(name)),
  )
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !blockedEnvironmentNames.has(name)),
  )
}

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }
  if (typeof value !== 'object') {
    return false
  }
  return Object.values(value).every(isJsonValue)
}

export type AgentEvent = Readonly<{
  event: string
  timestamp: Date
  processId: number | null
  message: string | null
  usage: Readonly<{
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }> | null
}>

export type AgentResult = Readonly<{
  threadId: string
  turnId: string
  turnCount: number
}>

type PendingRequest = Readonly<{
  resolve: (value: JsonValue) => void
  reject: (error: AgentError) => void
  timeout: NodeJS.Timeout
}>

type TurnWaiter = {
  resolve: () => void
  reject: (error: AgentError) => void
  timeout: NodeJS.Timeout
}

export type CodexProcess = Readonly<{
  stdin: Writable
  stdout: Readable
  stderr: Readable
  pid: number | undefined
  exitCode: number | null
  onceError: (listener: (error: Error) => void) => void
  onceExit: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void
  kill: (signal: NodeJS.Signals) => boolean
}>

export type CodexRuntime = Readonly<{
  spawn: (command: string, cwd: string, environment: NodeJS.ProcessEnv) => CodexProcess
  signalProcessTree: (child: CodexProcess, signal: NodeJS.Signals) => boolean
  shutdownGraceMs: number
  forceKillWaitMs: number
}>

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const startupError = (cwd: string, cause: unknown): AgentError => {
  if (!isDirectory(cwd)) {
    return new AgentError({
      category: 'invalid_workspace_cwd',
      message: `Codex workspace cwd is not a directory: ${cwd}`,
      cause,
    })
  }
  if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT') {
    return new AgentError({
      category: 'codex_not_found',
      message: 'Codex app-server executable was not found',
      cause,
    })
  }
  return new AgentError({
    category: 'response_error',
    message: 'Codex app-server failed to start',
    cause,
  })
}

const signalProcessTree = (child: CodexProcess, signal: NodeJS.Signals): boolean => {
  if (child.pid === undefined) {
    return child.kill(signal)
  }
  if (process.platform === 'win32') {
    const result = spawnSync(
      'taskkill',
      signal === 'SIGKILL'
        ? ['/pid', String(child.pid), '/t', '/f']
        : ['/pid', String(child.pid), '/t'],
      { windowsHide: true },
    )
    return result.status === 0
  }
  try {
    process.kill(-child.pid, signal)
    return true
  } catch (cause: unknown) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ESRCH') {
      return false
    }
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }
}

const defaultCodexRuntime: CodexRuntime = {
  spawn: (command, cwd, environment) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      get pid(): number | undefined {
        return child.pid
      },
      get exitCode(): number | null {
        return child.exitCode
      },
      onceError: (listener) => {
        child.once('error', listener)
      },
      onceExit: (listener) => {
        child.once('exit', listener)
      },
      kill: (signal) => child.kill(signal),
    }
  },
  signalProcessTree,
  shutdownGraceMs: 5_000,
  forceKillWaitMs: 1_000,
}

const errorMessage = (value: JsonValue): string => {
  if (!isJsonObject(value)) {
    return 'unknown protocol error'
  }
  const message = value['message']
  return typeof message === 'string' ? message : 'unknown protocol error'
}

const usageFrom = (message: JsonObject): AgentEvent['usage'] => {
  const params = message['params']
  if (!isJsonObject(params)) {
    return null
  }
  const usage = params['usage']
  if (!isJsonObject(usage)) {
    return null
  }
  const input = usage['inputTokens']
  const output = usage['outputTokens']
  const total = usage['totalTokens']
  return typeof input === 'number' && typeof output === 'number' && typeof total === 'number'
    ? { inputTokens: input, outputTokens: output, totalTokens: total }
    : null
}

export class CodexConnection {
  readonly #process: CodexProcess
  readonly #lines: Interface
  readonly #runtime: CodexRuntime
  readonly #readTimeoutMs: number
  readonly #turnTimeoutMs: number
  readonly #onEvent: (event: AgentEvent) => void
  readonly #pending = new Map<number, PendingRequest>()
  readonly #turns = new Map<string, TurnWaiter>()
  #nextId = 1
  #closed = false
  #initialized = false
  #processTerminated = false
  #terminalError: AgentError | null = null
  #stopPromise: Promise<void> | null = null
  #awaitingTurnIdentity = false
  readonly #earlyTurnOutcomes = new Map<string, AgentError | null>()

  constructor(
    command: string,
    cwd: string,
    config: CodexConfig,
    secretEnvironmentNames: readonly string[],
    onEvent: (event: AgentEvent) => void,
    runtime: CodexRuntime = defaultCodexRuntime,
  ) {
    this.#runtime = runtime
    try {
      this.#process = runtime.spawn(
        command,
        cwd,
        makeCodexEnvironment(process.env, secretEnvironmentNames),
      )
    } catch (cause: unknown) {
      throw startupError(cwd, cause)
    }
    this.#readTimeoutMs = config.readTimeoutMs
    this.#turnTimeoutMs = config.turnTimeoutMs
    this.#onEvent = onEvent
    this.#lines = createInterface({ input: this.#process.stdout, crlfDelay: Infinity })
    this.#lines.on('line', (line) => {
      this.#receiveLine(line)
    })
    this.#process.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message.length > 0) {
        this.#emit('diagnostic', message)
      }
    })
    this.#process.onceError((cause) => {
      this.#processTerminated = true
      this.#close(
        this.#initialized
          ? new AgentError({
              category: 'response_error',
              message: 'Codex app-server process failed',
              cause,
            })
          : startupError(cwd, cause),
      )
    })
    this.#process.onceExit((code, signal) => {
      this.#processTerminated = true
      if (!this.#closed) {
        const error =
          !this.#initialized && code === 127
            ? new AgentError({
                category: 'codex_not_found',
                message: 'Codex app-server executable was not found',
              })
            : new AgentError({
                category: 'port_exit',
                message: `Codex app-server exited with code ${String(code)} and signal ${String(signal)}`,
              })
        this.#close(error)
      }
    })
  }

  get processId(): number | null {
    return this.#process.pid ?? null
  }

  async initialize(config: CodexConfig, workspace: Workspace): Promise<string> {
    await this.#request('initialize', {
      clientInfo: { name: 'symphony_ts', title: 'Symphony TypeScript', version: '0.1.0' },
    })
    this.#notify('initialized', {})
    const result = await this.#request('thread/start', {
      cwd: workspace.path,
      approvalPolicy: config.approvalPolicy,
      sandbox: config.threadSandbox,
      serviceName: 'symphony_ts',
    })
    if (
      !isJsonObject(result) ||
      !isJsonObject(result['thread']) ||
      typeof result['thread']['id'] !== 'string'
    ) {
      throw new AgentError({
        category: 'response_error',
        message: 'thread/start returned no thread id',
      })
    }
    this.#initialized = true
    return result['thread']['id']
  }

  async runTurn(
    threadId: string,
    workspace: Workspace,
    config: CodexConfig,
    prompt: string,
  ): Promise<string> {
    if (this.#awaitingTurnIdentity || this.#turns.size > 0) {
      throw new AgentError({
        category: 'response_error',
        message: 'Codex connection already has an active turn',
      })
    }
    this.#awaitingTurnIdentity = true
    try {
      const result = await this.#request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd: workspace.path,
        approvalPolicy: config.approvalPolicy,
        sandboxPolicy: config.turnSandboxPolicy ?? {
          type: 'workspaceWrite',
          writableRoots: [workspace.path],
          networkAccess: true,
        },
      })
      if (
        !isJsonObject(result) ||
        !isJsonObject(result['turn']) ||
        typeof result['turn']['id'] !== 'string'
      ) {
        throw new AgentError({
          category: 'response_error',
          message: 'turn/start returned no turn id',
        })
      }
      if (this.#closed) {
        throw (
          this.#terminalError ??
          new AgentError({ category: 'response_error', message: 'Codex connection is closed' })
        )
      }
      const turnId = result['turn']['id']
      const earlyOutcome = this.#earlyTurnOutcomes.get(turnId)
      if (earlyOutcome !== undefined || this.#earlyTurnOutcomes.has(turnId)) {
        this.#earlyTurnOutcomes.delete(turnId)
        if (earlyOutcome !== null) {
          throw earlyOutcome
        }
        return turnId
      }
      const completion = new Promise<void>((resolvePromise, rejectPromise) => {
        const timeout = this.#makeTurnTimeout(turnId)
        this.#turns.set(turnId, { resolve: resolvePromise, reject: rejectPromise, timeout })
      })
      this.#awaitingTurnIdentity = false
      await completion
      return turnId
    } finally {
      this.#awaitingTurnIdentity = false
      this.#earlyTurnOutcomes.clear()
    }
  }

  async stop(): Promise<void> {
    if (this.#stopPromise === null) {
      this.#stopPromise = this.#performStop()
    }
    await this.#stopPromise
  }

  async #performStop(): Promise<void> {
    if (!this.#closed) {
      this.#close(
        new AgentError({
          category: 'turn_cancelled',
          message: 'Codex app-server session was cancelled',
        }),
      )
    }
    this.#lines.close()
    this.#process.stdin.end()
    if (!this.#runtime.signalProcessTree(this.#process, 'SIGTERM')) {
      return
    }
    const exited = await this.#waitForExit(this.#runtime.shutdownGraceMs)
    if (exited && !this.#runtime.signalProcessTree(this.#process, 'SIGKILL')) {
      return
    }
    if (!exited) {
      this.#runtime.signalProcessTree(this.#process, 'SIGKILL')
    }
    await this.#waitForExit(this.#runtime.forceKillWaitMs)
  }

  #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#processTerminated || this.#process.exitCode !== null) {
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolvePromise) => {
      let settled = false
      let timeout: NodeJS.Timeout | null = null
      const settle = (exited: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        if (timeout !== null) {
          clearTimeout(timeout)
        }
        resolvePromise(exited)
      }
      timeout = setTimeout(() => {
        settle(false)
      }, timeoutMs)
      this.#process.onceExit(() => {
        settle(true)
      })
    })
  }

  #request(method: string, params: JsonObject): Promise<JsonValue> {
    if (this.#closed) {
      return Promise.reject(
        this.#terminalError ??
          new AgentError({ category: 'response_error', message: 'Codex connection is closed' }),
      )
    }
    const id = this.#nextId++
    return new Promise<JsonValue>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        rejectPromise(
          new AgentError({ category: 'response_timeout', message: `${method} response timed out` }),
        )
      }, this.#readTimeoutMs)
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout })
      try {
        this.#write({ id, method, params })
      } catch (cause: unknown) {
        clearTimeout(timeout)
        this.#pending.delete(id)
        rejectPromise(
          new AgentError({
            category: 'response_error',
            message: `failed to send ${method} request`,
            cause,
          }),
        )
      }
    })
  }

  #notify(method: string, params: JsonObject): void {
    this.#write({ method, params })
  }

  #write(message: JsonObject): void {
    if (this.#closed) {
      return
    }
    this.#process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #receiveLine(line: string): void {
    if (this.#closed) {
      return
    }
    if (Buffer.byteLength(line, 'utf8') > 10 * 1024 * 1024) {
      this.#close(
        new AgentError({
          category: 'response_error',
          message: 'Codex protocol line exceeds 10 MB',
        }),
      )
      return
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(line) as unknown
    } catch {
      this.#emit('malformed', 'Codex emitted malformed JSON')
      return
    }
    if (!isJsonValue(decoded) || !isJsonObject(decoded)) {
      return
    }
    const parsed = decoded
    const id = parsed['id']
    const method = parsed['method']
    const isResponse =
      typeof id === 'number' && (parsed['result'] !== undefined || parsed['error'] !== undefined)
    if (!isResponse && typeof method !== 'string') {
      return
    }
    this.#resetTurnSilenceTimeouts()
    if (isResponse && typeof id === 'number') {
      const pending = this.#pending.get(id)
      if (pending === undefined) {
        return
      }
      clearTimeout(pending.timeout)
      this.#pending.delete(id)
      const error = parsed['error']
      if (error !== undefined) {
        pending.reject(new AgentError({ category: 'response_error', message: errorMessage(error) }))
      } else {
        const result = parsed['result']
        if (result === undefined) {
          pending.reject(
            new AgentError({
              category: 'response_error',
              message: 'JSON-RPC response has no result',
            }),
          )
        } else {
          pending.resolve(result)
        }
      }
      return
    }
    if (typeof method !== 'string') {
      return
    }
    if (typeof id === 'number') {
      this.#handleServerRequest(id, method)
      return
    }
    this.#handleNotification(method, parsed)
  }

  #handleServerRequest(id: number, method: string): void {
    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    ) {
      this.#write({ id, result: { decision: 'acceptForSession' } })
      this.#emit('approval_auto_approved', method)
      return
    }
    if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
      this.#write({
        id,
        error: { code: -32000, message: 'Symphony does not support interactive input' },
      })
      this.#close(
        new AgentError({
          category: 'turn_input_required',
          message: 'Codex requested interactive input',
        }),
      )
      return
    }
    this.#write({ id, error: { code: -32601, message: `Unsupported client request: ${method}` } })
    this.#emit('unsupported_tool_call', method)
  }

  #handleNotification(method: string, message: JsonObject): void {
    this.#onEvent({
      event: method,
      timestamp: new Date(),
      processId: this.processId,
      message: null,
      usage: usageFrom(message),
    })
    if (method !== 'turn/completed') {
      return
    }
    const params = message['params']
    if (!isJsonObject(params) || !isJsonObject(params['turn'])) {
      return
    }
    const turn = params['turn']
    const turnId = turn['id']
    const status = turn['status']
    if (typeof turnId !== 'string' || typeof status !== 'string') {
      return
    }
    const waiter = this.#turns.get(turnId)
    if (waiter === undefined) {
      if (this.#awaitingTurnIdentity) {
        this.#earlyTurnOutcomes.set(turnId, this.#turnOutcome(turnId, status))
      }
      return
    }
    clearTimeout(waiter.timeout)
    this.#turns.delete(turnId)
    const outcome = this.#turnOutcome(turnId, status)
    if (outcome === null) {
      waiter.resolve()
    } else {
      waiter.reject(outcome)
    }
  }

  #turnOutcome(turnId: string, status: string): AgentError | null {
    if (status === 'completed') {
      return null
    }
    if (status === 'cancelled' || status === 'canceled' || status === 'interrupted') {
      return new AgentError({
        category: 'turn_cancelled',
        message: `turn ${turnId} finished with status ${status}`,
      })
    }
    return new AgentError({
      category: 'turn_failed',
      message: `turn ${turnId} finished with status ${status}`,
    })
  }

  #emit(event: string, message: string): void {
    this.#onEvent({ event, timestamp: new Date(), processId: this.processId, message, usage: null })
  }

  #resetTurnSilenceTimeouts(): void {
    for (const [turnId, waiter] of this.#turns) {
      clearTimeout(waiter.timeout)
      waiter.timeout = this.#makeTurnTimeout(turnId)
    }
  }

  #makeTurnTimeout(turnId: string): NodeJS.Timeout {
    return setTimeout(() => {
      const waiter = this.#turns.get(turnId)
      if (waiter === undefined) {
        return
      }
      this.#turns.delete(turnId)
      waiter.reject(
        new AgentError({
          category: 'turn_timeout',
          message: `turn ${turnId} timed out after protocol silence`,
        }),
      )
    }, this.#turnTimeoutMs)
  }

  #failTurns(error: AgentError): void {
    for (const waiter of this.#turns.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
    this.#turns.clear()
  }

  #failAll(error: AgentError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.#pending.clear()
    this.#failTurns(error)
  }

  #close(error: AgentError): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#terminalError = error
    this.#lines.close()
    this.#earlyTurnOutcomes.clear()
    this.#failAll(error)
  }
}

export const runAgent = (
  issue: Issue,
  workspace: Workspace,
  config: CodexConfig,
  prompt: string,
  maxTurns: number,
  secretEnvironmentNames: readonly string[],
  refreshIssue: () => Effect.Effect<Issue | null, AgentError>,
  isRoutable: (issue: Issue) => boolean,
  onEvent: (event: AgentEvent) => void,
): Effect.Effect<AgentResult, AgentError> =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(
        () =>
          new CodexConnection(
            config.command,
            workspace.path,
            config,
            secretEnvironmentNames,
            onEvent,
          ),
      ),
      (connection) => Effect.promise(() => connection.stop()),
    ).pipe(
      Effect.flatMap((connection) =>
        Effect.tryPromise({
          try: async () => {
            const threadId = await connection.initialize(config, workspace)
            let turnId = ''
            let turnCount = 0
            while (turnCount < maxTurns) {
              const turnPrompt =
                turnCount === 0
                  ? prompt
                  : 'Continue working on the issue. Review prior progress and complete the next necessary step.'
              turnId = await connection.runTurn(threadId, workspace, config, turnPrompt)
              turnCount += 1
              const refreshed = await Effect.runPromise(refreshIssue())
              if (refreshed === null || !isRoutable(refreshed)) {
                break
              }
            }
            return { threadId, turnId, turnCount }
          },
          catch: (cause: unknown) =>
            cause instanceof AgentError
              ? cause
              : new AgentError({
                  category: 'response_error',
                  message: `Codex session failed for ${issue.identifier}`,
                  cause,
                }),
        }),
      ),
    ),
  )
