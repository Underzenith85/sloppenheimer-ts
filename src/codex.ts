import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Effect } from 'effect'

import type { Issue, JsonObject, JsonValue, Workspace } from './domain.js'
import { codexAuthenticationEnvironmentNames } from './env-reference.js'
import { AgentError, type WorkspaceError } from './errors.js'
import type { CodexConfig } from './workflow.js'
import {
  assertWorkspaceIdentity,
  openVerifiedWorkspace,
  type VerifiedWorkspace,
} from './workspace.js'

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

/** The App Server framing limit for one protocol line. */
export const codexMaxLineBytes = 10 * 1024 * 1024
const shutdownGraceMs = 5_000

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

/** Composes the session identity the SPEC reports for a thread and its current turn. */
export const composeSessionId = (threadId: string, turnId: string | null): string =>
  turnId === null ? threadId : `${threadId}:${turnId}`

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
  threadId: string | null
  turnId: string | null
  sessionId: string | null
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

type TurnOutcome = Readonly<{ status: string }>

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

/**
 * Splits a byte stream into protocol lines while enforcing the framing limit on the *pending*
 * buffer, so an unterminated line can never grow without bound before it is rejected.
 */
export const makeLineReader = (
  limitBytes: number,
  onLine: (line: string) => void,
  onOverflow: () => void,
): ((chunk: Buffer) => void) => {
  let pending: Buffer[] = []
  let pendingBytes = 0
  let overflowed = false
  const overflow = (): void => {
    overflowed = true
    pending = []
    pendingBytes = 0
    onOverflow()
  }
  return (chunk: Buffer): void => {
    if (overflowed) {
      return
    }
    pending.push(chunk)
    pendingBytes += chunk.byteLength
    if (chunk.indexOf(0x0a) < 0) {
      // No frame boundary here, so hold the chunk whole. Concatenating on every chunk would make
      // framing quadratic in line size: a permitted 10 MB frame arriving in pipe-sized chunks
      // would copy hundreds of megabytes before its terminator ever showed up.
      if (pendingBytes > limitBytes) {
        overflow()
      }
      return
    }
    let buffer = pending.length === 1 ? chunk : Buffer.concat(pending, pendingBytes)
    pending = []
    pendingBytes = 0
    for (;;) {
      const index = buffer.indexOf(0x0a)
      if (index < 0) {
        break
      }
      const raw = buffer.subarray(0, index)
      buffer = buffer.subarray(index + 1)
      const line = raw.at(-1) === 0x0d ? raw.subarray(0, raw.byteLength - 1) : raw
      if (line.byteLength > limitBytes) {
        overflow()
        return
      }
      onLine(line.toString('utf8'))
    }
    if (buffer.byteLength > limitBytes) {
      overflow()
      return
    }
    if (buffer.byteLength > 0) {
      pending.push(buffer)
      pendingBytes = buffer.byteLength
    }
  }
}

const isApprovalRequest = (method: string): boolean => /requestApproval$/u.test(method)
const isUserInputRequest = (method: string): boolean => /requestUserInput$/u.test(method)

class CodexConnection {
  readonly #process: ChildProcessWithoutNullStreams
  readonly #readTimeoutMs: number
  readonly #turnTimeoutMs: number
  readonly #onEvent: (event: AgentEvent) => void
  readonly #pending = new Map<number, PendingRequest>()
  readonly #turns = new Map<string, TurnWaiter>()
  /** Completions that arrived before their waiter existed; drained by `awaitTurn`. */
  readonly #bufferedTurnOutcomes = new Map<string, TurnOutcome>()
  #nextId = 1
  #closed = false
  #terminalError: AgentError | null = null
  /** A turn failure raised before any waiter existed; drained by the next `awaitTurn`. */
  #unattributedTurnFailure: AgentError | null = null
  #threadId: string | null = null
  #turnId: string | null = null

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

    // stdout carries protocol framing only.
    const readStdout = makeLineReader(
      codexMaxLineBytes,
      (line) => {
        this.#receiveLine(line)
      },
      () => {
        this.#fail(
          new AgentError({
            category: 'protocol_error',
            message: `Codex protocol line exceeds ${String(codexMaxLineBytes)} bytes`,
          }),
        )
      },
    )
    this.#process.stdout.on('data', (chunk: Buffer) => {
      readStdout(chunk)
    })

    // stderr is diagnostic only and never parsed as protocol.
    this.#process.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message.length > 0) {
        this.#emit('diagnostic', message)
      }
    })

    this.#process.once('error', (cause) => {
      this.#fail(
        new AgentError({ category: 'spawn_failed', message: 'Codex process failed', cause }),
      )
    })
    this.#process.once('exit', (code, signal) => {
      if (!this.#closed) {
        this.#fail(
          new AgentError({
            category: 'process_exited',
            message:
              signal === null
                ? `Codex process exited with ${String(code)}`
                : `Codex process terminated by ${signal}`,
          }),
        )
      }
    })
  }

  get processId(): number | null {
    return this.#process.pid ?? null
  }

  async initialize(config: CodexConfig, cwd: string): Promise<string> {
    await this.#request('initialize', {
      clientInfo: { name: 'symphony_ts', title: 'Symphony TypeScript', version: '0.1.0' },
    })
    this.#notify('initialized', {})
    const result = await this.#request('thread/start', {
      cwd,
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
    this.#threadId = result['thread']['id']
    return this.#threadId
  }

  async startTurn(
    threadId: string,
    cwd: string,
    config: CodexConfig,
    prompt: string,
  ): Promise<string> {
    const result = await this.#request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      cwd,
      approvalPolicy: config.approvalPolicy,
      sandboxPolicy: config.turnSandboxPolicy ?? {
        type: 'workspaceWrite',
        writableRoots: [cwd],
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
    this.#turnId = result['turn']['id']
    return this.#turnId
  }

  /**
   * Waits for a turn to finish. A completion that arrived before this call — the App Server may
   * emit it in the same batch as the `turn/start` response — is drained from the buffer instead of
   * being lost, and a process that already died fails immediately rather than waiting out the
   * timeout.
   */
  awaitTurn(turnId: string): Promise<void> {
    const buffered = this.#bufferedTurnOutcomes.get(turnId)
    if (buffered !== undefined) {
      this.#bufferedTurnOutcomes.delete(turnId)
      return buffered.status === 'completed'
        ? Promise.resolve()
        : Promise.reject(CodexConnection.#turnFailure(turnId, buffered.status))
    }
    if (this.#terminalError !== null) {
      return Promise.reject(this.#terminalError)
    }
    if (this.#unattributedTurnFailure !== null) {
      const failure = this.#unattributedTurnFailure
      this.#unattributedTurnFailure = null
      return Promise.reject(failure)
    }
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.#turns.delete(turnId)
        rejectPromise(
          new AgentError({ category: 'turn_timeout', message: `turn ${turnId} timed out` }),
        )
      }, this.#turnTimeoutMs)
      this.#turns.set(turnId, { resolve: resolvePromise, reject: rejectPromise, timeout })
    })
  }

  emitSessionStarted(issue: Issue): void {
    this.#onEvent({
      event: 'session_started',
      timestamp: new Date(),
      processId: this.processId,
      message: issue.url,
      usage: null,
      threadId: this.#threadId,
      turnId: this.#turnId,
      sessionId: this.#threadId === null ? null : composeSessionId(this.#threadId, this.#turnId),
    })
  }

  async stop(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#fail(
      new AgentError({ category: 'process_exited', message: 'Codex session was closed' }),
      false,
    )
    this.#process.stdout.removeAllListeners('data')
    this.#process.stderr.removeAllListeners('data')
    this.#process.stdin.end()
    this.#process.kill('SIGTERM')
    await new Promise<void>((resolvePromise) => {
      if (this.#process.exitCode !== null || this.#process.signalCode !== null) {
        resolvePromise()
        return
      }
      const timeout = setTimeout(() => {
        this.#process.kill('SIGKILL')
        resolvePromise()
      }, shutdownGraceMs)
      this.#process.once('exit', () => {
        clearTimeout(timeout)
        resolvePromise()
      })
    })
  }

  static #turnFailure(turnId: string, status: string): AgentError {
    return new AgentError({
      category: 'turn_failed',
      message: `turn ${turnId} finished with status ${status}`,
    })
  }

  /** Registers the pending entry before writing, so a response can never arrive unowned. */
  #request(method: string, params: JsonObject): Promise<JsonValue> {
    if (this.#terminalError !== null) {
      return Promise.reject(this.#terminalError)
    }
    const id = this.#nextId
    this.#nextId += 1
    return new Promise<JsonValue>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        rejectPromise(
          new AgentError({ category: 'read_timeout', message: `${method} response timed out` }),
        )
      }, this.#readTimeoutMs)
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout })
      this.#write({ id, method, params })
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
    if (line.trim().length === 0) {
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
    const method = parsed['method']
    if (
      typeof id === 'number' &&
      typeof method !== 'string' &&
      (parsed['result'] !== undefined || parsed['error'] !== undefined)
    ) {
      this.#settleResponse(id, parsed)
      return
    }
    if (typeof method !== 'string') {
      this.#emit('malformed', 'Codex emitted a message with no method or response payload')
      return
    }
    if (typeof id === 'number') {
      this.#handleServerRequest(id, method)
      return
    }
    this.#handleNotification(method, parsed)
  }

  #settleResponse(id: number, parsed: JsonObject): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) {
      this.#emit('unmatched_response', `no pending request for response id ${String(id)}`)
      return
    }
    clearTimeout(pending.timeout)
    this.#pending.delete(id)
    const error = parsed['error']
    if (error !== undefined) {
      pending.reject(new AgentError({ category: 'protocol_error', message: errorMessage(error) }))
      return
    }
    const result = parsed['result']
    if (result === undefined) {
      pending.reject(
        new AgentError({ category: 'protocol_error', message: 'response has no result' }),
      )
      return
    }
    this.#adoptIdentity(result)
    pending.resolve(result)
  }

  /**
   * Adopts the thread and turn ids carried by a response *while settling it*, not in the awaiting
   * continuation. The App Server may batch a `turn/start` response and the notifications it
   * triggers into one stdout chunk; those notifications are dispatched synchronously by the line
   * reader, long before any `await` resumes, so an id adopted by the awaiter would arrive too late
   * and every batched notification would report the previous turn — or none at all.
   */
  #adoptIdentity(result: JsonValue): void {
    if (!isJsonObject(result)) {
      return
    }
    const thread = result['thread']
    if (isJsonObject(thread) && typeof thread['id'] === 'string') {
      this.#threadId = thread['id']
    }
    const turn = result['turn']
    if (isJsonObject(turn) && typeof turn['id'] === 'string') {
      this.#turnId = turn['id']
    }
  }

  #handleServerRequest(id: number, method: string): void {
    if (isApprovalRequest(method)) {
      this.#write({ id, result: { decision: 'acceptForSession' } })
      this.#emit('approval_auto_approved', method)
      return
    }
    if (isUserInputRequest(method)) {
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
    const turn = this.#turnFrom(message)
    this.#onEvent({
      event: method,
      timestamp: new Date(),
      processId: this.processId,
      message: null,
      usage: usageFrom(message),
      threadId: this.#threadId,
      turnId: turn?.id ?? this.#turnId,
      sessionId:
        this.#threadId === null ? null : composeSessionId(this.#threadId, turn?.id ?? this.#turnId),
    })
    if (method !== 'turn/completed' && method !== 'turn/failed') {
      return
    }
    if (turn === null) {
      return
    }
    this.#settleTurn(turn.id, { status: method === 'turn/failed' ? 'failed' : turn.status })
  }

  #turnFrom(message: JsonObject): Readonly<{ id: string; status: string }> | null {
    const params = message['params']
    if (!isJsonObject(params) || !isJsonObject(params['turn'])) {
      return null
    }
    const turn = params['turn']
    const id = turn['id']
    if (typeof id !== 'string') {
      return null
    }
    const status = turn['status']
    return { id, status: typeof status === 'string' ? status : 'completed' }
  }

  #settleTurn(turnId: string, outcome: TurnOutcome): void {
    const waiter = this.#turns.get(turnId)
    if (waiter === undefined) {
      this.#bufferedTurnOutcomes.set(turnId, outcome)
      return
    }
    clearTimeout(waiter.timeout)
    this.#turns.delete(turnId)
    if (outcome.status === 'completed') {
      waiter.resolve()
      return
    }
    waiter.reject(CodexConnection.#turnFailure(turnId, outcome.status))
  }

  #emit(event: string, message: string): void {
    this.#onEvent({
      event,
      timestamp: new Date(),
      processId: this.processId,
      message,
      usage: null,
      threadId: this.#threadId,
      turnId: this.#turnId,
      sessionId: this.#threadId === null ? null : composeSessionId(this.#threadId, this.#turnId),
    })
  }

  #failTurns(error: AgentError): void {
    if (this.#turns.size === 0) {
      this.#unattributedTurnFailure ??= error
      return
    }
    for (const waiter of this.#turns.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
    this.#turns.clear()
  }

  /** Settles every outstanding request and turn exactly once and records the terminal reason. */
  #fail(error: AgentError, remember = true): void {
    if (remember && this.#terminalError === null) {
      this.#terminalError = error
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.#pending.clear()
    this.#failTurns(error)
    this.#bufferedTurnOutcomes.clear()
  }
}

export type AgentLaunch = Readonly<{
  issue: Issue
  workspace: Workspace
  /** The configured workspace root; containment is re-verified against it at launch. */
  workspaceRoot: string
  config: CodexConfig
  prompt: string
  maxTurns: number
  secretEnvironmentNames: readonly string[]
  refreshIssue: () => Effect.Effect<Issue | null, AgentError>
  isRoutable: (issue: Issue) => boolean
  onEvent: (event: AgentEvent) => void
}>

const rejectWorkspaceLaunch = (error: WorkspaceError): AgentError =>
  new AgentError({
    category: 'workspace_rejected',
    message: `refusing to launch Codex: ${error.message}`,
    cause: error,
  })

const runVerifiedAgent = (
  launch: AgentLaunch,
  verified: VerifiedWorkspace,
): Effect.Effect<AgentResult, AgentError> => {
  /**
   * A path string is re-resolved by the kernel at every consumer, so the identity is re-bound at
   * each path-consuming boundary: after the process is created and before every turn. A directory
   * renamed and replaced by a symlink in between is rejected rather than followed.
   */
  const rebind = (): Promise<void> =>
    Effect.runPromise(
      assertWorkspaceIdentity(launch.workspaceRoot, verified).pipe(
        Effect.mapError(rejectWorkspaceLaunch),
      ),
    )

  return Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(
        () =>
          new CodexConnection(
            launch.config.command,
            verified.path,
            launch.config,
            launch.secretEnvironmentNames,
            launch.onEvent,
          ),
      ),
      (connection) => Effect.promise(() => connection.stop()),
    ).pipe(
      Effect.flatMap((connection) =>
        Effect.tryPromise({
          try: async () => {
            await rebind()
            const threadId = await connection.initialize(launch.config, verified.path)
            // Re-bound after the boundary too: a swap during the request window is then detected
            // and the session torn down before any turn runs.
            await rebind()
            let turnId = ''
            let turnCount = 0
            while (turnCount < launch.maxTurns) {
              const turnPrompt =
                turnCount === 0
                  ? launch.prompt
                  : 'Continue working on the issue. Review prior progress and complete the next necessary step.'
              await rebind()
              turnId = await connection.startTurn(
                threadId,
                verified.path,
                launch.config,
                turnPrompt,
              )
              await rebind()
              if (turnCount === 0) {
                connection.emitSessionStarted(launch.issue)
              }
              await connection.awaitTurn(turnId)
              turnCount += 1
              const refreshed = await Effect.runPromise(launch.refreshIssue())
              if (refreshed === null || !launch.isRoutable(refreshed)) {
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
                  message: `Codex session failed for ${launch.issue.identifier}`,
                  cause,
                }),
        }),
      ),
    ),
  )
}

/**
 * Launches Codex for one issue.
 *
 * Workspace containment is verified against the configured root immediately before the process is
 * created, and the verified real path — not the caller-supplied one — becomes the subprocess cwd
 * and the thread/turn `cwd`. Because a path string is re-resolved by the kernel at every consumer,
 * the verified directory's identity is re-bound after the process is created and before every
 * turn, so a stale, forged, or substituted workspace can never be entered.
 */
export const runAgent = (launch: AgentLaunch): Effect.Effect<AgentResult, AgentError> =>
  Effect.scoped(
    openVerifiedWorkspace(launch.workspaceRoot, launch.workspace).pipe(
      Effect.mapError(rejectWorkspaceLaunch),
      Effect.flatMap((verified) => runVerifiedAgent(launch, verified)),
    ),
  )
