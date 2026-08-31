import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { FileSystem } from '@effect/platform'
import * as NodeStream from '@effect/platform-node/NodeStream'
import {
  Clock,
  Config,
  Deferred,
  Effect,
  Fiber,
  Option,
  Queue,
  Redacted,
  Ref,
  Runtime,
  Stream,
  type Scope,
} from 'effect'

import type { JsonObject, JsonValue } from '@symphony/core/domain/domain.js'
import { codexAuthenticationEnvironmentNames } from '@symphony/core/config/env-reference.js'
import { AgentError, type WorkspaceError } from '@symphony/core/domain/errors.js'
import type {
  AgentLaunch,
  AgentResult,
  AgentRunnerConfig,
} from '@symphony/core/ports/agent-runner.js'
import { currentInstant } from '@symphony/core/support/clock.js'
import { isJsonObject, isJsonValue, mergeSparseObject } from '@symphony/core/support/json.js'
import { childProcessGroupIsAlive, signalChildGroup } from '@symphony/core/support/subprocess.js'
import type { HostToolResult, HostToolSession } from '@symphony/core/domain/host-tools.js'
import { unsupportedHostTool } from '@symphony/core/domain/host-tools.js'
import {
  makeRedactor,
  redact,
  redactionMarker,
  type Redactor,
} from '@symphony/core/support/redaction.js'
import {
  clientPayload,
  normalizePayload,
  type AgentEvent,
  type AgentEventPayload,
} from '@symphony/core/telemetry.js'
import {
  assertWorkspaceIdentity,
  openVerifiedWorkspace,
} from '@symphony/adapter-node/workspace-identity.js'
import { diagnosticLines, diagnosticRecords, protocolLines } from './framing.js'
import {
  hostToolCallFrom,
  messageTextFrom,
  notificationIdentity,
  protocolErrorMessage,
  responseIdentity,
  telemetryFrom,
  turnFrom,
  type ProtocolIdentity,
} from './protocol.js'
import type { VerifiedWorkspace } from '@symphony/core/domain/workspace-containment.js'

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
/** How long a stopping session waits for the diagnostic reader to drain and flush. */
const diagnosticDrainDeadlineMs = 1_000

/**
 * SPEC 4.1.6 and 4.2 compose a session identity from the coding-agent thread and turn as
 * `<thread_id>-<turn_id>`, so each turn on a thread is its own session while the thread id stays
 * the one the App Server issued. Continuation turns therefore reuse `thread_id` and produce a new
 * `session_id`, which is what 10.2 asks for.
 *
 * Before the first turn exists there is no turn half to compose. A trailing separator would name a
 * turn that never ran, so the thread id stands alone until a turn identity arrives — the only
 * event that sees this is `session_started`, emitted between `thread/start` and the first
 * `turn/start`.
 */
export const composeSessionId = (threadId: string, turnId: string | null): string =>
  turnId === null ? threadId : `${threadId}-${turnId}`

export const isCancelledTurnStatus = (status: string): boolean =>
  status === 'cancelled' || status === 'canceled' || status === 'interrupted'

export { telemetryFrom }
export type { AgentEvent } from '@symphony/core/telemetry.js'
export type { AgentLaunch, AgentResult } from '@symphony/core/ports/agent-runner.js'

/**
 * The environment values a session's telemetry must never echo. The tracker's own secret names come
 * from the workflow; Codex's authentication sources are added because they are present in the
 * subprocess environment by design and could be printed by any tool the agent runs.
 *
 * Each name is read through the calling fiber's `ConfigProvider` — the host environment, not the
 * environment the subprocess is given. That distinction is deliberate: the tracker's own secret is
 * stripped from what Codex inherits, and a value the agent never receives is exactly the one most
 * worth removing if some tool prints it back. A name that is not set is simply absent, because a
 * missing credential is not an error here.
 */
export const sessionSecretValues = (
  secretEnvironmentNames: readonly string[],
): Effect.Effect<readonly string[]> => {
  const names = new Set([
    ...secretEnvironmentNames,
    ...codexAuthenticationEnvironmentNames,
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ])
  return Effect.forEach([...names], (name) => Config.option(Config.redacted(name))).pipe(
    Effect.map((values) =>
      values
        .flatMap((value) => (value._tag === 'Some' ? [Redacted.value(value.value)] : []))
        .filter((value) => value.length > 0),
    ),
    Effect.orDie,
  )
}

type PendingRequest = Readonly<{
  method: string
  turnCount: Option.Option<number>
  reply: Deferred.Deferred<JsonValue, AgentError>
  claimed: boolean
}>

type TurnState = Readonly<{
  settlement: Deferred.Deferred<void, AgentError>
  activity: Queue.Queue<void>
  timerStarted: boolean
  claimed: boolean
}>

type TurnSettlement =
  | Readonly<{ _tag: 'completed' }>
  | Readonly<{ _tag: 'failed'; error: AgentError }>

type TurnSelection =
  | Readonly<{ _tag: 'turn'; turn: TurnState }>
  | Readonly<{ _tag: 'error'; error: AgentError }>

type RequestRegistration =
  | Readonly<{ _tag: 'registered'; id: number }>
  | Readonly<{ _tag: 'error'; error: AgentError }>

type ConnectionState = Readonly<{
  pending: ReadonlyMap<number, PendingRequest>
  turns: ReadonlyMap<string, TurnState>
  turnUsage: ReadonlyMap<string, NonNullable<AgentEvent['usage']>>
  startedTurns: ReadonlySet<string>
  turnCounts: ReadonlyMap<string, number>
  pendingRateLimits: Option.Option<JsonObject>
  rateLimitsReady: boolean
  nextId: number
  closed: boolean
  terminalError: Option.Option<AgentError>
  threadId: Option.Option<string>
  turnId: Option.Option<string>
  turnCount: number
}>

const initialConnectionState: ConnectionState = {
  pending: new Map(),
  turns: new Map(),
  turnUsage: new Map(),
  startedTurns: new Set(),
  turnCounts: new Map(),
  pendingRateLimits: Option.none(),
  rateLimitsReady: false,
  nextId: 1,
  closed: false,
  terminalError: Option.none(),
  threadId: Option.none(),
  turnId: Option.none(),
  turnCount: 0,
}

export const boundedMessage = (
  value: string,
  knownSecretValues: readonly string[] = [],
): string => {
  const knownSecretsRedacted = [...knownSecretValues]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((message, secret) => message.replaceAll(secret, redactionMarker), value)
  // `redact` composes the host's structural redactor with the shape-based patterns, so a bare
  // provider token in an agent message is removed as surely as an `Authorization:` header is.
  const redacted = redact(knownSecretsRedacted)
  return redacted.length <= 512 ? redacted : `${redacted.slice(0, 509)}...`
}

/** Redacted and bounded at ingest, before the event that carries it is ever retained. */
const messageFrom = (message: JsonObject, knownSecretValues: readonly string[]): string | null => {
  const text = messageTextFrom(message)
  return text === null ? null : boundedMessage(text, knownSecretValues)
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

/**
 * How a session starts its readers. The caller supplies it from the runtime and scope the session
 * runs in, so a reader is a child of that scope rather than a fiber on the default runtime: one
 * left running by a session that never stopped cleanly is interrupted when the scope closes.
 */
type ForkReader = (reader: Effect.Effect<void>) => Fiber.RuntimeFiber<void>

class CodexConnection {
  readonly #process: ChildProcessWithoutNullStreams
  readonly #readTimeoutMs: number
  readonly #turnTimeoutMs: number
  readonly #onEvent: (event: AgentEvent) => void
  readonly #knownSecretValues: readonly string[]
  readonly #hostTools: HostToolSession | null
  /**
   * Shape-based redaction over the same known secret values, applied at the parser so a credential
   * a message carried is gone before any consumer — the timeline, a log, an HTTP response — can
   * retain it.
   */
  readonly #redact: Redactor
  /** The fiber reading protocol lines from the child's stdout. */
  readonly #stdout: Fiber.RuntimeFiber<void>
  /** The fiber reading diagnostic records from the child's stderr. */
  readonly #stderr: Fiber.RuntimeFiber<void>
  readonly #state: Ref.Ref<ConnectionState>
  readonly #fork: ForkReader
  /** Serializes response side effects with session-terminal failure. */
  readonly #lifecycle: Effect.Semaphore

  constructor(
    command: string,
    cwd: string,
    config: AgentRunnerConfig,
    secretEnvironmentNames: readonly string[],
    // Resolved from the host environment rather than read out of the subprocess's: the tracker's
    // own secret is stripped from what Codex inherits, and a value the agent never receives is
    // exactly the one most worth removing if some tool prints it back.
    knownSecretValues: readonly string[],
    hostTools: HostToolSession | null,
    onEvent: (event: AgentEvent) => void,
    fork: ForkReader,
    state: Ref.Ref<ConnectionState>,
    lifecycle: Effect.Semaphore,
  ) {
    // The full host environment, minus the names this session must not hand down. It is read here
    // rather than described as a `Config`, because what the child inherits is every remaining
    // variable, not a set of values named in advance.
    const environment = makeCodexEnvironment(process.env, secretEnvironmentNames)
    this.#knownSecretValues = knownSecretValues
    this.#hostTools = hostTools
    this.#redact = makeRedactor(this.#knownSecretValues)
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
    this.#fork = fork
    this.#state = state
    this.#lifecycle = lifecycle

    // stdout carries protocol framing only. Reading it as a stream keeps the framing state in
    // the pipeline rather than in the connection, and lets the framing limit end the read the way
    // any other protocol error does.
    this.#stdout = fork(
      NodeStream.fromReadable<AgentError>(
        () => this.#process.stdout,
        (cause) =>
          new AgentError({ category: 'protocol_error', message: 'Codex stdout failed', cause }),
      ).pipe(
        protocolLines(codexMaxLineBytes),
        Stream.runForEach((line) => this.#receiveLine(line)),
        Effect.catchAll((error) => this.#failUnlessClosed(error)),
      ),
    )

    // stderr is diagnostic only and never parsed as protocol. Complete records are assembled
    // before redaction: a chunk boundary between `Authorization:` and its value must not turn the
    // value into an unkeyed fragment that can escape the header redactor. A read that fails is the
    // end of the diagnostics rather than a session failure, and ends the stream so that whatever
    // record was still open is flushed.
    this.#stderr = fork(
      NodeStream.fromReadable<AgentError>(
        () => this.#process.stderr,
        (cause) =>
          new AgentError({ category: 'protocol_error', message: 'Codex stderr failed', cause }),
        // The pipe outlives the reader. Closing it under a child that is still running would fail
        // its diagnostic writes, so the reader gives up on the record and leaves the pipe open.
        { closeOnDone: false },
      ).pipe(
        Stream.catchAll(() => Stream.empty),
        diagnosticLines(codexMaxLineBytes),
        diagnosticRecords,
        Stream.runForEach((message) => this.#emit('diagnostic', message)),
        Effect.catchAll(() =>
          this.#emit('diagnostic', 'Codex diagnostic line exceeded the framing limit').pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                // Framing has given up on this stream, but the child has not stopped writing to it.
                // Keep emptying the pipe and discard what arrives: a full stderr buffer blocks the App
                // Server mid-protocol, which would turn a diagnostic-only overflow into a dead turn.
                this.#process.stderr.resume()
              }),
            ),
          ),
        ),
      ),
    )

    this.#process.once('error', (cause) => {
      this.#fork(
        this.#fail(
          new AgentError({ category: 'spawn_failed', message: 'Codex process failed', cause }),
        ),
      )
    })
    this.#process.once('exit', (code, signal) => {
      this.#fork(
        this.#failUnlessClosed(
          new AgentError({
            category: 'process_exited',
            message:
              signal === null
                ? `Codex process exited with ${String(code)}`
                : `Codex process terminated by ${signal}`,
          }),
        ),
      )
    })
  }

  get processId(): number | null {
    return this.#process.pid ?? null
  }

  initialize(config: AgentRunnerConfig, cwd: string): Effect.Effect<string, AgentError> {
    return Effect.gen(this, function* () {
      yield* this.#request('initialize', {
        clientInfo: { name: 'symphony_ts', title: 'Symphony TypeScript', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
      yield* this.#notify('initialized', {})
      const rateLimitsResult = yield* this.#request('account/rateLimits/read', {})
      if (!isJsonObject(rateLimitsResult) || !isJsonObject(rateLimitsResult['rateLimits'])) {
        return yield* Effect.fail(
          new AgentError({
            category: 'protocol_error',
            message: 'account/rateLimits/read returned no rate-limit snapshot',
          }),
        )
      }
      const rateLimits = yield* Ref.modify(this.#state, (state) => [
        mergeSparseObject(
          rateLimitsResult['rateLimits'] as JsonObject,
          Option.getOrElse(state.pendingRateLimits, () => ({})),
        ),
        { ...state, pendingRateLimits: Option.none(), rateLimitsReady: true },
      ])
      this.#onEvent({
        event: 'account/rateLimits/read',
        timestamp: yield* currentInstant,
        processId: this.processId,
        message: null,
        usage: null,
        rateLimits,
        payload: { kind: 'session' },
        threadId: null,
        turnId: null,
        sessionId: null,
        turnCount: 0,
        turnStatus: null,
      })
      const baseThreadParams: JsonObject = {
        cwd,
        approvalPolicy: config.approvalPolicy,
        sandbox: config.threadSandbox,
        serviceName: 'symphony_ts',
      }
      const dynamicTools =
        this.#hostTools?.specs.map((spec) => ({ type: 'function', ...spec })) ?? []
      const threadParams: JsonObject =
        dynamicTools.length === 0 ? baseThreadParams : { ...baseThreadParams, dynamicTools }
      const result = yield* this.#request('thread/start', threadParams)
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
      yield* Ref.update(this.#state, (state) => ({
        ...state,
        threadId: Option.some(threadId),
      }))
      return threadId
    })
  }

  startTurn(
    threadId: string,
    cwd: string,
    config: AgentRunnerConfig,
    prompt: string,
    turnCount: number,
  ): Effect.Effect<string, AgentError> {
    return Effect.gen(this, function* () {
      const result = yield* this.#request(
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
  }

  /**
   * Waits for a turn to finish. Everything that could have decided it already — a completion the
   * App Server emitted in the same batch as the `turn/start` response, a request Symphony could not
   * serve, a process that died — is the same Deferred, so this never has to rank one against
   * another. A Deferred retains its result for late waiters.
   */
  awaitTurn(turnId: string): Effect.Effect<void, AgentError> {
    return this.#turnState(turnId).pipe(
      Effect.tap((turn) => this.#startTurnTimer(turnId, turn)),
      Effect.flatMap((turn) => Deferred.await(turn.settlement)),
    )
  }

  /**
   * Finds or installs a turn's Deferred. Allocation happens outside the Ref update, while the
   * update chooses atomically between a concurrently installed value, the session's terminal
   * error, and this candidate.
   */
  #turnState(turnId: string): Effect.Effect<TurnState, AgentError> {
    return Effect.gen(this, function* () {
      const settlement = yield* Deferred.make<void, AgentError>()
      // Activity is an edge, not a count. Retaining a burst would replay stale progress and extend
      // the next silence window once per notification rather than once for the burst.
      const activity = yield* Queue.dropping<void>(1)
      const candidate: TurnState = { settlement, activity, timerStarted: false, claimed: false }
      const selected = yield* Ref.modify(
        this.#state,
        (state): readonly [TurnSelection, ConnectionState] => {
          const existing = state.turns.get(turnId)
          if (existing !== undefined) {
            return [{ _tag: 'turn' as const, turn: existing }, state]
          }
          if (Option.isSome(state.terminalError)) {
            return [{ _tag: 'error' as const, error: state.terminalError.value }, state]
          }
          return [
            { _tag: 'turn' as const, turn: candidate },
            { ...state, turns: new Map(state.turns).set(turnId, candidate) },
          ]
        },
      )
      if (selected._tag === 'error') {
        return yield* Effect.fail(selected.error)
      }
      return selected.turn
    })
  }

  /**
   * Completes the turn exactly once. Deferred completion reports whether this call won, which
   * keeps a later lifecycle notification or session failure from overturning the first result.
   */
  #settle(turnId: string, settlement: TurnSettlement, reported = false): Effect.Effect<boolean> {
    return this.#turnState(turnId).pipe(
      Effect.flatMap((turn) =>
        this.#claimTurn(turnId, turn).pipe(
          Effect.flatMap((claimed) =>
            claimed
              ? this.#completeTurn(turn, settlement).pipe(Effect.as(true))
              : Effect.succeed(false),
          ),
        ),
      ),
      Effect.tap((won) => {
        if (!won || reported) {
          return Effect.void
        }
        const status =
          settlement._tag === 'completed'
            ? 'completed'
            : settlement.error.category === 'turn_timeout'
              ? 'timed_out'
              : 'failed'
        return this.#emit('turn/terminated', null, { threadId: null, turnId }, status)
      }),
      Effect.catchAll(() => Effect.succeed(false)),
    )
  }

  #claimTurn(turnId: string, turn: TurnState): Effect.Effect<boolean> {
    return Ref.modify(this.#state, (state) => {
      const current = state.turns.get(turnId)
      if (current?.settlement !== turn.settlement || current.claimed) {
        return [false, state]
      }
      return [
        true,
        {
          ...state,
          turns: new Map(state.turns).set(turnId, { ...current, claimed: true }),
        },
      ]
    })
  }

  #completeTurn(turn: TurnState, settlement: TurnSettlement): Effect.Effect<void> {
    return (
      settlement._tag === 'completed'
        ? Deferred.succeed(turn.settlement, undefined)
        : Deferred.fail(turn.settlement, settlement.error)
    ).pipe(Effect.asVoid)
  }

  #failCurrentTurn(error: AgentError, turnId: Option.Option<string>): Effect.Effect<void> {
    return Ref.get(this.#state).pipe(
      Effect.flatMap((state) => {
        const target = turnId.pipe(Option.orElse(() => state.turnId))
        return Option.match(target, {
          onNone: () => this.#fail(error),
          onSome: (id) => this.#settle(id, { _tag: 'failed', error }).pipe(Effect.asVoid),
        })
      }),
    )
  }

  #startTurnTimer(turnId: string, turn: TurnState): Effect.Effect<void> {
    return Ref.modify(this.#state, (state) => {
      const current = state.turns.get(turnId)
      if (current !== turn || current.timerStarted || current.claimed) {
        return [false, state]
      }
      const started = { ...current, timerStarted: true }
      return [true, { ...state, turns: new Map(state.turns).set(turnId, started) }]
    }).pipe(
      Effect.tap((start) => {
        if (!start) {
          return Effect.void
        }
        const awaitActivity = (): Effect.Effect<void> =>
          Queue.take(turn.activity).pipe(
            Effect.timeoutOption(this.#turnTimeoutMs),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  this.#settle(turnId, {
                    _tag: 'failed',
                    error: new AgentError({
                      category: 'turn_timeout',
                      message: `turn ${turnId} produced no output for ${String(this.#turnTimeoutMs)}ms`,
                    }),
                  }).pipe(Effect.asVoid),
                onSome: () => awaitActivity(),
              }),
            ),
          )
        this.#fork(
          Effect.raceFirst(
            Deferred.await(turn.settlement).pipe(Effect.ignore),
            awaitActivity(),
          ).pipe(
            Effect.ensuring(
              Ref.update(this.#state, (state) => {
                const current = state.turns.get(turnId)
                if (current?.activity !== turn.activity || !current.timerStarted) {
                  return state
                }
                return {
                  ...state,
                  turns: new Map(state.turns).set(turnId, { ...current, timerStarted: false }),
                }
              }),
            ),
          ),
        )
        return Effect.void
      }),
      Effect.asVoid,
    )
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
  #noteActivity(turnId: string): Effect.Effect<void> {
    return Ref.get(this.#state).pipe(
      Effect.flatMap((state) => {
        const turn = state.turns.get(turnId)
        if (turn?.timerStarted !== true || turn.claimed) {
          return Effect.void
        }
        return Queue.offer(turn.activity, undefined).pipe(Effect.asVoid)
      }),
      Effect.asVoid,
    )
  }

  stop(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const shouldStop = yield* Ref.modify(this.#state, (state) =>
        state.closed ? [false, state] : [true, { ...state, closed: true }],
      )
      if (!shouldStop) {
        return
      }
      yield* this.#emit('session_stopped', null).pipe(
        Effect.zipRight(
          this.#fail(
            new AgentError({ category: 'process_exited', message: 'Codex session was closed' }),
            false,
          ),
        ),
      )
      yield* Fiber.interrupt(this.#stdout)
      this.#process.stdin.end()
      signalChildGroup(this.#process, 'SIGTERM')
      yield* this.#reapGroup()
      yield* this.#drainDiagnostics()
    })
  }

  /**
   * Lets the diagnostic reader finish. The child's death closes stderr, which ends the stream and
   * flushes the record it was still assembling — an unterminated final line, or a PEM block whose
   * end marker never arrived — so the last thing a failing session said is reported before the
   * session is torn down.
   *
   * Bounded, because a descendant that inherited the pipe and outlived the reap would otherwise
   * hold the session open indefinitely. A diagnostic lost to that bound is diagnostic only.
   */
  #drainDiagnostics(): Effect.Effect<void> {
    return Fiber.await(this.#stderr).pipe(
      Effect.timeout(diagnosticDrainDeadlineMs),
      Effect.catchAll(() => Fiber.interrupt(this.#stderr)),
      Effect.asVoid,
      Effect.ensuring(
        Effect.sync(() => {
          // The reader leaves the pipe open for a child that is still writing; with the session
          // over there is no such child, and the handle is released rather than held to the end
          // of the host.
          this.#process.stderr.destroy()
        }),
      ),
    )
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
  #reapGroup(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const escalateAt = (yield* Clock.currentTimeMillis) + shutdownGraceMs
      while (childProcessGroupIsAlive(this.#process)) {
        if ((yield* Clock.currentTimeMillis) >= escalateAt) {
          signalChildGroup(this.#process, 'SIGKILL')
          break
        }
        yield* Effect.sleep(groupReapPollMs)
      }
      // Signal delivery is asynchronous, so returning as soon as SIGKILL was sent would let the
      // finalizer complete — and terminal reconciliation start removing the workspace — while a
      // descendant is still running in it.
      const deadline = (yield* Clock.currentTimeMillis) + groupReapDeadlineMs
      while (
        childProcessGroupIsAlive(this.#process) &&
        (yield* Clock.currentTimeMillis) < deadline
      ) {
        yield* Effect.sleep(groupReapPollMs)
      }
    })
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
    turnCount: Option.Option<number> = Option.none(),
  ): Effect.Effect<JsonValue, AgentError> {
    return Effect.gen(this, function* () {
      const reply = yield* Deferred.make<JsonValue, AgentError>()
      const registered = yield* Ref.modify(
        this.#state,
        (state): readonly [RequestRegistration, ConnectionState] => {
          if (Option.isSome(state.terminalError)) {
            return [{ _tag: 'error', error: state.terminalError.value }, state]
          }
          const id = state.nextId
          return [
            { _tag: 'registered', id },
            {
              ...state,
              nextId: id + 1,
              pending: new Map(state.pending).set(id, {
                method,
                turnCount,
                reply,
                claimed: false,
              }),
            },
          ]
        },
      )
      if (registered._tag === 'error') {
        return yield* Effect.fail(registered.error)
      }
      const id = registered.id
      yield* this.#write({ id, method, params })
      const response = yield* Deferred.await(reply).pipe(Effect.timeoutOption(this.#readTimeoutMs))
      return yield* Option.match(response, {
        onNone: () =>
          this.#expirePending(
            id,
            reply,
            new AgentError({
              category: 'read_timeout',
              message: `${method} response timed out`,
            }),
          ),
        onSome: Effect.succeed,
      })
    })
  }

  #expirePending(
    id: number,
    reply: Deferred.Deferred<JsonValue, AgentError>,
    error: AgentError,
  ): Effect.Effect<JsonValue, AgentError> {
    return Ref.modify(this.#state, (state) => {
      const request = state.pending.get(id)
      if (request?.reply !== reply || request.claimed) {
        return [false, state]
      }
      const pending = new Map(state.pending)
      pending.delete(id)
      return [true, { ...state, pending }]
    }).pipe(
      Effect.flatMap((expired) =>
        expired
          ? Deferred.fail(reply, error).pipe(Effect.zipRight(Deferred.await(reply)))
          : Deferred.await(reply),
      ),
    )
  }

  #notify(method: string, params: JsonObject): Effect.Effect<void> {
    return this.#write({ method, params })
  }

  #write(message: JsonObject): Effect.Effect<void> {
    return Ref.get(this.#state).pipe(
      Effect.flatMap((state) =>
        state.closed
          ? Effect.void
          : Effect.sync(() => {
              this.#process.stdin.write(`${JSON.stringify(message)}\n`)
            }),
      ),
    )
  }

  #receiveLine(line: string): Effect.Effect<void, AgentError> {
    return Ref.get(this.#state).pipe(
      Effect.flatMap((state) => {
        if (state.closed || line.trim().length === 0) {
          return Effect.void
        }
        let decoded: unknown
        try {
          decoded = JSON.parse(line) as unknown
        } catch {
          return this.#emit('malformed', 'Codex emitted malformed JSON')
        }
        if (!isJsonValue(decoded) || !isJsonObject(decoded)) {
          return this.#emit('malformed', 'Codex emitted a non-object protocol message')
        }
        const parsed = decoded
        const id = parsed['id']
        const method = parsed['method']
        if (
          typeof id === 'number' &&
          typeof method !== 'string' &&
          (parsed['result'] !== undefined || parsed['error'] !== undefined)
        ) {
          return this.#settleResponse(id, parsed)
        }
        if (typeof method !== 'string') {
          return this.#emit(
            'malformed',
            'Codex emitted a message with no method or response payload',
          )
        }
        if (typeof id === 'string' || typeof id === 'number') {
          return this.#handleServerRequest(id, method, parsed)
        }
        return this.#handleNotification(method, parsed)
      }),
    )
  }

  #settleResponse(id: number, parsed: JsonObject): Effect.Effect<void, AgentError> {
    return this.#lifecycle.withPermits(1)(
      Ref.modify(this.#state, (state) => {
        const request = state.pending.get(id)
        if (request === undefined || request.claimed) {
          return [undefined, state]
        }
        const claimed = { ...request, claimed: true }
        return [claimed, { ...state, pending: new Map(state.pending).set(id, claimed) }]
      }).pipe(
        Effect.flatMap((request) => {
          if (request === undefined) {
            // Response-shaped, but it answers nothing Symphony sent. It is not progress, so it must not
            // re-arm the turn: a stuck server could otherwise hold a turn open with unmatched ids.
            return this.#emit(
              'unmatched_response',
              `no pending request for response id ${String(id)}`,
            )
          }
          const error = parsed['error']
          if (error !== undefined) {
            return Deferred.fail(
              request.reply,
              new AgentError({
                category: 'protocol_error',
                message: boundedMessage(protocolErrorMessage(error), this.#knownSecretValues),
              }),
            ).pipe(Effect.zipRight(this.#removePending(id, request.reply)), Effect.asVoid)
          }
          const result = parsed['result']
          if (result === undefined) {
            return Deferred.fail(
              request.reply,
              new AgentError({ category: 'protocol_error', message: 'response has no result' }),
            ).pipe(Effect.zipRight(this.#removePending(id, request.reply)), Effect.asVoid)
          }
          return this.#adoptIdentity(result).pipe(
            Effect.flatMap((identity) => {
              const turnCount = request.turnCount
              const events =
                request.method === 'thread/start'
                  ? Option.match(identity.threadId, {
                      onNone: () => Effect.void,
                      onSome: () =>
                        this.#emit('thread_started', null).pipe(
                          Effect.zipRight(this.#emit('session_started', null)),
                        ),
                    })
                  : Effect.void
              const turnStarted =
                request.method === 'turn/start' && Option.isSome(turnCount)
                  ? Option.match(identity.turnId, {
                      onNone: () => Effect.void,
                      onSome: (turnId) =>
                        this.#turnState(turnId).pipe(
                          Effect.zipRight(
                            this.#ensureTurnStarted(turnId, turnCount.value, identity.threadId),
                          ),
                        ),
                    })
                  : Effect.void
              return events.pipe(
                Effect.zipRight(turnStarted),
                Effect.zipRight(Deferred.succeed(request.reply, result)),
                Effect.zipRight(this.#removePending(id, request.reply)),
                Effect.asVoid,
              )
            }),
          )
        }),
      ),
    )
  }

  #removePending(id: number, reply: Deferred.Deferred<JsonValue, AgentError>): Effect.Effect<void> {
    return Ref.update(this.#state, (state) => {
      if (state.pending.get(id)?.reply !== reply) {
        return state
      }
      const pending = new Map(state.pending)
      pending.delete(id)
      return { ...state, pending }
    })
  }

  /**
   * Adopts the thread and turn ids carried by a response *while settling it*, not in the awaiting
   * continuation. The App Server may batch a `turn/start` response and the notifications it
   * triggers into one stdout chunk; those notifications are dispatched synchronously by the line
   * reader, long before any `await` resumes, so an id adopted by the awaiter would arrive too late
   * and every batched notification would report the previous turn — or none at all.
   */
  #adoptIdentity(
    result: JsonValue,
  ): Effect.Effect<Readonly<{ threadId: Option.Option<string>; turnId: Option.Option<string> }>> {
    const declared = responseIdentity(result)
    return Ref.modify(this.#state, (state) => {
      const threadId: Option.Option<string> = Option.orElse(
        Option.fromNullable(declared.threadId),
        () => state.threadId,
      )
      const turnId: Option.Option<string> = Option.orElse(
        Option.fromNullable(declared.turnId),
        () => state.turnId,
      )
      return [
        { threadId, turnId },
        {
          ...state,
          threadId,
          turnId,
        },
      ]
    })
  }

  #ensureTurnStarted(
    turnId: string,
    turnCount: number,
    threadId: Option.Option<string>,
  ): Effect.Effect<void> {
    return Ref.modify(this.#state, (state) => {
      if (state.startedTurns.has(turnId)) {
        return [false, state]
      }
      return [
        true,
        {
          ...state,
          startedTurns: new Set(state.startedTurns).add(turnId),
          turnCounts: new Map(state.turnCounts).set(turnId, turnCount),
          turnId: Option.some(turnId),
          turnCount,
        },
      ]
    }).pipe(
      Effect.flatMap((started) =>
        started
          ? this.#emit('turn_started', null, { threadId: Option.getOrNull(threadId), turnId })
          : Effect.void,
      ),
    )
  }

  /** `id` is echoed back in whichever form the server sent it. */
  #handleServerRequest(
    id: string | number,
    method: string,
    message: JsonObject,
  ): Effect.Effect<void> {
    // A server request declares its own thread and turn, so its events are attributed from the
    // request rather than from connection state, which is null on the first turn and names the
    // previous one afterwards.
    const identity = notificationIdentity(message)
    const turnId = Option.fromNullable(identity.turnId)
    // Only when the request names its turn; an unattributed one is not evidence that turn is alive.
    const noteActivity = Option.match(turnId, {
      onNone: () => Effect.void,
      onSome: (id) => this.#noteActivity(id),
    })
    if (isPermissionsApproval(method)) {
      return noteActivity.pipe(
        Effect.zipRight(this.#write({ id, result: withheldPermissionsGrant })),
        Effect.zipRight(this.#emit('permissions_grant_withheld', method, identity)),
      )
    }
    if (isApprovalRequest(method)) {
      return noteActivity.pipe(
        Effect.zipRight(this.#write({ id, result: { decision: 'acceptForSession' } })),
        Effect.zipRight(this.#emit('approval_auto_approved', method, identity)),
      )
    }
    if (isUserInputRequest(method)) {
      return noteActivity.pipe(
        Effect.zipRight(
          this.#write({
            id,
            error: { code: -32000, message: 'Symphony does not support interactive input' },
          }),
        ),
        Effect.zipRight(
          this.#failCurrentTurn(
            new AgentError({
              category: 'input_required',
              message: 'Codex requested interactive input',
            }),
            turnId,
          ),
        ),
      )
    }
    if (method === 'item/tool/call') {
      this.#fork(this.#handleHostToolCall(id, message, identity))
      return noteActivity
    }
    return noteActivity.pipe(
      Effect.zipRight(
        this.#write({
          id,
          error: { code: -32601, message: `Unsupported client request: ${method}` },
        }),
      ),
      Effect.zipRight(this.#emit('unsupported_tool_call', method, identity)),
    )
  }

  #handleHostToolCall(
    id: string | number,
    message: JsonObject,
    identity: ProtocolIdentity,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const { tool, arguments: argumentsValue } = hostToolCallFrom(message)
      const hostTools = this.#hostTools
      let result: HostToolResult
      if (tool === null || argumentsValue === undefined) {
        result = {
          success: false,
          error: {
            code: 'invalid_arguments',
            message: 'Host tool request is missing tool or arguments',
            retryable: false,
          },
        }
      } else if (hostTools === null) {
        result = unsupportedHostTool(tool)
      } else {
        result = yield* Effect.tryPromise({
          try: async () => await hostTools.execute(tool, argumentsValue, hostTools.context),
          catch: (): HostToolResult => ({
            success: false,
            error: {
              code: 'transport_error',
              message: 'Host tool execution failed unexpectedly',
              retryable: true,
            },
          }),
        }).pipe(Effect.catchAll(Effect.succeed))
      }
      const text = JSON.stringify(result)
      yield* this.#write({
        id,
        result: { success: result.success, contentItems: [{ type: 'inputText', text }] },
      }).pipe(
        Effect.zipRight(
          this.#emit(result.success ? 'host_tool_succeeded' : 'host_tool_failed', tool, identity),
        ),
      )
    })
  }

  #handleNotification(method: string, message: JsonObject): Effect.Effect<void, AgentError> {
    return Effect.gen(this, function* () {
      const turn = Option.fromNullable(turnFrom(message))
      const carried = notificationIdentity(message)
      const carriedThreadId = Option.fromNullable(carried.threadId)
      const carriedTurnId = Option.fromNullable(carried.turnId)
      const telemetry = telemetryFrom(method, message)
      const isTerminal = method === 'turn/completed' || method === 'turn/failed'
      const terminalStatus = isTerminal
        ? Option.map(turn, (current) =>
            Option.getOrElse(Option.fromNullable(current.status), () =>
              method === 'turn/failed' ? 'failed' : 'unreported',
            ),
          )
        : Option.none<string>()

      let reportedTurn = Option.none<TurnState>()
      if (isTerminal && Option.isSome(turn)) {
        const candidate = yield* this.#turnState(turn.value.id)
        if (!(yield* this.#claimTurn(turn.value.id, candidate))) {
          return
        }
        reportedTurn = Option.some(candidate)
      }

      let rateLimits = Option.fromNullable(telemetry.rateLimits)
      if (Option.isSome(rateLimits)) {
        const currentRateLimits = rateLimits.value
        const ready = yield* Ref.modify(this.#state, (state) => {
          if (state.rateLimitsReady) {
            return [true, state]
          }
          return [
            false,
            {
              ...state,
              pendingRateLimits: Option.some(
                mergeSparseObject(
                  Option.getOrElse(state.pendingRateLimits, () => ({})),
                  currentRateLimits,
                ),
              ),
            },
          ]
        })
        if (!ready) {
          rateLimits = Option.none()
        }
      }

      let state = yield* Ref.get(this.#state)
      const threadId = carriedThreadId.pipe(Option.orElse(() => state.threadId))
      const parsedTurnId = Option.map(turn, (current) => current.id)
      const turnId = carriedTurnId.pipe(
        Option.orElse(() => parsedTurnId),
        Option.orElse(() => state.turnId),
      )
      const pendingTurnCount = Option.fromNullable(
        [...state.pending.values()].find(
          (pending) => pending.method === 'turn/start' && Option.isSome(pending.turnCount),
        ),
      ).pipe(Option.flatMap((pending) => pending.turnCount))
      if (Option.isSome(turnId) && Option.isSome(pendingTurnCount)) {
        yield* this.#turnState(turnId.value)
        yield* this.#ensureTurnStarted(turnId.value, pendingTurnCount.value, threadId)
      }

      let usage = Option.fromNullable(telemetry.usage)
      if (method === 'turn/usage' && Option.isSome(usage) && Option.isSome(turnId)) {
        const currentUsage = usage.value
        const currentTurnId = turnId.value
        usage = Option.some(
          yield* Ref.modify(this.#state, (current) => {
            const previous = current.turnUsage.get(currentTurnId)
            const nextUsage = new Map(current.turnUsage).set(currentTurnId, {
              inputTokens: Math.max(previous?.inputTokens ?? 0, currentUsage.inputTokens),
              outputTokens: Math.max(previous?.outputTokens ?? 0, currentUsage.outputTokens),
              totalTokens: Math.max(previous?.totalTokens ?? 0, currentUsage.totalTokens),
            })
            const total = [...nextUsage.values()].reduce(
              (sum, entry) => ({
                inputTokens: sum.inputTokens + entry.inputTokens,
                outputTokens: sum.outputTokens + entry.outputTokens,
                totalTokens: sum.totalTokens + entry.totalTokens,
              }),
              { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            )
            return [total, { ...current, turnUsage: nextUsage }]
          }),
        )
      }

      const attributed = carriedTurnId.pipe(Option.orElse(() => parsedTurnId))
      yield* Option.match(attributed, {
        onNone: () => Effect.void,
        onSome: (id) => this.#noteActivity(id),
      })
      state = yield* Ref.get(this.#state)
      const eventThreadId = Option.getOrNull(threadId)
      const eventTurnId = Option.getOrNull(turnId)
      this.#onEvent({
        event: method,
        timestamp: yield* currentInstant,
        processId: this.processId,
        message: messageFrom(message, this.#knownSecretValues),
        usage: Option.getOrNull(usage),
        rateLimits: Option.getOrNull(rateLimits),
        threadId: eventThreadId,
        turnId: eventTurnId,
        sessionId: Option.match(threadId, {
          onNone: () => null,
          onSome: (id) => composeSessionId(id, eventTurnId),
        }),
        turnCount: Option.match(turnId, {
          onNone: () => state.turnCount,
          onSome: (id) => state.turnCounts.get(id) ?? state.turnCount,
        }),
        turnStatus: Option.getOrNull(terminalStatus),
        payload: normalizePayload(method, message['params'], this.#redact),
      })
      if (!isTerminal || Option.isNone(turn) || Option.isNone(reportedTurn)) {
        return
      }
      if (Option.isNone(Option.fromNullable(turn.value.status)) && method === 'turn/completed') {
        yield* this.#emit('malformed', `${method} for turn ${turn.value.id} omitted status`)
      }
      const status = Option.getOrElse(terminalStatus, () => 'unreported')
      const settlement: TurnSettlement =
        status === 'completed'
          ? { _tag: 'completed' }
          : {
              _tag: 'failed',
              error: CodexConnection.#turnFailure(turn.value.id, status),
            }
      // The claim preceded every lifecycle side effect, so a concurrent session failure either
      // won before this notification or cannot overwrite it now.
      yield* this.#completeTurn(reportedTurn.value, settlement)
    })
  }

  /**
   * Emits a client-side event. Identity carried by the message that provoked it wins over
   * connection state, which lags whenever a message arrives before the response that would set it.
   */
  #emit(
    event: string,
    message: string | null,
    carried: ProtocolIdentity = { threadId: null, turnId: null },
    turnStatus: string | null = null,
  ): Effect.Effect<void> {
    const carriedThreadId = Option.fromNullable(carried.threadId)
    const carriedTurnId = Option.fromNullable(carried.turnId)
    return Effect.all([Ref.get(this.#state), currentInstant]).pipe(
      Effect.tap(([state, timestamp]) =>
        Effect.sync(() => {
          const threadId = carriedThreadId.pipe(Option.orElse(() => state.threadId))
          const turnId = carriedTurnId.pipe(Option.orElse(() => state.turnId))
          const eventThreadId = Option.getOrNull(threadId)
          const eventTurnId = Option.getOrNull(turnId)
          const payload: AgentEventPayload = clientPayload(event, message, this.#redact)
          this.#onEvent({
            event,
            timestamp,
            processId: this.processId,
            message: message === null ? null : boundedMessage(message, this.#knownSecretValues),
            usage: null,
            rateLimits: null,
            threadId: eventThreadId,
            turnId: eventTurnId,
            sessionId: Option.match(threadId, {
              onNone: () => null,
              onSome: (id) => composeSessionId(id, eventTurnId),
            }),
            turnCount: Option.match(turnId, {
              onNone: () => state.turnCount,
              onSome: (id) => state.turnCounts.get(id) ?? state.turnCount,
            }),
            turnStatus,
            payload,
          })
        }),
      ),
      Effect.asVoid,
    )
  }

  /**
   * Records the session-level reason and settles everything still outstanding. Turns that already
   * settled keep their own result — `#settle` ignores a second write — so finished work is never
   * relabelled as a session failure.
   */
  #fail(error: AgentError, remember = true): Effect.Effect<void> {
    return this.#lifecycle.withPermits(1)(
      Effect.gen(this, function* () {
        const settlement = yield* Deferred.make<void, AgentError>()
        const activity = yield* Queue.dropping<void>(1)
        const candidate: TurnState = {
          settlement,
          activity,
          timerStarted: false,
          claimed: true,
        }
        const outstanding = yield* Ref.modify(this.#state, (state) => {
          const turns = new Map(state.turns)
          const claimedTurns: Array<readonly [string, TurnState]> = []
          if (Option.isSome(state.turnId) && !turns.has(state.turnId.value)) {
            // Publish and claim the current turn's Deferred in the same transition as the terminal
            // error. A racing response can find it, but no lifecycle notification can win settlement.
            turns.set(state.turnId.value, candidate)
            claimedTurns.push([state.turnId.value, candidate])
          }
          for (const [turnId, turn] of turns) {
            if (turn.claimed) {
              continue
            }
            const claimed = { ...turn, claimed: true }
            turns.set(turnId, claimed)
            claimedTurns.push([turnId, claimed])
          }
          return [
            {
              pending: [...state.pending.values()],
              turns: claimedTurns,
            },
            {
              ...state,
              pending: new Map(),
              turns,
              terminalError:
                remember && Option.isNone(state.terminalError)
                  ? Option.some(error)
                  : state.terminalError,
            },
          ]
        })
        yield* Effect.all(
          [
            ...outstanding.pending.map((request) =>
              Deferred.fail(request.reply, error).pipe(Effect.asVoid),
            ),
            ...outstanding.turns.map(([id, turn]) =>
              Deferred.fail(turn.settlement, error).pipe(
                Effect.tap((won) =>
                  won
                    ? this.#emit('turn/terminated', null, { threadId: null, turnId: id }, 'failed')
                    : Effect.void,
                ),
                Effect.asVoid,
              ),
            ),
          ],
          { concurrency: 'unbounded', discard: true },
        )
      }),
    )
  }

  #failUnlessClosed(error: AgentError): Effect.Effect<void> {
    return Ref.get(this.#state).pipe(
      Effect.flatMap((state) => (state.closed ? Effect.void : this.#fail(error))),
    )
  }
}

const rejectWorkspaceLaunch = (error: WorkspaceError): AgentError =>
  new AgentError({
    category: 'workspace_rejected',
    message: `refusing to launch Codex: ${error.message}`,
    cause: error,
  })

const runVerifiedAgent = (
  launch: AgentLaunch,
  verified: VerifiedWorkspace,
  fileSystem: FileSystem.FileSystem,
): Effect.Effect<AgentResult, AgentError> => {
  /**
   * A path string is re-resolved by the kernel at every consumer, so the identity is re-bound at
   * each path-consuming boundary: after the process is created and before every turn. A directory
   * renamed and replaced by a symlink in between is rejected rather than followed.
   *
   * The filesystem is the one bound at launch rather than read from the calling fiber, so a rebind
   * runs the same way from a forked reader as it does from the session's own fiber.
   */
  const rebind = (): Effect.Effect<void, AgentError> =>
    assertWorkspaceIdentity(launch.workspaceRoot, verified).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.mapError(rejectWorkspaceLaunch),
    )

  /**
   * The session's readers are forked against this scope, so they belong to the run rather than to
   * the default runtime. The scope closes after the session has stopped, which is where a reader
   * the stop did not already finish is interrupted.
   */
  const openConnection = (
    runtime: Runtime.Runtime<never>,
    scope: Scope.Scope,
  ): Effect.Effect<CodexConnection, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.all([
        sessionSecretValues(launch.secretEnvironmentNames),
        Ref.make(initialConnectionState),
        Effect.makeSemaphore(1),
      ]).pipe(
        Effect.map(
          ([knownSecretValues, state, lifecycle]) =>
            new CodexConnection(
              launch.config.command,
              verified.path,
              launch.config,
              launch.secretEnvironmentNames,
              knownSecretValues,
              launch.hostTools ?? null,
              launch.onEvent,
              (reader) => Runtime.runFork(runtime)(reader, { scope }),
              state,
              lifecycle,
            ),
        ),
      ),
      (connection) => connection.stop(),
    )

  return Effect.scoped(
    Effect.gen(function* () {
      const [runtime, scope] = yield* Effect.all([Effect.runtime<never>(), Effect.scope])
      const connection = yield* openConnection(runtime, scope)
      yield* rebind()
      const threadId = yield* connection.initialize(launch.config, verified.path)
      // Re-bound after the boundary too: a swap during the request window is then detected and the
      // session torn down before any turn runs.
      yield* rebind()
      let turnId = ''
      let turnCount = 0
      while (turnCount < launch.maxTurns) {
        const turnPrompt =
          turnCount === 0
            ? launch.prompt
            : 'Continue working on the issue. Review prior progress and complete the next necessary step.'
        yield* rebind()
        turnId = yield* connection.startTurn(
          threadId,
          verified.path,
          launch.config,
          turnPrompt,
          turnCount + 1,
        )
        yield* rebind()
        yield* connection.awaitTurn(turnId)
        turnCount += 1
        const refreshed = yield* launch.refreshIssue().pipe(Effect.map(Option.fromNullable))
        if (Option.isNone(refreshed) || !launch.isRoutable(refreshed.value)) {
          break
        }
      }
      return { threadId, turnId, turnCount }
    }).pipe(
      Effect.catchAllDefect((cause: unknown) =>
        Effect.fail(
          cause instanceof AgentError
            ? cause
            : new AgentError({
                category: 'protocol_error',
                message: `Codex session failed for ${launch.issue.identifier}`,
                cause,
              }),
        ),
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
export const runAgent = (
  launch: AgentLaunch,
): Effect.Effect<AgentResult, AgentError, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    Effect.scoped(
      openVerifiedWorkspace(launch.workspaceRoot, launch.workspace).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.mapError(rejectWorkspaceLaunch),
        Effect.flatMap((verified) => runVerifiedAgent(launch, verified, fileSystem)),
      ),
    ),
  )
