import type { JsonObject } from './domain.js'
import { WorkflowError } from '../errors.js'

/**
 * One tracker selection, validated by the adapter that owns its `kind`.
 *
 * `provider` is opaque here: the core threads it back to the adapter that produced it and never
 * reads a field of it, so no provider-specific type reaches the core configuration surface. The two
 * facts the core does need — whether a revalidation produced the same selection, and which
 * environment variables the adapter resolved secrets from — the adapter supplies alongside it.
 */
export type ValidatedTrackerProvider = Readonly<{
  kind: string
  provider: unknown
  /** Environment variable names holding this selection's credentials. */
  secretEnvironmentNames: readonly string[]
  /**
   * Adapter-owned equality against another validated selection. A rotated credential is a
   * different selection, which is what makes the core's reload path rebuild the tracker.
   */
  sameAs: (other: ValidatedTrackerProvider) => boolean
  /**
   * Re-runs the same adapter's validation over the same authored `tracker.provider`, against a
   * fresh environment. The selection carries the adapter that produced it, so a revalidation
   * cannot drift to a different registry than the one the workflow was loaded with.
   */
  revalidate: (environment: NodeJS.ProcessEnv) => ValidatedTrackerProvider
}>

/**
 * What an adapter must supply to own a `tracker.kind`.
 *
 * `isProvider` is what keeps the opaque `provider` sound: equality and the composition root's
 * read-back both recognize their own validated value rather than assert its type.
 */
export type TrackerProviderAdapter<Provider> = Readonly<{
  kind: string
  /**
   * Validates `tracker.provider` as authored, rejecting with a `WorkflowError` carrying the
   * operator-visible message.
   */
  validate: (provider: JsonObject, environment: NodeJS.ProcessEnv) => Provider
  /** Recognizes this adapter's own validated provider inside an opaque selection. */
  isProvider: (value: unknown) => value is Provider
  same: (left: Provider, right: Provider) => boolean
  secretEnvironmentNames: (provider: Provider) => readonly string[]
}>

/** An adapter with its provider type erased, as the registry holds it. */
export type RegisteredTrackerProvider = Readonly<{
  kind: string
  validate: (provider: JsonObject, environment: NodeJS.ProcessEnv) => ValidatedTrackerProvider
}>

const validatedSelection = <Provider>(
  adapter: TrackerProviderAdapter<Provider>,
  authored: JsonObject,
  provider: Provider,
): ValidatedTrackerProvider =>
  Object.freeze({
    kind: adapter.kind,
    provider,
    secretEnvironmentNames: Object.freeze([...adapter.secretEnvironmentNames(provider)]),
    sameAs: (other: ValidatedTrackerProvider): boolean =>
      other.kind === adapter.kind &&
      adapter.isProvider(other.provider) &&
      adapter.same(provider, other.provider),
    revalidate: (environment: NodeJS.ProcessEnv): ValidatedTrackerProvider =>
      validatedSelection(adapter, authored, adapter.validate(authored, environment)),
  })

/**
 * Erases an adapter's provider type for the registry. The erasure happens here, where the type
 * variable is still in scope, so nothing downstream has to assert a provider's shape.
 */
export const registerTrackerProvider = <Provider>(
  adapter: TrackerProviderAdapter<Provider>,
): RegisteredTrackerProvider =>
  Object.freeze({
    kind: adapter.kind,
    validate: (provider: JsonObject, environment: NodeJS.ProcessEnv): ValidatedTrackerProvider =>
      validatedSelection(adapter, provider, adapter.validate(provider, environment)),
  })

/** The tracker kinds a build supports, and the validation each one owns. */
export type TrackerProviderRegistry = Readonly<{
  kinds: readonly string[]
  validate: (
    kind: string,
    provider: JsonObject,
    environment: NodeJS.ProcessEnv,
  ) => ValidatedTrackerProvider
}>

export const makeTrackerProviderRegistry = (
  adapters: readonly RegisteredTrackerProvider[],
): TrackerProviderRegistry => {
  const byKind = new Map(adapters.map((adapter) => [adapter.kind, adapter] as const))
  const kinds = Object.freeze([...byKind.keys()])
  return Object.freeze({
    kinds,
    validate: (
      kind: string,
      provider: JsonObject,
      environment: NodeJS.ProcessEnv,
    ): ValidatedTrackerProvider => {
      const adapter = byKind.get(kind)
      if (adapter === undefined) {
        throw new WorkflowError({
          category: 'invalid_config',
          message: `unsupported tracker.kind: ${kind} (supported: ${kinds.join(', ')})`,
        })
      }
      return adapter.validate(provider, environment)
    },
  })
}

/** Structural equality for a validated selection, used to detect a rotated credential. */
export const sameTrackerProvider = (
  left: ValidatedTrackerProvider,
  right: ValidatedTrackerProvider,
): boolean => left.sameAs(right)

/**
 * Reads back the provider an adapter validated. This is how the composition root turns a validated
 * selection into the concrete configuration its adapter constructors take; a selection of another
 * kind is an operator-visible configuration error rather than a cast.
 */
export const trackerProviderOf = <Provider>(
  adapter: TrackerProviderAdapter<Provider>,
  selection: ValidatedTrackerProvider,
): Provider => {
  if (selection.kind !== adapter.kind || !adapter.isProvider(selection.provider)) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `tracker provider ${selection.kind} is not a ${adapter.kind} provider`,
    })
  }
  return selection.provider
}
