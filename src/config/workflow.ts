import { FileSystem } from '@effect/platform'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Effect, Either, ParseResult, Schema } from 'effect'
import { parse } from 'yaml'

import { expandHomePath, resolvePathReference } from '@symphony/core/config/env-reference.js'
import {
  codexApprovalPolicies,
  codexSandboxModes,
  workflowDefaults,
  type EffectiveConfig,
  type Workflow,
} from '@symphony/core/config/workflow.js'
import type { JsonObject, JsonValue } from '@symphony/core/domain/domain.js'
import { WorkflowError } from '@symphony/core/domain/errors.js'
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
  'codex',
  'server',
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

const strings = (name: string): Schema.Schema<readonly string[], readonly string[]> => {
  const message = (): string => `${name} must be a list of strings`
  return Schema.Array(Schema.String.annotations({ message })).annotations({ message })
}

const enumeratedValue = (name: string, allowed: readonly string[]): Schema.Schema<string, string> =>
  nonEmptyString(name)
    .pipe(Schema.filter((value) => allowed.includes(value)))
    .annotations({ message: () => `${name} must be one of: ${allowed.join(', ')}` })

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

const codexSection = Schema.Struct({
  command: Schema.optional(commandString('codex.command')),
  approval_policy: Schema.optional(enumeratedValue('codex.approval_policy', codexApprovalPolicies)),
  thread_sandbox: Schema.optional(enumeratedValue('codex.thread_sandbox', codexSandboxModes)),
  turn_sandbox_policy: Schema.optional(jsonObject('codex.turn_sandbox_policy')),
  turn_timeout_ms: Schema.optional(positiveInteger('codex.turn_timeout_ms')),
  read_timeout_ms: Schema.optional(positiveInteger('codex.read_timeout_ms')),
  stall_timeout_ms: Schema.optional(nonNegativeInteger('codex.stall_timeout_ms')),
}).annotations({ message: () => 'codex must be a map' })

const serverSection = Schema.Struct({
  port: Schema.optional(portNumber('server.port')),
}).annotations({ message: () => 'server must be a map' })

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
  codex: Schema.optional(codexSection),
  server: Schema.optional(serverSection),
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
 * The rest of the configuration, once the one environment-dependent field is resolved. Every value
 * here has already been checked by the schema, so this only applies the documented defaults.
 */
const parseConfig = (raw: RawWorkflowConfig, workspaceRoot: string): EffectiveConfig => {
  const { tracker, polling, hooks, agent, codex, server } = raw
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
    codex: {
      command: codex?.command ?? workflowDefaults.codexCommand,
      approvalPolicy: codex?.approval_policy ?? workflowDefaults.approvalPolicy,
      threadSandbox: codex?.thread_sandbox ?? workflowDefaults.threadSandbox,
      turnSandboxPolicy: codex?.turn_sandbox_policy ?? null,
      turnTimeoutMs: codex?.turn_timeout_ms ?? workflowDefaults.turnTimeoutMs,
      readTimeoutMs: codex?.read_timeout_ms ?? workflowDefaults.readTimeoutMs,
      stallTimeoutMs: codex?.stall_timeout_ms ?? workflowDefaults.stallTimeoutMs,
    },
    serverPort: server?.port ?? null,
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
): Effect.Effect<ValidatedTrackerProvider, WorkflowError> =>
  Effect.suspend(() =>
    workflow.config.codex.command.trim().length === 0
      ? Effect.fail(
          new WorkflowError({
            category: 'invalid_config',
            message: 'codex.command must be a non-empty string',
          }),
        )
      : workflow.tracker.revalidate(workflow.config.tracker.provider),
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
  providers: TrackerProviderRegistry,
): Effect.Effect<Workflow, WorkflowError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const source = yield* readWorkflowSource(path)
    const definition = yield* splitWorkflow(source)
    const frontMatter = yield* frontMatterMap(definition.config)
    const raw = yield* decodeFrontMatter(frontMatter)
    const workspaceRoot = yield* resolveWorkspaceRoot(raw.workspace?.root, path)
    const config = parseConfig(raw, workspaceRoot)
    const tracker = yield* providers.validate(config.tracker.kind, config.tracker.provider)
    return {
      path,
      fingerprint: createHash('sha256').update(source).digest('hex'),
      config,
      tracker,
      promptTemplate: definition.prompt,
    }
  })
