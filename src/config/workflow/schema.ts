import { Effect, Either, ParseResult, Schema } from 'effect'

import type { JsonObject, JsonValue } from '@sloppenheimer/core/domain/domain.js'
import { WorkflowError } from '@sloppenheimer/core/domain/errors.js'
import {
  emptyJsonObject,
  isJsonObject,
  JsonConversionError,
  toJsonObject,
  toJsonValue,
} from '@sloppenheimer/core/support/json.js'

/**
 * The YAML dialect a workflow definition is authored in, as a schema.
 *
 * Every field is declared with the key as the document spells it, because a message has to name
 * what the author wrote rather than a position in a decoded tree. Each one carries its message at
 * every level the value can fail — the base type and each refinement over it — so a wrong type and
 * a wrong value read the same way, which is what one imperative decoder checking both used to do.
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
export const jsonSafely = <A>(convert: () => A, name: string): Either.Either<A, string> => {
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
export type RawWorkflowConfig = Readonly<
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
export const decodeFrontMatter = (
  value: unknown,
): Effect.Effect<RawWorkflowConfig, WorkflowError> =>
  Effect.all({
    sections: Schema.decodeUnknown(workflowSections)(value),
    extensions: Schema.decodeUnknown(workflowExtensions)(value),
  }).pipe(
    Effect.map(({ sections, extensions }) => ({ ...sections, extensions })),
    // The `ParseError` itself is not kept as the cause: it renders the offending value, and a
    // rejected document is exactly where a mistyped credential is most likely to be sitting.
    Effect.mapError(invalidConfig),
  )
