import { FileSystem } from '@effect/platform'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Effect, Either, Option, ParseResult, Schema } from 'effect'
import { parse } from 'yaml'

import { expandHomePath, resolvePathReference } from '@symphony/core/config/env-reference.js'
import {
  workflowDefaults,
  type EffectiveConfig,
  type RunnerConfig,
  type Workflow,
} from '@symphony/core/config/workflow.js'
import type { JsonObject, JsonValue } from '@symphony/core/domain/domain.js'
import { WorkflowError } from '@symphony/core/domain/errors.js'
import type {
  AgentRunnerRegistry,
  ValidatedAgentRunner,
} from '@symphony/core/domain/agent-runner-provider.js'
import type { PreflightResult } from '@symphony/core/ports/workflow.js'
import type {
  TrackerProviderRegistry,
  ValidatedTrackerProvider,
} from '@symphony/core/domain/tracker-provider.js'
import {
  emptyJsonObject,
  isJsonObject,
  JsonConversionError,
  toJsonObject,
  toJsonValue,
} from '@symphony/core/support/json.js'

/**
 * Reading a workflow definition off disk is composition-root work: the shapes it produces
 * ({@link Workflow}, {@link EffectiveConfig}) are core vocabulary, but the YAML dialect, the
 * environment indirection, and the filesystem are the application's business. The composition root
 * binds this module to `WorkflowLoader` so that no layer below it names a file format.
 */
const knownSections = new Set([
  'tracker',
  'polling',
  'workspace',
  'hooks',
  'agent',
  'runner',
  'codex',
  'server',
  'handoff',
])

/**
 * The fields the core consumes itself, spelled as the document spells them. They are the same under
 * `runner` and under the deprecated `codex` alias; everything else a runner section carries is that
 * adapter's business and travels through as `settings`.
 */
const neutralRunnerKeys = new Set([
  'command',
  'turn_timeout_ms',
  'read_timeout_ms',
  'stall_timeout_ms',
])

/**
 * Front-matter vocabulary.
 *
 * Every field is declared with the key as the document spells it, because a message has to name
 * what the author wrote rather than a position in a decoded tree. Each one carries its message at
 * every level the value can fail — the base type and each refinement over it — so a wrong type and
 * a wrong value read the same way, which is what one imperative decoder checking both used to do.
 */
const nonEmptyString = (name: string): Schema.Schema<string, string> => {
  const message = (): string => `${name} must be a non-empty string`
  return Schema.String.annotations({ message })
    .pipe(Schema.filter((value) => value.length > 0))
    .annotations({ message })
}

/** A command is authored as a shell line, so whitespace alone is as empty as the empty string. */
const commandString = (name: string): Schema.Schema<string, string> =>
  nonEmptyString(name)
    .pipe(Schema.filter((value) => value.trim().length > 0))
    .annotations({ message: () => `${name} must be a non-empty string` })

const integer = (name: string): Schema.Schema<number, number> => {
  const message = (): string => `${name} must be an integer`
  return Schema.Number.annotations({ message }).pipe(Schema.int()).annotations({ message })
}

const positiveInteger = (name: string): Schema.Schema<number, number> =>
  integer(name)
    .pipe(Schema.filter((value) => value > 0))
    .annotations({ message: () => `${name} must be a positive integer` })

const nonNegativeInteger = (name: string): Schema.Schema<number, number> =>
  integer(name)
    .pipe(Schema.filter((value) => value >= 0))
    .annotations({ message: () => `${name} must not be negative` })

const portNumber = (name: string): Schema.Schema<number, number> =>
  integer(name)
    .pipe(Schema.filter((value) => value >= 0 && value <= 65_535))
    .annotations({ message: () => `${name} must be between 0 and 65535` })

const booleanValue = (name: string): Schema.Schema<boolean, boolean> =>
  Schema.Boolean.annotations({ message: () => `${name} must be a boolean` })

const strings = (name: string): Schema.Schema<readonly string[], readonly string[]> => {
  const message = (): string => `${name} must be a list of strings`
  return Schema.Array(Schema.String.annotations({ message })).annotations({ message })
}

/** A map this core does not look inside, named so that a failure still reports the section. */
const anyMap = (
  name: string,
): Schema.Schema<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>> =>
  Schema.Record({ key: Schema.String, value: Schema.Unknown }).annotations({
    message: () => `${name} must be a map`,
  })

/** `toJsonValue` rejects by throwing; this is the message the schema reports in its place. */
const jsonSafely = <A>(convert: () => A, name: string): Either.Either<A, string> => {
  try {
    return Either.right(convert())
  } catch (cause: unknown) {
    return Either.left(
      cause instanceof JsonConversionError
        ? `${cause.path} must be a JSON-safe value`
        : `${name} must be a map`,
    )
  }
}

/**
 * Adapter-owned configuration: checked to be a map and convertible to exact JSON, and otherwise
 * passed through as authored. The core never decodes what is inside it — the adapter that owns the
 * kind does that — so the only failure it can report is a value JSON cannot carry.
 */
const jsonObject = (name: string): Schema.Schema<JsonObject, Readonly<Record<string, unknown>>> =>
  Schema.transformOrFail(anyMap(name), Schema.declare(isJsonObject), {
    decode: (value, _options, ast) =>
      Either.match(
        jsonSafely(() => toJsonObject(value, name), name),
        {
          onLeft: (message) => ParseResult.fail(new ParseResult.Type(ast, value, message)),
          onRight: ParseResult.succeed,
        },
      ),
    encode: (value: JsonObject) => ParseResult.succeed(value),
  })

const trackerSection = Schema.Struct({
  kind: Schema.propertySignature(nonEmptyString('tracker.kind')).annotations({
    missingMessage: () => 'tracker.kind must be a non-empty string',
  }),
  provider: Schema.propertySignature(jsonObject('tracker.provider')).annotations({
    missingMessage: () => 'tracker.provider must be a map',
  }),
  required_labels: Schema.optional(strings('tracker.required_labels')),
  active_states: Schema.optional(strings('tracker.active_states')),
  terminal_states: Schema.optional(strings('tracker.terminal_states')),
}).annotations({ message: () => 'tracker must be a map' })

const pollingSection = Schema.Struct({
  interval_ms: Schema.optional(positiveInteger('polling.interval_ms')),
}).annotations({ message: () => 'polling must be a map' })

const workspaceSection = Schema.Struct({
  root: Schema.optional(nonEmptyString('workspace.root')),
}).annotations({ message: () => 'workspace must be a map' })

const hooksSection = Schema.Struct({
  after_create: Schema.optional(nonEmptyString('hooks.after_create')),
  before_run: Schema.optional(nonEmptyString('hooks.before_run')),
  after_run: Schema.optional(nonEmptyString('hooks.after_run')),
  before_remove: Schema.optional(nonEmptyString('hooks.before_remove')),
  timeout_ms: Schema.optional(positiveInteger('hooks.timeout_ms')),
}).annotations({ message: () => 'hooks must be a map' })

const agentSection = Schema.Struct({
  max_concurrent_agents: Schema.optional(positiveInteger('agent.max_concurrent_agents')),
  max_turns: Schema.optional(positiveInteger('agent.max_turns')),
  max_retry_backoff_ms: Schema.optional(positiveInteger('agent.max_retry_backoff_ms')),
  // Per-state limits are authored freely and normalized later: the section has to be a map, and
  // what it maps to is judged one entry at a time rather than failing the whole workflow.
  max_concurrent_agents_by_state: Schema.optional(anyMap('agent.max_concurrent_agents_by_state')),
}).annotations({ message: () => 'agent must be a map' })

/**
 * The agent-runner section. `kind` selects the adapter, the four neutral fields are the ones the
 * core consumes itself, and `settings` is preserved verbatim for the adapter that owns the kind —
 * the same split `tracker` already has between its own fields and `provider`.
 */
const runnerSection = Schema.Struct({
  kind: Schema.optional(nonEmptyString('runner.kind')),
  command: Schema.optional(commandString('runner.command')),
  turn_timeout_ms: Schema.optional(positiveInteger('runner.turn_timeout_ms')),
  read_timeout_ms: Schema.optional(positiveInteger('runner.read_timeout_ms')),
  stall_timeout_ms: Schema.optional(nonNegativeInteger('runner.stall_timeout_ms')),
  settings: Schema.optional(jsonObject('runner.settings')),
}).annotations({ message: () => 'runner must be a map' })

/**
 * The deprecated `codex` alias, kept so every workflow written before `runner` existed keeps
 * loading unchanged. A document that declares it and no `runner` section is read as
 * `runner: {kind: codex}`: the four fields below are the runner's own, and every other key the
 * block carries becomes `runner.settings` for the Codex adapter to validate. Nothing here checks
 * those other keys, which is the point — what values they may take is the adapter's to know, and
 * this loader stopped knowing it when the second runner became possible.
 */
const codexSection = Schema.Struct({
  command: Schema.optional(commandString('codex.command')),
  turn_timeout_ms: Schema.optional(positiveInteger('codex.turn_timeout_ms')),
  read_timeout_ms: Schema.optional(positiveInteger('codex.read_timeout_ms')),
  stall_timeout_ms: Schema.optional(nonNegativeInteger('codex.stall_timeout_ms')),
}).annotations({ message: () => 'codex must be a map' })

const serverSection = Schema.Struct({
  port: Schema.optional(portNumber('server.port')),
}).annotations({ message: () => 'server must be a map' })

/**
 * The key that owns the pull-request handoff extension, declared here the same way `server` owns
 * the HTTP one. It is read once, when the composition root decides which services to compose, so a
 * document that changes it takes effect on the next start rather than on a reload.
 */
const handoffSection = Schema.Struct({
  enabled: Schema.optional(booleanValue('handoff.enabled')),
}).annotations({ message: () => 'handoff must be a map' })

/**
 * The sections this core understands, keyed as the document spells them: the decoded record is the
 * authored one, and the names the rest of the program uses are given to it by {@link parseConfig}.
 * A section the document omits is absent rather than empty, so the defaults stay in one place
 * instead of being spread across the schema.
 */
const workflowSections = Schema.Struct({
  tracker: Schema.propertySignature(trackerSection).annotations({
    missingMessage: () => 'tracker must be a map',
  }),
  polling: Schema.optional(pollingSection),
  workspace: Schema.optional(workspaceSection),
  hooks: Schema.optional(hooksSection),
  agent: Schema.optional(agentSection),
  runner: Schema.optional(runnerSection),
  codex: Schema.optional(codexSection),
  server: Schema.optional(serverSection),
  handoff: Schema.optional(handoffSection),
}).annotations({ message: () => 'workflow front matter must be a map' })

/**
 * Everything else the document declared. Unknown keys are not configuration this core understands,
 * so they are neither decoded nor dropped: they are carried through as exact JSON for whoever does
 * understand them.
 */
const workflowExtensions = Schema.transformOrFail(
  anyMap('workflow front matter'),
  Schema.declare(isJsonObject),
  {
    decode: (root, _options, ast) => {
      const entries = Object.entries(root).filter(([key]) => !knownSections.has(key))
      if (entries.length === 0) {
        return ParseResult.succeed(emptyJsonObject)
      }
      return Either.match(
        jsonSafely(
          () =>
            Object.freeze(
              Object.fromEntries(
                entries.map(
                  ([key, value]) =>
                    [key, toJsonValue(value, key)] as const satisfies readonly [string, JsonValue],
                ),
              ),
            ),
          'workflow front matter',
        ),
        {
          onLeft: (message) => ParseResult.fail(new ParseResult.Type(ast, root, message)),
          onRight: ParseResult.succeed,
        },
      )
    },
    encode: (value: JsonObject) => ParseResult.succeed(value),
  },
)

/**
 * The authored document, decoded: every value the front matter supplied, with the ones it omitted
 * absent rather than defaulted, and the keys this core does not know preserved beside them.
 */
type RawWorkflowConfig = Readonly<
  typeof workflowSections.Type & { readonly extensions: JsonObject }
>

/**
 * The message to report for a rejected document. A `ParseError` carries one issue per failure with
 * a path into the offending value; decoding stops at the first, and its message is the one the
 * field declared. The fallback is unreachable — a `ParseError` always carries an issue — and exists
 * so that reporting never depends on that.
 */
const invalidConfig = (error: ParseResult.ParseError): WorkflowError =>
  new WorkflowError({
    category: 'invalid_config',
    message:
      ParseResult.ArrayFormatter.formatIssueSync(error.issue)[0]?.message ??
      'workflow front matter is invalid',
  })

/**
 * Decodes the document. The sections and the extension keys are two readings of the same map, run
 * in that order so a document that is wrong in both places reports the configuration error rather
 * than the extension one.
 */
const decodeFrontMatter = (value: unknown): Effect.Effect<RawWorkflowConfig, WorkflowError> =>
  Effect.all({
    sections: Schema.decodeUnknown(workflowSections)(value),
    extensions: Schema.decodeUnknown(workflowExtensions)(value),
  }).pipe(
    Effect.map(({ sections, extensions }) => ({ ...sections, extensions })),
    // The `ParseError` itself is not kept as the cause: it renders the offending value, and a
    // rejected document is exactly where a mistyped credential is most likely to be sitting.
    Effect.mapError(invalidConfig),
  )

const resolveWorkspaceRoot = (
  value: string | undefined,
  workflowPath: string,
): Effect.Effect<string, WorkflowError> =>
  (value === undefined
    ? Effect.succeed(join(tmpdir(), workflowDefaults.workspaceRootBasename))
    : resolvePathReference(value, 'workspace.root').pipe(Effect.map(expandHomePath))
  ).pipe(
    Effect.map((configured) =>
      resolve(isAbsolute(configured) ? configured : join(dirname(workflowPath), configured)),
    ),
  )

/**
 * Per-state limits are the one place a bad entry is dropped rather than rejected: the states a
 * tracker reports are the tracker's vocabulary, and a workflow naming one that cannot carry a limit
 * should not stop the run. A limit that is not a whole number above zero is no limit at all.
 */
const parseConcurrencyByState = (
  value: Readonly<Record<string, unknown>> | undefined,
): ReadonlyMap<string, number> =>
  new Map(
    Object.entries(value ?? {}).flatMap(([state, limit]) =>
      typeof limit === 'number' && Number.isInteger(limit) && limit > 0
        ? ([[state.trim().toLowerCase(), limit]] as const)
        : [],
    ),
  )

/**
 * The runner selection a document declares, before any adapter has seen it.
 *
 * Declaring both `runner` and the deprecated `codex` alias is refused rather than merged: the two
 * would have to be reconciled field by field, and an operator who wrote both has a belief about
 * which one is in force that this loader cannot read.
 */
type AuthoredRunner = Readonly<{
  kind: string | null
  settings: JsonObject
  /** The section name the author actually used, so a rejection can name it back to them. */
  section: 'runner' | 'codex'
}>

/**
 * Re-spells an adapter's rejection in the section the author wrote.
 *
 * An adapter validates `runner.settings` and says so, because that is the only name it knows. A
 * document using the deprecated alias never wrote those words, and this file's whole convention is
 * that a message names what the author wrote rather than a position in a decoded tree. The alias is
 * this loader's fiction, so translating the message back out of it is this loader's job.
 */
const inAuthoredSection = (
  section: AuthoredRunner['section'],
  error: WorkflowError,
): WorkflowError =>
  section === 'runner'
    ? error
    : new WorkflowError({
        category: error.category,
        message: error.message.replace(/^runner\.settings\./u, 'codex.'),
        cause: error.cause,
      })

const authoredRunner = (
  raw: RawWorkflowConfig,
  frontMatter: JsonObject,
): Effect.Effect<AuthoredRunner, WorkflowError> => {
  if (raw.runner !== undefined && raw.codex !== undefined) {
    return Effect.fail(
      new WorkflowError({
        category: 'invalid_config',
        message:
          'runner and codex must not both be declared; codex is the deprecated spelling of runner.kind codex',
      }),
    )
  }
  if (raw.runner !== undefined) {
    return Effect.succeed({
      kind: raw.runner.kind ?? null,
      settings: raw.runner.settings ?? emptyJsonObject,
      section: 'runner',
    })
  }
  if (raw.codex === undefined) {
    return Effect.succeed({ kind: null, settings: emptyJsonObject, section: 'runner' })
  }
  // Under the alias the adapter's settings are whatever the block carries beyond the neutral
  // fields, read from the authored map so a key this loader no longer knows still reaches the
  // adapter that does. It is converted rather than tested: a value JSON cannot carry has to be
  // reported against the key that holds it, not quietly dropped on the way to the adapter.
  return Either.match(
    jsonSafely(() => toJsonObject(frontMatter['codex'], 'codex'), 'codex'),
    {
      onLeft: (message) => Effect.fail(new WorkflowError({ category: 'invalid_config', message })),
      onRight: (authored) =>
        Effect.succeed({
          kind: 'codex',
          settings: Object.freeze(
            Object.fromEntries(
              Object.entries(authored).filter(([key]) => !neutralRunnerKeys.has(key)),
            ),
          ),
          section: 'codex' as const,
        }),
    },
  )
}

/**
 * The rest of the configuration, once the one environment-dependent field is resolved. Every value
 * here has already been checked by the schema, so this only applies the documented defaults.
 *
 * `defaultCommand` comes from the selected runner's adapter rather than from `workflowDefaults`: it
 * names a specific executable, which is the one part of the neutral configuration only the backend
 * can supply.
 */
const parseConfig = (
  raw: RawWorkflowConfig,
  workspaceRoot: string,
  runner: AuthoredRunner,
  defaultCommand: string,
): EffectiveConfig => {
  const { tracker, polling, hooks, agent, codex, server, handoff } = raw
  const declared = raw.runner ?? codex
  const runnerConfig: RunnerConfig = {
    command: declared?.command ?? defaultCommand,
    turnTimeoutMs: declared?.turn_timeout_ms ?? workflowDefaults.turnTimeoutMs,
    readTimeoutMs: declared?.read_timeout_ms ?? workflowDefaults.readTimeoutMs,
    stallTimeoutMs: declared?.stall_timeout_ms ?? workflowDefaults.stallTimeoutMs,
    settings: runner.settings,
  }
  return {
    tracker: {
      kind: tracker.kind,
      provider: tracker.provider,
      requiredLabels: (tracker.required_labels ?? []).map((label) => label.trim().toLowerCase()),
      activeStates: tracker.active_states ?? workflowDefaults.activeStates,
      terminalStates: tracker.terminal_states ?? workflowDefaults.terminalStates,
    },
    pollingIntervalMs: polling?.interval_ms ?? workflowDefaults.pollingIntervalMs,
    workspaceRoot,
    hooks: {
      afterCreate: hooks?.after_create ?? null,
      beforeRun: hooks?.before_run ?? null,
      afterRun: hooks?.after_run ?? null,
      beforeRemove: hooks?.before_remove ?? null,
      timeoutMs: hooks?.timeout_ms ?? workflowDefaults.hookTimeoutMs,
    },
    agent: {
      maxConcurrentAgents: agent?.max_concurrent_agents ?? workflowDefaults.maxConcurrentAgents,
      maxTurns: agent?.max_turns ?? workflowDefaults.maxTurns,
      maxRetryBackoffMs: agent?.max_retry_backoff_ms ?? workflowDefaults.maxRetryBackoffMs,
      maxConcurrentAgentsByState: parseConcurrencyByState(agent?.max_concurrent_agents_by_state),
    },
    runner: runnerConfig,
    serverPort: server?.port ?? null,
    handoffEnabled: handoff?.enabled ?? workflowDefaults.handoffEnabled,
    extensions: raw.extensions,
  }
}

/** Separates the YAML front matter from the prompt template that follows it. */
const splitWorkflow = (
  source: string,
): Effect.Effect<Readonly<{ config: unknown; prompt: string }>, WorkflowError> => {
  if (!source.startsWith('---')) {
    return Effect.succeed({ config: {}, prompt: source.trim() })
  }
  const lines = source.split(/\r?\n/u)
  const closing = lines.findIndex((line, index) => index > 0 && line === '---')
  if (closing < 0) {
    return Effect.fail(
      new WorkflowError({
        category: 'workflow_parse_error',
        message: 'YAML front matter is not closed',
      }),
    )
  }
  const prompt = lines
    .slice(closing + 1)
    .join('\n')
    .trim()
  return Effect.try({
    try: () => parse(lines.slice(1, closing).join('\n')) as unknown,
    catch: (cause: unknown) =>
      new WorkflowError({
        category: 'workflow_parse_error',
        message: 'invalid YAML front matter',
        cause,
      }),
  }).pipe(Effect.map((config) => ({ config, prompt })))
}

/**
 * The front matter has to be a map before any of it can be decoded, and a document that is a list
 * or a scalar is a different failure from one whose fields are wrong: it declares nothing this
 * loader can act on, so it keeps its own category.
 */
const frontMatterMap = (value: unknown): Effect.Effect<unknown, WorkflowError> =>
  isJsonObject(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new WorkflowError({
          category: 'workflow_front_matter_not_a_map',
          message: 'workflow front matter must be a map',
        }),
      )

/**
 * Re-runs the validation that must hold before every dispatch: an adapter-accepted
 * `tracker.provider` (including its secret indirection) and a usable `codex.command`.
 *
 * The provider is re-read from the workflow, so an edit to `tracker.provider` takes effect; the
 * adapter that validates it comes from the selection rather than from a registry looked up again by
 * kind. A workflow loaded with a caller's own registry therefore keeps revalidating through that
 * registry's adapter: routing this through a default registry instead would report every kind the
 * default does not carry as unsupported, and the run would silently keep its superseded credential.
 */
export const preflightWorkflow = (
  workflow: Workflow,
): Effect.Effect<PreflightResult, WorkflowError> =>
  Effect.suspend(() =>
    workflow.config.runner.command.trim().length === 0
      ? Effect.fail(
          new WorkflowError({
            category: 'invalid_config',
            message: 'runner.command must be a non-empty string',
          }),
        )
      : // Both selections are revalidated, each through the adapter that produced it, and both are
        // returned. An adapter resolves `$VAR` indirection at validation time, so discarding either
        // would revalidate a rotated credential and then go on using the superseded one. The rule
        // between them is re-checked against the results, so a rotated tracker token that collides
        // with the runner's own authentication fails preflight rather than dispatch.
        Effect.all({
          runner: workflow.runner.revalidate(workflow.config.runner.settings),
          tracker: workflow.tracker.revalidate(workflow.config.tracker.provider),
        }).pipe(Effect.tap(({ tracker, runner }) => reserveRunnerCredentials(tracker, runner))),
  ).pipe(
    Effect.catchAllDefect((cause: unknown) =>
      Effect.fail(
        new WorkflowError({
          category: 'invalid_config',
          message: 'workflow preflight validation failed',
          cause,
        }),
      ),
    ),
  )

/**
 * The adapters a workflow is read against: which tracker kinds this build supports, which runner
 * kinds it supports, and which runner a document that names none is read as.
 *
 * The default kind is supplied rather than assumed because this module must not name a backend;
 * the composition root's runner registry is the one place a concrete kind appears.
 */
export type WorkflowAdapters = Readonly<{
  trackers: TrackerProviderRegistry
  runners: AgentRunnerRegistry
  defaultRunnerKind: string
}>

/**
 * The registered runner for a kind, so the default command is known before the configuration is
 * assembled. `validate` reports the unsupported kind too, but only after the command default has
 * already been needed.
 */
const unsupportedRunnerKind = (
  runners: AgentRunnerRegistry,
  kind: string,
): Effect.Effect<Readonly<{ defaultCommand: string }>, WorkflowError> =>
  Option.match(runners.get(kind), {
    onNone: () =>
      Effect.fail(
        new WorkflowError({
          category: 'invalid_config',
          message: `unsupported runner.kind: ${kind} (supported: ${runners.kinds.join(', ')})`,
        }),
      ),
    onSome: (entry) => Effect.succeed(entry),
  })

/**
 * Refuses a tracker credential that names one of the selected runner's own authentication
 * variables.
 *
 * The host has to both strip tracker secrets from the agent's environment and preserve the
 * runner's authentication in it; a variable that is both cannot be honoured either way. The rule
 * used to be a constant inside the secret resolver, which meant it only ever knew one backend's
 * names. It belongs here instead: this is the one place both selections are in hand, and the names
 * come from whichever runner the workflow actually chose.
 */
const reserveRunnerCredentials = (
  tracker: ValidatedTrackerProvider,
  runner: ValidatedAgentRunner,
): Effect.Effect<void, WorkflowError> => {
  const reserved = new Set(runner.authenticationEnvironmentNames)
  const collision = tracker.secretEnvironmentNames.find((name) => reserved.has(name))
  return collision === undefined
    ? Effect.void
    : Effect.fail(
        new WorkflowError({
          category: 'invalid_config',
          message: `tracker credentials must not use ${runner.kind} authentication environment variable ${collision}`,
        }),
      )
}

const readWorkflowSource = (
  path: string,
): Effect.Effect<string, WorkflowError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path, 'utf8')),
    Effect.mapError(
      (cause) =>
        new WorkflowError({
          category: 'missing_workflow_file',
          message: `cannot read workflow file: ${path}`,
          cause,
        }),
    ),
  )

/**
 * Reads and validates a workflow definition.
 *
 * `providers` is supplied by the caller rather than defaulted here: the registry names concrete
 * adapters, and this layer must not reach up to the composition root to find them. The selection
 * this returns carries the adapter that validated it, so every later revalidation stays with the
 * registry used here.
 *
 * The environment is read through the calling fiber's `ConfigProvider` rather than passed in, so a
 * caller supplies a test provider the same way production supplies the process environment.
 */
export const loadWorkflow = (
  path: string,
  adapters: WorkflowAdapters,
): Effect.Effect<Workflow, WorkflowError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const source = yield* readWorkflowSource(path)
    const definition = yield* splitWorkflow(source)
    const frontMatter = yield* frontMatterMap(definition.config)
    const raw = yield* decodeFrontMatter(frontMatter)
    const workspaceRoot = yield* resolveWorkspaceRoot(raw.workspace?.root, path)
    const authored = yield* authoredRunner(raw, isJsonObject(frontMatter) ? frontMatter : {})
    const kind = authored.kind ?? adapters.defaultRunnerKind
    // The runner is selected before the configuration is assembled, because the default command is
    // the adapter's rather than this loader's, and validated before the tracker, because the
    // credential rule below is stated against the runner's own authentication.
    const entry = yield* unsupportedRunnerKind(adapters.runners, kind)
    const config = parseConfig(raw, workspaceRoot, authored, entry.defaultCommand)
    const runner = yield* adapters.runners
      .validate(kind, authored.settings)
      .pipe(Effect.mapError((error) => inAuthoredSection(authored.section, error)))
    const tracker = yield* adapters.trackers.validate(config.tracker.kind, config.tracker.provider)
    yield* reserveRunnerCredentials(tracker, runner)
    return {
      path,
      fingerprint: createHash('sha256').update(source).digest('hex'),
      config,
      tracker,
      runner,
      promptTemplate: definition.prompt,
    }
  })
