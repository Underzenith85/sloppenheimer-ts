import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
  rateLimits: JsonObject | null
  threadId: string | null
  turnId: string | null
  sessionId: string | null
  issue: Readonly<{
    id: string
    identifier: string
    title: string
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
  threadId: string
  resolve: () => void
  reject: (error: AgentError) => void
  timeout: NodeJS.Timeout
}

type RequestId = string | number

type ClientRequest =
  | Readonly<{
      id: number
      method: 'initialize'
      params: Readonly<{
        clientInfo: Readonly<{ name: string; title: string; version: string }>
      }>
    }>
  | Readonly<{
      id: number
      method: 'thread/start'
      params: Readonly<{
        cwd: string
        approvalPolicy: string
        sandbox: string
        serviceName: string
      }>
    }>
  | Readonly<{
      id: number
      method: 'thread/name/set'
      params: Readonly<{ threadId: string; name: string }>
    }>
  | Readonly<{
      id: number
      method: 'turn/start'
      params: Readonly<{
        threadId: string
        input: readonly Readonly<{ type: 'text'; text: string }>[]
        cwd: string
        approvalPolicy: string
        sandboxPolicy: JsonObject
      }>
    }>

type ClientNotification = Readonly<{ method: 'initialized' }>

type WithoutRequestId<Request> =
  Request extends Readonly<{ id: number }> ? Omit<Request, 'id'> : never

type ClientRequestPayload = WithoutRequestId<ClientRequest>

type ClientResponse =
  | Readonly<{
      id: RequestId
      result:
        | Readonly<{ decision: 'acceptForSession' | 'approved_for_session' }>
        | Readonly<{ permissions: JsonObject; scope: 'session' }>
        | Readonly<{ action: 'decline' }>
        | Readonly<{
            success: false
            contentItems: readonly Readonly<{ type: 'inputText'; text: string }>[]
          }>
    }>
  | Readonly<{
      id: RequestId
      error: Readonly<{ code: number; message: string }>
    }>

type TurnStatus = 'completed' | 'failed' | 'interrupted'

type TurnOutcome = Readonly<{
  status: TurnStatus
  message: string | null
}>

const protocolLineLimit = 10 * 1024 * 1024

const isRequestId = (value: JsonValue | undefined): value is RequestId =>
  typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))

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
  const tokenUsage = params['tokenUsage']
  const usage = isJsonObject(tokenUsage) ? tokenUsage['total'] : params['usage']
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

const rateLimitsFrom = (message: JsonObject): JsonObject | null => {
  const params = message['params']
  return isJsonObject(params) && isJsonObject(params['rateLimits']) ? params['rateLimits'] : null
}

const turnErrorMessage = (turn: JsonObject): string | null => {
  const error = turn['error']
  if (!isJsonObject(error)) {
    return null
  }
  const message = error['message']
  return typeof message === 'string' ? message : null
}

class CodexConnection {
  readonly #process: ChildProcessWithoutNullStreams
  readonly #readTimeoutMs: number
  readonly #turnTimeoutMs: number
  readonly #onEvent: (event: AgentEvent) => void
  readonly #pending = new Map<RequestId, PendingRequest>()
  readonly #turns = new Map<string, TurnWaiter>()
  readonly #earlyTurnOutcomes = new Map<string, TurnOutcome>()
  #nextId = 1
  #closed = false
  #protocolFailed = false
  #protocolBuffer = Buffer.alloc(0)
  #failure: AgentError | null = null

  constructor(
    command: string,
    cwd: string,
    config: CodexConfig,
    secretEnvironmentNames: readonly string[],
    onEvent: (event: AgentEvent) => void,
  ) {
    this.#process = spawn('bash', ['-lc', command], {
      cwd,
      env: makeCodexEnvironment(process.env, secretEnvironmentNames),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#readTimeoutMs = config.readTimeoutMs
    this.#turnTimeoutMs = config.turnTimeoutMs
    this.#onEvent = onEvent
    this.#process.stdout.on('data', (chunk: Buffer) => {
      this.#receiveProtocolChunk(chunk)
    })
    this.#process.stdout.once('end', () => {
      if (this.#protocolBuffer.length > 0 && !this.#protocolFailed && !this.#closed) {
        this.#protocolFailure('Codex protocol stream ended with an incomplete line')
      }
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
    this.#process.once('close', (code) => {
      if (!this.#closed) {
        this.#emit('process_exited', `Codex process exited with ${String(code)}`)
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

  async initialize(config: CodexConfig, workspace: Workspace, issue: Issue): Promise<string> {
    await this.#request({
      method: 'initialize',
      params: {
        clientInfo: { name: 'symphony_ts', title: 'Symphony TypeScript', version: '0.1.0' },
      },
    })
    this.#notify({ method: 'initialized' })
    const result = await this.#request({
      method: 'thread/start',
      params: {
        cwd: workspace.path,
        approvalPolicy: config.approvalPolicy,
        sandbox: config.threadSandbox,
        serviceName: 'symphony_ts',
      },
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
    const threadId = result['thread']['id']
    await this.#request({
      method: 'thread/name/set',
      params: { threadId, name: `${issue.identifier}: ${issue.title}` },
    })
    return threadId
  }

  async runTurn(
    threadId: string,
    workspace: Workspace,
    config: CodexConfig,
    prompt: string,
    issue: Issue,
  ): Promise<string> {
    const result = await this.#request({
      method: 'turn/start',
      params: {
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd: workspace.path,
        approvalPolicy: config.approvalPolicy,
        sandboxPolicy: config.turnSandboxPolicy ?? {
          type: 'workspaceWrite',
          writableRoots: [workspace.path],
          networkAccess: true,
        },
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
    this.#onEvent({
      event: 'session_started',
      timestamp: new Date(),
      processId: this.processId,
      message: `${issue.identifier}: ${issue.title}`,
      usage: null,
      rateLimits: null,
      threadId,
      turnId,
      sessionId: `${threadId}-${turnId}`,
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title },
    })
    await this.#waitForTurn(threadId, turnId)
    return turnId
  }

  async stop(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
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

  #request(request: ClientRequestPayload): Promise<JsonValue> {
    if (this.#failure !== null) {
      return Promise.reject(this.#failure)
    }
    const id = this.#nextId++
    return new Promise<JsonValue>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        rejectPromise(
          new AgentError({
            category: 'read_timeout',
            message: `${request.method} response timed out`,
          }),
        )
      }, this.#readTimeoutMs)
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout })
      const message: ClientRequest = { id, ...request }
      const writeError = this.#write(message)
      if (writeError !== null) {
        clearTimeout(timeout)
        this.#pending.delete(id)
        rejectPromise(writeError)
      }
    })
  }

  #notify(notification: ClientNotification): void {
    const writeError = this.#write(notification)
    if (writeError !== null) {
      this.#failAll(writeError)
    }
  }

  #write(message: ClientRequest | ClientNotification | ClientResponse): AgentError | null {
    if (this.#closed) {
      return new AgentError({ category: 'process_exited', message: 'Codex process is closed' })
    }
    try {
      this.#process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== null && error !== undefined && !this.#closed) {
          this.#failAll(
            new AgentError({
              category: 'process_exited',
              message: 'Failed to write to Codex process',
              cause: error,
            }),
          )
        }
      })
      return null
    } catch (cause: unknown) {
      return new AgentError({
        category: 'process_exited',
        message: 'Failed to write to Codex process',
        cause,
      })
    }
  }

  #receiveProtocolChunk(chunk: Buffer): void {
    if (this.#protocolFailed) {
      return
    }
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline === -1 ? chunk.length : newline
      const segment = chunk.subarray(offset, end)
      if (this.#protocolBuffer.length + segment.length > protocolLineLimit) {
        this.#protocolFailure('Codex protocol line exceeds 10 MB')
        return
      }
      if (segment.length > 0) {
        this.#protocolBuffer = Buffer.concat([this.#protocolBuffer, segment])
      }
      if (newline === -1) {
        return
      }
      const line =
        this.#protocolBuffer.at(-1) === 0x0d
          ? this.#protocolBuffer.subarray(0, this.#protocolBuffer.length - 1)
          : this.#protocolBuffer
      this.#protocolBuffer = Buffer.alloc(0)
      this.#receiveLine(line.toString('utf8'))
      this.#refreshTurnTimeouts()
      offset = newline + 1
    }
  }

  #protocolFailure(message: string): void {
    this.#protocolFailed = true
    const error = new AgentError({ category: 'protocol_error', message })
    this.#emit('malformed', message)
    this.#failAll(error)
    this.#process.kill('SIGTERM')
  }

  #receiveLine(line: string): void {
    if (line.length === 0) {
      this.#emit('malformed', 'Codex emitted an empty protocol line')
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
      this.#emit('malformed', 'Codex emitted a non-object protocol message')
      return
    }
    const parsed = decoded
    const id = parsed['id']
    const hasResult = parsed['result'] !== undefined
    const hasError = parsed['error'] !== undefined
    if (isRequestId(id) && (hasResult || hasError)) {
      const pending = this.#pending.get(id)
      if (pending === undefined) {
        this.#emit('other_message', `Unexpected response id ${String(id)}`)
        return
      }
      clearTimeout(pending.timeout)
      this.#pending.delete(id)
      if (hasResult && hasError) {
        pending.reject(
          new AgentError({
            category: 'protocol_error',
            message: 'JSON-RPC response has both result and error',
          }),
        )
        return
      }
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
    if (typeof method === 'string' && isRequestId(id)) {
      this.#handleServerRequest(id, method, parsed['params'])
      return
    }
    if (typeof method === 'string' && id === undefined) {
      this.#handleNotification(method, parsed)
      return
    }
    if (isRequestId(id)) {
      const pending = this.#pending.get(id)
      if (pending !== undefined) {
        clearTimeout(pending.timeout)
        this.#pending.delete(id)
        pending.reject(
          new AgentError({ category: 'protocol_error', message: 'Malformed JSON-RPC response' }),
        )
      }
    }
    this.#emit('malformed', 'Codex emitted an unrecognized protocol message')
  }

  #handleServerRequest(id: RequestId, method: string, params: JsonValue | undefined): void {
    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    ) {
      this.#write({ id, result: { decision: 'acceptForSession' } })
      this.#emit('approval_auto_approved', method)
      return
    }
    if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
      this.#write({ id, result: { decision: 'approved_for_session' } })
      this.#emit('approval_auto_approved', method)
      return
    }
    if (method === 'item/permissions/requestApproval') {
      const permissions = isJsonObject(params) ? params['permissions'] : undefined
      if (isJsonObject(permissions)) {
        this.#write({ id, result: { permissions, scope: 'session' } })
        this.#emit('approval_auto_approved', method)
      } else {
        this.#write({ id, error: { code: -32602, message: 'Invalid permissions request' } })
        this.#emit('malformed', 'Codex emitted an invalid permissions request')
      }
      return
    }
    if (method === 'item/tool/requestUserInput') {
      this.#write({
        id,
        error: { code: -32000, message: 'Symphony does not support interactive input' },
      })
      const error = new AgentError({
        category: 'input_required',
        message: 'Codex requested interactive input',
      })
      this.#emit('turn_input_required', method)
      this.#failAll(error)
      return
    }
    if (method === 'mcpServer/elicitation/request') {
      this.#write({ id, result: { action: 'decline' } })
      this.#emit('turn_input_required', method)
      return
    }
    if (method === 'item/tool/call') {
      this.#write({
        id,
        result: {
          success: false,
          contentItems: [
            { type: 'inputText', text: 'Symphony does not support this dynamic tool' },
          ],
        },
      })
      this.#emit('unsupported_tool_call', method)
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
      rateLimits: rateLimitsFrom(message),
      threadId: null,
      turnId: null,
      sessionId: null,
      issue: null,
    })
    if (method !== 'turn/completed') {
      return
    }
    const params = message['params']
    if (!isJsonObject(params) || !isJsonObject(params['turn'])) {
      this.#emit('malformed', 'Codex emitted an invalid turn/completed notification')
      return
    }
    const turn = params['turn']
    const turnId = turn['id']
    const status = turn['status']
    if (
      typeof turnId !== 'string' ||
      (status !== 'completed' && status !== 'failed' && status !== 'interrupted')
    ) {
      this.#emit('malformed', 'Codex emitted an invalid turn/completed notification')
      return
    }
    const outcome: TurnOutcome = { status, message: turnErrorMessage(turn) }
    const waiter = this.#turns.get(turnId)
    if (waiter === undefined) {
      if (this.#earlyTurnOutcomes.size >= 128) {
        const oldestTurnId = this.#earlyTurnOutcomes.keys().next().value
        if (oldestTurnId !== undefined) {
          this.#earlyTurnOutcomes.delete(oldestTurnId)
        }
      }
      this.#earlyTurnOutcomes.set(turnId, outcome)
      return
    }
    this.#settleTurn(turnId, waiter, outcome)
  }

  #emit(event: string, message: string): void {
    this.#onEvent({
      event,
      timestamp: new Date(),
      processId: this.processId,
      message,
      usage: null,
      rateLimits: null,
      threadId: null,
      turnId: null,
      sessionId: null,
      issue: null,
    })
  }

  #waitForTurn(threadId: string, turnId: string): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      if (this.#failure !== null) {
        rejectPromise(this.#failure)
        return
      }
      const earlyOutcome = this.#earlyTurnOutcomes.get(turnId)
      if (earlyOutcome !== undefined) {
        this.#earlyTurnOutcomes.delete(turnId)
        const waiter = {
          threadId,
          resolve: resolvePromise,
          reject: rejectPromise,
          timeout: setTimeout(() => undefined, this.#turnTimeoutMs),
        }
        this.#settleTurn(turnId, waiter, earlyOutcome)
        return
      }
      const timeout = this.#turnTimeout(turnId, rejectPromise)
      const waiter: TurnWaiter = {
        threadId,
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout,
      }
      this.#turns.set(turnId, waiter)
    })
  }

  #turnTimeout(turnId: string, reject: (error: AgentError) => void): NodeJS.Timeout {
    return setTimeout(() => {
      this.#turns.delete(turnId)
      reject(new AgentError({ category: 'turn_timeout', message: `turn ${turnId} timed out` }))
    }, this.#turnTimeoutMs)
  }

  #refreshTurnTimeouts(): void {
    for (const [turnId, waiter] of this.#turns) {
      clearTimeout(waiter.timeout)
      waiter.timeout = this.#turnTimeout(turnId, waiter.reject)
    }
  }

  #settleTurn(turnId: string, waiter: TurnWaiter, outcome: TurnOutcome): void {
    clearTimeout(waiter.timeout)
    this.#turns.delete(turnId)
    const common = {
      timestamp: new Date(),
      processId: this.processId,
      usage: null,
      rateLimits: null,
      threadId: waiter.threadId,
      turnId,
      sessionId: `${waiter.threadId}-${turnId}`,
      issue: null,
    }
    if (outcome.status === 'completed') {
      this.#onEvent({ ...common, event: 'turn_completed', message: outcome.message })
      waiter.resolve()
      return
    }
    const event = outcome.status === 'interrupted' ? 'turn_cancelled' : 'turn_failed'
    const message = outcome.message ?? `turn ${turnId} finished with status ${outcome.status}`
    this.#onEvent({ ...common, event, message })
    waiter.reject(
      new AgentError({
        category: outcome.status === 'interrupted' ? 'turn_cancelled' : 'turn_failed',
        message,
      }),
    )
  }

  #failTurns(error: AgentError): void {
    for (const waiter of this.#turns.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
    this.#turns.clear()
  }

  #failAll(error: AgentError): void {
    this.#failure ??= error
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.#pending.clear()
    this.#earlyTurnOutcomes.clear()
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
            const threadId = await connection.initialize(config, workspace, issue)
            let turnId = ''
            let turnCount = 0
            while (turnCount < maxTurns) {
              const turnPrompt =
                turnCount === 0
                  ? prompt
                  : 'Continue working on the issue. Review prior progress and complete the next necessary step.'
              turnId = await connection.runTurn(threadId, workspace, config, turnPrompt, issue)
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
