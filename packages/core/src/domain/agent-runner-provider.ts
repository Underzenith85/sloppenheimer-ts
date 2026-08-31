import { Effect, Option } from 'effect'

import type { JsonObject } from './domain.js'
import { WorkflowError } from './errors.js'

/**
 * One agent-runner selection, validated by the adapter that owns its `kind`.
 *
 * This mirrors {@link ValidatedTrackerProvider}: `settings` is opaque here, threaded back to the
 * adapter that produced it and never read field by field, so no backend's settings type reaches
 * the core configuration surface. The two facts the core does need — which environment variables
 * carry this runner's own authentication, and whether a revalidation produced the same selection —
 * the adapter supplies alongside it.
 */
export type ValidatedAgentRunner = Readonly<{
  kind: string
  settings: unknown
  /**
   * Environment variables this runner authenticates with. The host never strips them from the
   * agent subprocess, and tracker configuration may not reuse them: both rules are facts about the
   * runner a workflow selected rather than about any one backend, which is why they travel here.
   */
  authenticationEnvironmentNames: readonly string[]
  sameAs: (other: ValidatedAgentRunner) => boolean
  /**
   * Re-validates `runner.settings` as it stands now, against the environment as it stands now. As
   * with the tracker, the adapter comes from this selection rather than from a registry looked up
   * again by kind, so a revalidation cannot drift to a different registry than the one the workflow
   * was loaded with.
   */
  revalidate: (settings: JsonObject) => Effect.Effect<ValidatedAgentRunner, WorkflowError>
}>

/** What an adapter must supply to own a `runner.kind`. */
export type AgentRunnerAdapter<Settings> = Readonly<{
  kind: string
  /**
   * The launch command to use when the workflow declares none. It belongs to the adapter rather
   * than to `workflowDefaults` because it names a specific executable, which is the one part of
   * the neutral configuration only the backend can supply.
   */
  defaultCommand: string
  authenticationEnvironmentNames: readonly string[]
  /**
   * Validates `runner.settings` as authored, failing with a `WorkflowError` carrying the
   * operator-visible message. Secret and path indirection resolves through the calling fiber's
   * `ConfigProvider`, exactly as tracker provider validation does.
   */
  validate: (settings: JsonObject) => Effect.Effect<Settings, WorkflowError>
  /** Recognizes this adapter's own validated settings inside an opaque selection. */
  isSettings: (value: unknown) => value is Settings
  same: (left: Settings, right: Settings) => boolean
}>

/**
 * An adapter with its settings type erased, as the registry holds it.
 *
 * `runner` carries the composition root's own factory on the same entry without making this domain
 * module import the port that factory constructs, the way the tracker registry carries its
 * capabilities.
 */
export type RegisteredAgentRunner<RunnerFactory = unknown> = Readonly<{
  kind: string
  defaultCommand: string
  validate: (settings: JsonObject) => Effect.Effect<ValidatedAgentRunner, WorkflowError>
  runner?: RunnerFactory
}>

const validatedSelection = <Settings>(
  adapter: AgentRunnerAdapter<Settings>,
  settings: Settings,
): ValidatedAgentRunner =>
  Object.freeze({
    kind: adapter.kind,
    settings,
    authenticationEnvironmentNames: Object.freeze([...adapter.authenticationEnvironmentNames]),
    sameAs: (other: ValidatedAgentRunner): boolean =>
      other.kind === adapter.kind &&
      adapter.isSettings(other.settings) &&
      adapter.same(settings, other.settings),
    revalidate: (authored: JsonObject): Effect.Effect<ValidatedAgentRunner, WorkflowError> =>
      adapter
        .validate(authored)
        .pipe(Effect.map((validated) => validatedSelection(adapter, validated))),
  })

/**
 * Erases an adapter's settings type for the registry. The erasure happens here, where the type
 * variable is still in scope, so nothing downstream has to assert a settings shape.
 */
export const registerAgentRunner = <Settings>(
  adapter: AgentRunnerAdapter<Settings>,
): RegisteredAgentRunner<never> =>
  Object.freeze({
    kind: adapter.kind,
    defaultCommand: adapter.defaultCommand,
    validate: (settings: JsonObject): Effect.Effect<ValidatedAgentRunner, WorkflowError> =>
      adapter
        .validate(settings)
        .pipe(Effect.map((validated) => validatedSelection(adapter, validated))),
  })

/** The runner kinds a build supports, and the validation each one owns. */
export type AgentRunnerRegistry<
  Entry extends RegisteredAgentRunner<unknown> = RegisteredAgentRunner<unknown>,
> = Readonly<{
  kinds: readonly string[]
  get: (kind: string) => Option.Option<Entry>
  validate: (
    kind: string,
    settings: JsonObject,
  ) => Effect.Effect<ValidatedAgentRunner, WorkflowError>
}>

export const makeAgentRunnerRegistry = <Entry extends RegisteredAgentRunner<unknown>>(
  adapters: readonly Entry[],
): AgentRunnerRegistry<Entry> => {
  const byKind = new Map(adapters.map((adapter) => [adapter.kind, adapter] as const))
  const kinds = Object.freeze([...byKind.keys()])
  return Object.freeze({
    kinds,
    get: (kind: string): Option.Option<Entry> => Option.fromNullable(byKind.get(kind)),
    validate: (
      kind: string,
      settings: JsonObject,
    ): Effect.Effect<ValidatedAgentRunner, WorkflowError> => {
      const adapter = byKind.get(kind)
      if (adapter === undefined) {
        return Effect.fail(
          new WorkflowError({
            category: 'invalid_config',
            message: `unsupported runner.kind: ${kind} (supported: ${kinds.join(', ')})`,
          }),
        )
      }
      return adapter.validate(settings)
    },
  })
}

/** Structural equality for a validated selection, used to detect a changed runner on reload. */
export const sameAgentRunner = (left: ValidatedAgentRunner, right: ValidatedAgentRunner): boolean =>
  left.sameAs(right)

/**
 * Reads back the settings an adapter validated. This is how an adapter turns the opaque selection
 * its launch carries into the concrete settings its session takes; a selection of another kind is
 * an operator-visible configuration error rather than a cast.
 */
export const agentRunnerSettingsOf = <Settings>(
  adapter: AgentRunnerAdapter<Settings>,
  selection: ValidatedAgentRunner,
): Settings => {
  if (selection.kind !== adapter.kind || !adapter.isSettings(selection.settings)) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `agent runner ${selection.kind} is not a ${adapter.kind} runner`,
    })
  }
  return selection.settings
}
