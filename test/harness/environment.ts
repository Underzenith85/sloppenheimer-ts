import { ConfigProvider, Effect } from 'effect'

/**
 * The environment a test runs against, as a `ConfigProvider`.
 *
 * Production reads the process environment through `ConfigProvider.fromEnv()`; a test supplies
 * exactly the variables the case is about and nothing else, so a stray host variable can neither
 * satisfy a reference the test meant to leave missing nor leak a real credential into a run.
 */
export const testEnvironment = (
  variables: Readonly<Record<string, string>> = {},
): ConfigProvider.ConfigProvider => {
  // Re-read on every load rather than snapshotted at construction, so a test that rotates a
  // credential mid-run sees the rotation exactly as a running host sees an operator's `export`.
  const current = (): ConfigProvider.ConfigProvider.Flat =>
    ConfigProvider.fromMap(new Map(Object.entries(variables))).flattened
  return ConfigProvider.fromFlat(
    ConfigProvider.makeFlat({
      load: (path, config, split) => current().load(path, config, split),
      enumerateChildren: (path) => current().enumerateChildren(path),
      patch: current().patch,
    }),
  )
}

/** Runs an effect against {@link testEnvironment}, the way the composition root supplies its own. */
export const withEnvironment = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  variables: Readonly<Record<string, string>> = {},
): Effect.Effect<A, E, R> => Effect.withConfigProvider(effect, testEnvironment(variables))

/** Runs a configuration effect to its value against {@link testEnvironment}. */
export const runWithEnvironment = <A, E>(
  effect: Effect.Effect<A, E>,
  variables: Readonly<Record<string, string>> = {},
): A => Effect.runSync(withEnvironment(effect, variables))

/** Runs a configuration effect that is expected to fail, and returns the failure. */
export const runFailureWithEnvironment = <A, E>(
  effect: Effect.Effect<A, E>,
  variables: Readonly<Record<string, string>> = {},
): E => Effect.runSync(withEnvironment(Effect.flip(effect), variables))
