import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
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
    this.#process = spawn('bash', ['-lc', command], {
      cwd,
      env: makeCodexEnvironment(process.env, secretEnvironmentNames),
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
    return result['thread']['id']
  }

  async runTurn(
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
              turnId = await connection.runTurn(threadId, verified.path, launch.config, turnPrompt)
              await rebind()
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
