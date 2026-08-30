import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Effect } from 'effect'

import type { Issue, JsonObject, JsonValue, Workspace } from './domain.js'
import { codexAuthenticationEnvironmentNames } from './env-reference.js'
import { AgentError, type WorkspaceError } from './errors.js'
import { redactSecretsInString } from './logging.js'
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
/** After `SIGKILL`, how long to wait for the group to vanish, and how often to look. */
const groupReapDeadlineMs = 2_000
const groupReapPollMs = 25

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

/** Session identity remains stable for the lifetime of the App Server thread. */
export const composeSessionId = (threadId: string, _turnId: string | null): string => threadId

export const isCancelledTurnStatus = (status: string): boolean =>
  status === 'cancelled' || status === 'canceled' || status === 'interrupted'

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
  turnCount: number
  turnStatus: string | null
}>

export type AgentResult = Readonly<{
  threadId: string
  turnId: string
  turnCount: number
}>

type PendingRequest = Readonly<{
  method: string
  turnCount: number | null
  resolve: (value: JsonValue) => void
  reject: (error: AgentError) => void
  timeout: NodeJS.Timeout
}>

type TurnWaiter = Readonly<{
  resolve: () => void
  reject: (error: AgentError) => void
  timeout: NodeJS.Timeout
}>

/**
 * How a turn ended. Whatever observes the end — a lifecycle notification, a request Symphony
 * cannot serve, the turn timeout, or the session dying — records one of these against the turn id,
 * and the first record wins. That single rule replaces the precedence questions that arise once
 * "completed", "failed", and "the session died" live in separate places: a turn the server already
 * reported keeps its own result, and a later session-level error cannot overwrite or mask it.
 */
type TurnSettlement =
  | Readonly<{ _tag: 'completed' }>
  | Readonly<{ _tag: 'failed'; error: AgentError }>

const errorMessage = (value: JsonValue): string => {
  if (!isJsonObject(value)) {
    return 'unknown protocol error'
  }
  const message = value['message']
  return typeof message === 'string' ? message : 'unknown protocol error'
}

const nonNegativeInteger = (value: JsonValue | undefined): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

const valueAt = (object: JsonObject, camelCase: string, snakeCase: string): number | null =>
  nonNegativeInteger(object[camelCase] ?? object[snakeCase])

const tokenTotalsFrom = (value: JsonValue | undefined): AgentEvent['usage'] => {
  if (!isJsonObject(value)) {
    return null
  }
  const inputTokens = valueAt(value, 'inputTokens', 'input_tokens')
  const outputTokens = valueAt(value, 'outputTokens', 'output_tokens')
  const totalTokens = valueAt(value, 'totalTokens', 'total_tokens')
  return inputTokens === null || outputTokens === null || totalTokens === null
    ? null
    : { inputTokens, outputTokens, totalTokens }
}

const wrapperFrom = (params: JsonObject): JsonObject => {
  const message = params['msg']
  return isJsonObject(message) ? message : params
}

const mergeSparseObject = (current: JsonObject | null, update: JsonObject): JsonObject => {
  const merged: Record<string, JsonObject[string]> = { ...(current ?? {}) }
  for (const [key, value] of Object.entries(update)) {
    const existing = merged[key]
    if (value === null && existing !== undefined) {
      continue
    }
    merged[key] =
      isJsonObject(existing) && isJsonObject(value) ? mergeSparseObject(existing, value) : value
  }
  return merged
}

export const telemetryFrom = (
  method: string,
  message: JsonObject,
): Readonly<{ usage: AgentEvent['usage']; rateLimits: JsonObject | null }> => {
  const params = message['params']
  if (!isJsonObject(params)) {
    return { usage: null, rateLimits: null }
  }
  if (method === 'thread/tokenUsage/updated') {
    const tokenUsage = params['tokenUsage']
    const total = isJsonObject(tokenUsage) ? tokenUsage['total'] : undefined
    return { usage: tokenTotalsFrom(total), rateLimits: null }
  }
  if (method === 'turn/usage') {
    return { usage: tokenTotalsFrom(params['usage']), rateLimits: null }
  }
  if (method === 'account/rateLimits/updated') {
    const rateLimits = params['rateLimits']
    return { usage: null, rateLimits: isJsonObject(rateLimits) ? rateLimits : null }
  }
  if (method === 'codex/event/token_count') {
    const wrapper = wrapperFrom(params)
    const info = wrapper['info']
    const total = isJsonObject(info) ? info['total_token_usage'] : undefined
    const rateLimits = wrapper['rate_limits']
    return {
      usage: tokenTotalsFrom(total),
      rateLimits: isJsonObject(rateLimits) ? rateLimits : null,
    }
  }
  return { usage: null, rateLimits: null }
}

export const boundedMessage = (
  value: string,
  knownSecretValues: readonly string[] = [],
): string => {
  const knownSecretsRedacted = [...knownSecretValues]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((message, secret) => message.replaceAll(secret, '[REDACTED]'), value)
  const redacted = redactSecretsInString(knownSecretsRedacted)
  return redacted.length <= 512 ? redacted : `${redacted.slice(0, 509)}...`
}

const messageFrom = (message: JsonObject, knownSecretValues: readonly string[]): string | null => {
  const params = message['params']
  if (!isJsonObject(params)) {
    return null
  }
  const direct = params['message']
  if (typeof direct === 'string') {
    return boundedMessage(direct, knownSecretValues)
  }
  const error = params['error']
  if (isJsonObject(error) && typeof error['message'] === 'string') {
    return boundedMessage(error['message'], knownSecretValues)
  }
  const item = params['item']
  if (isJsonObject(item) && item['type'] === 'agentMessage' && typeof item['text'] === 'string') {
    return boundedMessage(item['text'], knownSecretValues)
  }
  return null
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
  // A pending buffer may hold a full-length payload plus the CR of a CRLF whose LF has not arrived
  // yet. Stripping happens once the line is complete, so the pending limit allows that one byte;
  // otherwise a valid maximum-length line would be rejected purely for where a chunk boundary fell.
  const pendingLimitBytes = limitBytes + 1
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
      if (pendingBytes > pendingLimitBytes) {
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
    if (buffer.byteLength > pendingLimitBytes) {
      overflow()
      return
    }
    if (buffer.byteLength > 0) {
      pending.push(buffer)
      pendingBytes = buffer.byteLength
    }
  }
}

/**
 * Identity a notification carries itself. Item and delta notifications declare `threadId` and
 * `turnId` directly under `params`, so they attribute correctly even out of order; the turn
 * lifecycle notifications carry the turn nested under `params.turn` instead.
 */
const notificationIdentity = (
  message: JsonObject,
): Readonly<{ threadId: string | null; turnId: string | null }> => {
  const params = message['params']
  if (!isJsonObject(params)) {
    return { threadId: null, turnId: null }
  }
  const threadId = params['threadId']
  const turnId = params['turnId']
  return {
    threadId: typeof threadId === 'string' ? threadId : null,
    turnId: typeof turnId === 'string' ? turnId : null,
  }
}

/**
 * A permissions approval answers with a `GrantedPermissionProfile`, not the `decision` value the
 * command execution and file change approvals take, so it needs its own response.
 */
const isPermissionsApproval = (method: string): boolean =>
  method.endsWith('/permissions/requestApproval')

/**
 * What Symphony grants when Codex asks to widen its sandbox mid-turn: nothing, answered in the
 * shape the server can decode.
 *
 * The request asks for additional filesystem paths or network access beyond the sandbox the thread
 * was started with. Echoing it back would let the agent negotiate its own containment, which is
 * exactly what verifying the workspace before launch exists to prevent. An operator widens the
 * sandbox by declaring `codex.turn_sandbox_policy`, where the decision is reviewable, so the turn
 * proceeds here under the sandbox it already has rather than one it asked for.
 *
 * `scope` is the schema's own default; an empty profile makes it immaterial, but stating the
 * narrower of the two values keeps the grant unambiguous.
 */
const withheldPermissionsGrant: JsonObject = { permissions: {}, scope: 'turn' }

const isApprovalRequest = (method: string): boolean =>
  /requestApproval$/u.test(method) && !isPermissionsApproval(method)
const isUserInputRequest = (method: string): boolean => /requestUserInput$/u.test(method)

class CodexConnection {
  readonly #process: ChildProcessWithoutNullStreams
  readonly #readTimeoutMs: number
  readonly #turnTimeoutMs: number
  readonly #onEvent: (event: AgentEvent) => void
  readonly #knownSecretValues: readonly string[]
  readonly #pending = new Map<number, PendingRequest>()
  /** The one record of how each turn ended. Authoritative, and written at most once per turn. */
  readonly #settled = new Map<string, TurnSettlement>()
  /** Callers waiting on turns that have not settled yet. */
  readonly #waiters = new Map<string, TurnWaiter>()
  readonly #turnUsage = new Map<string, NonNullable<AgentEvent['usage']>>()
  readonly #startedTurns = new Set<string>()
  readonly #turnCounts = new Map<string, number>()
  #pendingRateLimits: JsonObject | null = null
  #rateLimitsReady = false
  #nextId = 1
  #closed = false
  /**
   * Why the session as a whole is unusable. It answers only turns that never settled — a turn with
   * a settlement of its own is already decided.
   */
  #terminalError: AgentError | null = null
  #threadId: string | null = null
  #turnId: string | null = null
  #turnCount = 0

  constructor(
    command: string,
    cwd: string,
    config: CodexConfig,
    secretEnvironmentNames: readonly string[],
    onEvent: (event: AgentEvent) => void,
  ) {
    const environment = makeCodexEnvironment(process.env, secretEnvironmentNames)
    this.#knownSecretValues = [...codexAuthenticationEnvironmentNames]
      .map((name) => environment[name])
      .filter((value): value is string => value !== undefined && value.length > 0)
    this.#process = spawn('bash', ['-lc', command], {
      cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so shutdown reaches tools the App Server itself started.
      detached: true,
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
    const rateLimitsResult = await this.#request('account/rateLimits/read', {})
    if (!isJsonObject(rateLimitsResult) || !isJsonObject(rateLimitsResult['rateLimits'])) {
      throw new AgentError({
        category: 'protocol_error',
        message: 'account/rateLimits/read returned no rate-limit snapshot',
      })
    }
    const rateLimits = mergeSparseObject(
      rateLimitsResult['rateLimits'],
      this.#pendingRateLimits ?? {},
    )
    this.#pendingRateLimits = null
    this.#rateLimitsReady = true
    this.#onEvent({
      event: 'account/rateLimits/read',
      timestamp: new Date(),
      processId: this.processId,
      message: null,
      usage: null,
      rateLimits,
      threadId: null,
      turnId: null,
      sessionId: null,
      turnCount: 0,
      turnStatus: null,
    })
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
    turnCount: number,
  ): Promise<string> {
    const result = await this.#request(
      'turn/start',
      {
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd,
        approvalPolicy: config.approvalPolicy,
        sandboxPolicy: config.turnSandboxPolicy ?? {
          type: 'workspaceWrite',
          writableRoots: [cwd],
          networkAccess: true,
        },
      },
      turnCount,
    )
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
    return result['turn']['id']
  }

  /**
   * Waits for a turn to finish. Everything that could have decided it already — a completion the
   * App Server emitted in the same batch as the `turn/start` response, a request Symphony could not
   * serve, a process that died — is one settlement lookup, so this never has to rank one against
   * another.
   */
  awaitTurn(turnId: string): Promise<void> {
    const settlement = this.#settled.get(turnId)
    if (settlement !== undefined) {
      return settlement._tag === 'completed' ? Promise.resolve() : Promise.reject(settlement.error)
    }
    // Only a turn that never settled falls back to the session-level reason.
    if (this.#terminalError !== null) {
      return Promise.reject(this.#terminalError)
    }
    return new Promise<void>((resolvePromise, rejectPromise) => {
      this.#waiters.set(turnId, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout: this.#armTurnTimer(turnId),
      })
    })
  }

  /**
   * Records how a turn ended and answers anyone waiting on it. The first settlement wins, so a
   * later report — including the session dying — cannot overwrite a decided turn.
   */
  #settle(turnId: string, settlement: TurnSettlement, reported = false): void {
    if (this.#settled.has(turnId)) {
      return
    }
    this.#settled.set(turnId, settlement)
    if (!reported) {
      const status =
        settlement._tag === 'completed'
          ? 'completed'
          : settlement.error.category === 'turn_timeout'
            ? 'timed_out'
            : 'failed'
      this.#emit('turn/terminated', null, { threadId: null, turnId }, status)
    }
    const waiter = this.#waiters.get(turnId)
    if (waiter === undefined) {
      return
    }
    this.#waiters.delete(turnId)
    clearTimeout(waiter.timeout)
    if (settlement._tag === 'completed') {
      waiter.resolve()
      return
    }
    waiter.reject(settlement.error)
  }

  /**
   * Fails the turn the App Server is working on. A request Symphony cannot serve ends that turn,
   * and the turn it names — or failing that, the turn in flight — is where the reason belongs. With
   * no turn to attribute it to the whole session is unusable, so it becomes the terminal reason.
   */
  #failCurrentTurn(error: AgentError, turnId: string | null): void {
    const target = turnId ?? this.#turnId
    if (target === null) {
      this.#fail(error)
      return
    }
    this.#settle(target, { _tag: 'failed', error })
  }

  #armTurnTimer(turnId: string): NodeJS.Timeout {
    return setTimeout(() => {
      this.#settle(turnId, {
        _tag: 'failed',
        error: new AgentError({
          category: 'turn_timeout',
          message: `turn ${turnId} produced no output for ${String(this.#turnTimeoutMs)}ms`,
        }),
      })
    }, this.#turnTimeoutMs)
  }

  /**
   * `codex.turn_timeout_ms` is a silence timeout, not a total turn budget: protocol output that
   * belongs to a turn re-arms that turn's timer, so a long but active turn never expires.
   *
   * Only output that names its own turn counts. There is no fallback to the turn in flight:
   * anything parseable would otherwise hold a turn open forever — `{}` emitted faster than the
   * timeout, responses matching nothing, unsupported requests, or session-level notifications that
   * have no bearing on the turn at all.
   */
  #noteActivity(turnId: string): void {
    const waiter = this.#waiters.get(turnId)
    if (waiter === undefined) {
      return
    }
    clearTimeout(waiter.timeout)
    this.#waiters.set(turnId, { ...waiter, timeout: this.#armTurnTimer(turnId) })
  }

  async stop(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#emit('session_stopped', null)
    this.#closed = true
    this.#fail(
      new AgentError({ category: 'process_exited', message: 'Codex session was closed' }),
      false,
    )
    this.#process.stdout.removeAllListeners('data')
    this.#process.stderr.removeAllListeners('data')
    this.#process.stdin.end()
    this.#terminate('SIGTERM')
    await this.#reapGroup()
  }

  /**
   * Waits for the App Server's process group to empty, escalating to `SIGKILL` once the grace has
   * passed. Polling rather than waiting on the leader's `exit`: the group emptying is not an event
   * Node reports, so a tree whose last member leaves a moment after the leader would otherwise sit
   * out the whole grace before anyone noticed, delaying workspace cleanup for ordinary sessions.
   *
   * Both phases are bounded, and the poll timers are referenced on purpose — an awaited promise
   * does not hold the event loop open, so an unreferenced wait would let the host exit before the
   * escalation ever fired and leave behind the descendant this exists to kill.
   */
  async #reapGroup(): Promise<void> {
    const escalateAt = Date.now() + shutdownGraceMs
    while (this.#processGroupIsAlive()) {
      if (Date.now() >= escalateAt) {
        this.#terminate('SIGKILL')
        break
      }
      await CodexConnection.#pause(groupReapPollMs)
    }
    // Signal delivery is asynchronous, so returning as soon as SIGKILL was sent would let the
    // finalizer complete — and terminal reconciliation start removing the workspace — while a
    // descendant is still running in it.
    const deadline = Date.now() + groupReapDeadlineMs
    while (this.#processGroupIsAlive() && Date.now() < deadline) {
      await CodexConnection.#pause(groupReapPollMs)
    }
  }

  static #pause(milliseconds: number): Promise<void> {
    return new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, milliseconds)
    })
  }

  /** Whether the App Server's process group still has a member. */
  #processGroupIsAlive(): boolean {
    const { pid } = this.#process
    if (pid === undefined) {
      return false
    }
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** Signals the whole App Server process group, not only the shell that started it. */
  #terminate(signal: NodeJS.Signals): void {
    const { pid } = this.#process
    if (pid === undefined) {
      return
    }
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        this.#process.kill(signal)
      } catch {
        // The process tree is already gone.
      }
    }
  }

  static #turnFailure(turnId: string, status: string): AgentError {
    const cancelled = isCancelledTurnStatus(status)
    return new AgentError({
      category: cancelled ? 'turn_cancelled' : 'turn_failed',
      message: `turn ${turnId} finished with status ${status}`,
    })
  }

  /** Registers the pending entry before writing, so a response can never arrive unowned. */
  #request(
    method: string,
    params: JsonObject,
    turnCount: number | null = null,
  ): Promise<JsonValue> {
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
      this.#pending.set(id, {
        method,
        turnCount,
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout,
      })
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
    // `RequestId` is a string or an int64, so a server request carrying a string id is still a
    // request. Reading it as a notification would leave it unanswered and stall the turn.
    if (typeof id === 'string' || typeof id === 'number') {
      this.#handleServerRequest(id, method, parsed)
      return
    }
    this.#handleNotification(method, parsed)
  }

  #settleResponse(id: number, parsed: JsonObject): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) {
      // Response-shaped, but it answers nothing Symphony sent. It is not progress, so it must not
      // re-arm the turn: a stuck server could otherwise hold a turn open with unmatched ids.
      this.#emit('unmatched_response', `no pending request for response id ${String(id)}`)
      return
    }
    clearTimeout(pending.timeout)
    this.#pending.delete(id)
    const error = parsed['error']
    if (error !== undefined) {
      pending.reject(
        new AgentError({
          category: 'protocol_error',
          message: boundedMessage(errorMessage(error), this.#knownSecretValues),
        }),
      )
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
    if (pending.method === 'thread/start' && this.#threadId !== null) {
      this.#emit('thread_started', null)
      this.#emit('session_started', null)
    }
    if (pending.method === 'turn/start' && pending.turnCount !== null && this.#turnId !== null) {
      this.#ensureTurnStarted(this.#turnId, pending.turnCount, this.#threadId)
    }
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

  #ensureTurnStarted(turnId: string, turnCount: number, threadId: string | null): void {
    if (this.#startedTurns.has(turnId)) {
      return
    }
    this.#startedTurns.add(turnId)
    this.#turnCounts.set(turnId, turnCount)
    this.#turnId = turnId
    this.#turnCount = turnCount
    this.#emit('turn_started', null, { threadId, turnId })
  }

  /** `id` is echoed back in whichever form the server sent it. */
  #handleServerRequest(id: string | number, method: string, message: JsonObject): void {
    // A server request declares its own thread and turn, so its events are attributed from the
    // request rather than from connection state, which is null on the first turn and names the
    // previous one afterwards.
    const identity = notificationIdentity(message)
    // Only when the request names its turn; an unattributed one is not evidence that turn is alive.
    if (identity.turnId !== null) {
      this.#noteActivity(identity.turnId)
    }
    if (isPermissionsApproval(method)) {
      this.#write({ id, result: withheldPermissionsGrant })
      this.#emit('permissions_grant_withheld', method, identity)
      return
    }
    if (isApprovalRequest(method)) {
      this.#write({ id, result: { decision: 'acceptForSession' } })
      this.#emit('approval_auto_approved', method, identity)
      return
    }
    if (isUserInputRequest(method)) {
      this.#write({
        id,
        error: { code: -32000, message: 'Symphony does not support interactive input' },
      })
      this.#failCurrentTurn(
        new AgentError({
          category: 'input_required',
          message: 'Codex requested interactive input',
        }),
        identity.turnId,
      )
      return
    }
    this.#write({ id, error: { code: -32601, message: `Unsupported client request: ${method}` } })
    this.#emit('unsupported_tool_call', method, identity)
  }

  #handleNotification(method: string, message: JsonObject): void {
    const turn = this.#turnFrom(message)
    const carried = notificationIdentity(message)
    const telemetry = telemetryFrom(method, message)
    let rateLimits = telemetry.rateLimits
    if (rateLimits !== null && !this.#rateLimitsReady) {
      this.#pendingRateLimits = mergeSparseObject(this.#pendingRateLimits, rateLimits)
      rateLimits = null
    }
    // A notification that names its own thread and turn is attributable even when it arrives before
    // the response that would have taught the connection those ids.
    const threadId = carried.threadId ?? this.#threadId
    const turnId = carried.turnId ?? turn?.id ?? this.#turnId
    const isTerminal = method === 'turn/completed' || method === 'turn/failed'
    const terminalStatus =
      isTerminal && turn !== null
        ? (turn.status ?? (method === 'turn/failed' ? 'failed' : 'unreported'))
        : null
    if (isTerminal && turn !== null && this.#settled.has(turn.id)) {
      return
    }
    const pendingTurnStart = [...this.#pending.values()].find(
      (pending) => pending.method === 'turn/start' && pending.turnCount !== null,
    )
    if (turnId !== null && pendingTurnStart !== undefined && pendingTurnStart.turnCount !== null) {
      this.#ensureTurnStarted(turnId, pendingTurnStart.turnCount, threadId)
    }
    let usage = telemetry.usage
    if (method === 'turn/usage' && usage !== null && turnId !== null) {
      const previous = this.#turnUsage.get(turnId)
      this.#turnUsage.set(turnId, {
        inputTokens: Math.max(previous?.inputTokens ?? 0, usage.inputTokens),
        outputTokens: Math.max(previous?.outputTokens ?? 0, usage.outputTokens),
        totalTokens: Math.max(previous?.totalTokens ?? 0, usage.totalTokens),
      })
      usage = [...this.#turnUsage.values()].reduce(
        (total, current) => ({
          inputTokens: total.inputTokens + current.inputTokens,
          outputTokens: total.outputTokens + current.outputTokens,
          totalTokens: total.totalTokens + current.totalTokens,
        }),
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      )
    }
    // Re-arm the turn this notification names, not whichever turn happens to be waiting.
    const attributed = carried.turnId ?? turn?.id
    if (attributed !== undefined) {
      this.#noteActivity(attributed)
    }
    this.#onEvent({
      event: method,
      timestamp: new Date(),
      processId: this.processId,
      message: messageFrom(message, this.#knownSecretValues),
      usage,
      rateLimits,
      threadId,
      turnId,
      sessionId: threadId === null ? null : composeSessionId(threadId, turnId),
      turnCount:
        turnId === null ? this.#turnCount : (this.#turnCounts.get(turnId) ?? this.#turnCount),
      turnStatus: terminalStatus,
    })
    if (!isTerminal) {
      return
    }
    if (turn === null) {
      return
    }
    // The reported status is the specific one — `cancelled`, say — so it always wins. `turn/failed`
    // supplies `failed` only when the notification omitted it, since there the method says enough.
    if (turn.status === null && method === 'turn/completed') {
      // The Turn schema requires `status`. Reading a missing one as success would hand off work
      // the server never reported as complete, so the turn fails with a legible reason instead.
      this.#emit('malformed', `${method} for turn ${turn.id} omitted status`)
    }
    this.#settle(
      turn.id,
      terminalStatus === 'completed'
        ? { _tag: 'completed' }
        : {
            _tag: 'failed',
            error: CodexConnection.#turnFailure(turn.id, terminalStatus ?? 'unreported'),
          },
      true,
    )
  }

  #turnFrom(message: JsonObject): Readonly<{ id: string; status: string | null }> | null {
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
    return { id, status: typeof status === 'string' ? status : null }
  }

  /**
   * Emits a client-side event. Identity carried by the message that provoked it wins over
   * connection state, which lags whenever a message arrives before the response that would set it.
   */
  #emit(
    event: string,
    message: string | null,
    carried: Readonly<{ threadId: string | null; turnId: string | null }> = {
      threadId: null,
      turnId: null,
    },
    turnStatus: string | null = null,
  ): void {
    const threadId = carried.threadId ?? this.#threadId
    const turnId = carried.turnId ?? this.#turnId
    this.#onEvent({
      event,
      timestamp: new Date(),
      processId: this.processId,
      message: message === null ? null : boundedMessage(message, this.#knownSecretValues),
      usage: null,
      rateLimits: null,
      threadId,
      turnId,
      sessionId: threadId === null ? null : composeSessionId(threadId, turnId),
      turnCount:
        turnId === null ? this.#turnCount : (this.#turnCounts.get(turnId) ?? this.#turnCount),
      turnStatus,
    })
  }

  /**
   * Records the session-level reason and settles everything still outstanding. Turns that already
   * settled keep their own result — `#settle` ignores a second write — so finished work is never
   * relabelled as a session failure.
   */
  #fail(error: AgentError, remember = true): void {
    if (remember && this.#terminalError === null) {
      this.#terminalError = error
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.#pending.clear()
    // The turn in flight counts even with no waiter registered yet: a caller between `startTurn`
    // and `awaitTurn` has none, and `exit` can arrive before stdout finishes draining. Without
    // this, a `turn/completed` still queued in the pipe would become that turn's first settlement
    // and report success for a session already observed to have died.
    const outstanding = new Set(this.#waiters.keys())
    if (this.#turnId !== null) {
      outstanding.add(this.#turnId)
    }
    for (const turnId of outstanding) {
      this.#settle(turnId, { _tag: 'failed', error })
    }
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
                turnCount + 1,
              )
              await rebind()
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
