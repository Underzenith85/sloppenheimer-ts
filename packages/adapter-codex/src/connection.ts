import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Effect, Option, type Fiber } from 'effect'

import type { JsonObject } from '@sloppenheimer/core/domain/domain.js'
import { AgentError } from '@sloppenheimer/core/domain/errors.js'
import type { AgentRunnerConfig } from '@sloppenheimer/core/ports/agent-runner.js'
import type { HostToolSession } from '@sloppenheimer/core/domain/host-tools.js'
import { currentInstant } from '@sloppenheimer/core/support/clock.js'
import { isJsonObject } from '@sloppenheimer/core/support/json.js'
import { makeRedactor } from '@sloppenheimer/core/support/redaction.js'
import type { AgentEvent } from '@sloppenheimer/core/telemetry.js'
import {
  adoptRateLimitSnapshot,
  adoptThreadId,
  type ConnectionStateRef,
} from './connection-state.js'
import { diagnosticReader, protocolReader } from './readers.js'
import {
  emitEvent,
  failUnlessClosed,
  processIdOf,
  sendRequest,
  notifySession,
  watchProcess,
  type ForkReader,
  type SessionRuntime,
} from './session-runtime.js'
import { receiveLine } from './inbound.js'
import { makeCodexEnvironment } from './session.js'
import { codexSettingsFrom } from './settings.js'
import { stopSession } from './shutdown.js'
import { awaitTurn } from './turns.js'

/**
 * One App Server session, from the process it spawns to the turns it runs.
 *
 * The class is the session's identity and nothing more: it holds the runtime record every
 * operation is written against, plus the two reader fibers that only shutdown needs. What each
 * operation does lives in the module that owns that concern.
 */
export class CodexConnection {
  readonly #session: SessionRuntime
  /** The fiber reading protocol lines from the child's stdout. */
  readonly #stdout: Fiber.RuntimeFiber<void>
  /** The fiber reading diagnostic records from the child's stderr. */
  readonly #stderr: Fiber.RuntimeFiber<void>

  constructor(
    command: string,
    cwd: string,
    config: AgentRunnerConfig,
    secretEnvironmentNames: readonly string[],
    knownSecretValues: readonly string[],
    hostTools: HostToolSession | null,
    onEvent: (event: AgentEvent) => void,
    fork: ForkReader,
    state: ConnectionStateRef,
    lifecycle: Effect.Semaphore,
  ) {
    // The full host environment, minus the names this session must not hand down. It is read here
    // rather than described as a `Config`, because what the child inherits is every remaining
    // variable, not a set of values named in advance.
    const environment = makeCodexEnvironment(process.env, secretEnvironmentNames)
    const child: ChildProcessWithoutNullStreams = spawn('bash', ['-lc', command], {
      cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so shutdown reaches tools the App Server itself started.
      detached: true,
    })
    this.#session = {
      process: child,
      state,
      onEvent,
      knownSecretValues,
      redact: makeRedactor(knownSecretValues),
      hostTools,
      fork,
      lifecycle,
      readTimeoutMs: config.readTimeoutMs,
      turnTimeoutMs: config.turnTimeoutMs,
    }
    this.#stdout = fork(
      protocolReader(
        child,
        (line) => receiveLine(this.#session, line),
        (error) => failUnlessClosed(this.#session, error),
      ),
    )
    this.#stderr = fork(
      diagnosticReader(child, (message) => emitEvent(this.#session, 'diagnostic', message)),
    )
    watchProcess(this.#session)
  }

  get processId(): number | null {
    return processIdOf(this.#session)
  }

  initialize(config: AgentRunnerConfig, cwd: string): Effect.Effect<string, AgentError> {
    return initializeSession(this.#session, config, cwd)
  }

  startTurn(
    threadId: string,
    cwd: string,
    config: AgentRunnerConfig,
    prompt: string,
    turnCount: number,
  ): Effect.Effect<string, AgentError> {
    return startTurn(this.#session, threadId, cwd, config, prompt, turnCount)
  }

  awaitTurn(turnId: string): Effect.Effect<void, AgentError> {
    return awaitTurn(this.#session, turnId)
  }

  stop(): Effect.Effect<void> {
    return stopSession(this.#session, { stdout: this.#stdout, stderr: this.#stderr })
  }
}

export const initializeSession = (
  session: SessionRuntime,
  config: AgentRunnerConfig,
  cwd: string,
): Effect.Effect<string, AgentError> =>
  Effect.gen(function* () {
    yield* sendRequest(session, 'initialize', {
      clientInfo: { name: 'sloppenheimer_ts', title: 'Sloppenheimer TypeScript', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    yield* notifySession(session, 'initialized', {})
    const rateLimitsResult = yield* sendRequest(session, 'account/rateLimits/read', {})
    if (!isJsonObject(rateLimitsResult) || !isJsonObject(rateLimitsResult['rateLimits'])) {
      return yield* Effect.fail(
        new AgentError({
          category: 'protocol_error',
          message: 'account/rateLimits/read returned no rate-limit snapshot',
        }),
      )
    }
    const rateLimits = yield* adoptRateLimitSnapshot(
      session.state,
      rateLimitsResult['rateLimits'] as JsonObject,
    )
    session.onEvent({
      event: 'account/rateLimits/read',
      timestamp: yield* currentInstant,
      processId: processIdOf(session),
      message: null,
      usage: null,
      rateLimits,
      payload: { kind: 'session' },
      threadId: null,
      turnId: null,
      sessionId: null,
      turnCount: 0,
      turnStatus: null,
      lifecycle: null,
    })
    const settings = codexSettingsFrom(config.settings)
    const baseThreadParams: JsonObject = {
      cwd,
      approvalPolicy: settings.approvalPolicy,
      sandbox: settings.threadSandbox,
      serviceName: 'sloppenheimer_ts',
    }
    const dynamicTools =
      session.hostTools?.specs.map((spec) => ({ type: 'function', ...spec })) ?? []
    const threadParams: JsonObject =
      dynamicTools.length === 0 ? baseThreadParams : { ...baseThreadParams, dynamicTools }
    const result = yield* sendRequest(session, 'thread/start', threadParams)
    if (
      !isJsonObject(result) ||
      !isJsonObject(result['thread']) ||
      typeof result['thread']['id'] !== 'string'
    ) {
      return yield* Effect.fail(
        new AgentError({
          category: 'protocol_error',
          message: 'thread/start returned no thread id',
        }),
      )
    }
    const threadId = result['thread']['id']
    yield* adoptThreadId(session.state, threadId)
    return threadId
  })

export const startTurn = (
  session: SessionRuntime,
  threadId: string,
  cwd: string,
  config: AgentRunnerConfig,
  prompt: string,
  turnCount: number,
): Effect.Effect<string, AgentError> =>
  Effect.gen(function* () {
    const settings = codexSettingsFrom(config.settings)
    const result = yield* sendRequest(
      session,
      'turn/start',
      {
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd,
        approvalPolicy: settings.approvalPolicy,
        sandboxPolicy: settings.turnSandboxPolicy ?? {
          type: 'workspaceWrite',
          writableRoots: [cwd],
          networkAccess: true,
        },
      },
      Option.some(turnCount),
    )
    if (
      !isJsonObject(result) ||
      !isJsonObject(result['turn']) ||
      typeof result['turn']['id'] !== 'string'
    ) {
      return yield* Effect.fail(
        new AgentError({
          category: 'protocol_error',
          message: 'turn/start returned no turn id',
        }),
      )
    }
    return result['turn']['id']
  })
