import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { Effect } from 'effect'

import type { Issue, JsonObject, JsonValue, Workspace } from './domain.js'
import { AgentError } from './errors.js'
import type { CodexConfig } from './workflow.js'

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

type TurnWaiter = Readonly<{
  resolve: () => void
  reject: (error: AgentError) => void
  timeout: NodeJS.Timeout
}>

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

class CodexConnection {
  readonly #process: ChildProcessWithoutNullStreams
  readonly #lines: Interface
  readonly #readTimeoutMs: number
  readonly #turnTimeoutMs: number
  readonly #onEvent: (event: AgentEvent) => void
  readonly #pending = new Map<number, PendingRequest>()
  readonly #turns = new Map<string, TurnWaiter>()
  #nextId = 1
  #closed = false

  constructor(
    command: string,
    cwd: string,
    config: CodexConfig,
    secretEnvironmentNames: readonly string[],
    onEvent: (event: AgentEvent) => void,
  ) {
    const blockedEnvironmentNames = new Set(secretEnvironmentNames)
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !blockedEnvironmentNames.has(name)),
    )
    this.#process = spawn('bash', ['-lc', command], {
      cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
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
    this.#process.once('error', (cause) => {
      this.#failAll(
        new AgentError({ category: 'spawn_failed', message: 'Codex process failed', cause }),
      )
    })
    this.#process.once('exit', (code) => {
      if (!this.#closed) {
        this.#failAll(
          new AgentError({
            category: 'process_exited',
            message: `Codex process exited with ${String(code)}`,
          }),
        )
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
        category: 'protocol_error',
        message: 'thread/start returned no thread id',
      })
    }
    return result['thread']['id']
  }

  async runTurn(
    threadId: string,
    workspace: Workspace,
    config: CodexConfig,
    prompt: string,
  ): Promise<string> {
    const result = await this.#request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      cwd: workspace.path,
      approvalPolicy: config.approvalPolicy,
      sandboxPolicy: {
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
        category: 'protocol_error',
        message: 'turn/start returned no turn id',
      })
    }
    const turnId = result['turn']['id']
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.#turns.delete(turnId)
        rejectPromise(
          new AgentError({ category: 'turn_timeout', message: `turn ${turnId} timed out` }),
        )
      }, this.#turnTimeoutMs)
      this.#turns.set(turnId, { resolve: resolvePromise, reject: rejectPromise, timeout })
    })
    return turnId
  }

  async stop(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#lines.close()
    this.#process.stdin.end()
    this.#process.kill('SIGTERM')
    await new Promise<void>((resolvePromise) => {
      if (this.#process.exitCode !== null) {
        resolvePromise()
      } else {
        const timeout = setTimeout(() => {
          this.#process.kill('SIGKILL')
          resolvePromise()
        }, 5_000)
        this.#process.once('exit', () => {
          clearTimeout(timeout)
          resolvePromise()
        })
      }
    })
  }

  #request(method: string, params: JsonObject): Promise<JsonValue> {
    const id = this.#nextId++
    this.#write({ id, method, params })
    return new Promise<JsonValue>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        rejectPromise(
          new AgentError({ category: 'read_timeout', message: `${method} response timed out` }),
        )
      }, this.#readTimeoutMs)
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout })
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
    if (Buffer.byteLength(line, 'utf8') > 10 * 1024 * 1024) {
      this.#failAll(
        new AgentError({
          category: 'protocol_error',
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
    if (
      typeof id === 'number' &&
      (parsed['result'] !== undefined || parsed['error'] !== undefined)
    ) {
      const pending = this.#pending.get(id)
      if (pending === undefined) {
        return
      }
      clearTimeout(pending.timeout)
      this.#pending.delete(id)
      const error = parsed['error']
      if (error !== undefined) {
        pending.reject(new AgentError({ category: 'protocol_error', message: errorMessage(error) }))
      } else {
        const result = parsed['result']
        if (result === undefined) {
          pending.reject(
            new AgentError({
              category: 'protocol_error',
              message: 'JSON-RPC response has no result',
            }),
          )
        } else {
          pending.resolve(result)
        }
      }
      return
    }
    const method = parsed['method']
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
      this.#failTurns(
        new AgentError({
          category: 'input_required',
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
      return
    }
    clearTimeout(waiter.timeout)
    this.#turns.delete(turnId)
    if (status === 'completed') {
      waiter.resolve()
    } else {
      waiter.reject(
        new AgentError({
          category: 'turn_failed',
          message: `turn ${turnId} finished with status ${status}`,
        }),
      )
    }
  }

  #emit(event: string, message: string): void {
    this.#onEvent({ event, timestamp: new Date(), processId: this.processId, message, usage: null })
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
                  category: 'protocol_error',
                  message: `Codex session failed for ${issue.identifier}`,
                  cause,
                }),
        }),
      ),
    ),
  )
