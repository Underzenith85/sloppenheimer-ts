import { homedir } from 'node:os'
import { Config, Effect, Redacted } from 'effect'

import { WorkflowError } from '../errors.js'

const referencePattern = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u

/**
 * Codex owns these authentication sources. Tracker configuration may never reuse them, and the
 * host never strips them from Codex subprocess environments.
 */
export const codexAuthenticationEnvironmentNames: ReadonlySet<string> = new Set([
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
])

export const environmentReferenceName = (value: string): string | null => {
  const match = referencePattern.exec(value)
  return match?.[1] ?? null
}

/**
 * One environment variable, described as a `Config` and therefore read through whatever
 * `ConfigProvider` the calling fiber carries: the process environment in production, a test
 * provider under test. A declared reference that resolves to an empty value is as unusable as one
 * that resolves to nothing, so emptiness fails here rather than reaching a caller as a credential.
 */
const presentValue = (environmentName: string): Config.Config<string> =>
  Config.string(environmentName).pipe(
    Config.validate({
      message: `${environmentName} is empty`,
      validation: (value: string): boolean => value.length > 0,
    }),
  )

const missingReference = (name: string): WorkflowError =>
  new WorkflowError({
    category: 'invalid_config',
    message: `${name} references a missing environment variable`,
  })

/**
 * Resolves `$VAR` indirection for a declared path field. Values that are not a bare reference are
 * kept literally; no other field performs environment expansion.
 */
export const resolvePathReference = (
  value: string,
  name: string,
): Effect.Effect<string, WorkflowError> => {
  const environmentName = environmentReferenceName(value)
  if (environmentName === null) {
    return Effect.succeed(value)
  }
  return presentValue(environmentName).pipe(Effect.mapError(() => missingReference(name)))
}

/**
 * A resolved secret reference: the value the adapter must authenticate with, and the variable name
 * it came from. The value is `Redacted` so that neither a log line, a serialized configuration
 * record, nor a stack trace can echo it by simply printing the object that carries it.
 */
export type ResolvedSecretReference = Readonly<{
  value: Redacted.Redacted<string>
  environmentName: string
}>

/**
 * Resolves `$VAR` indirection for a declared secret field. Literal credentials are rejected so
 * repository-owned workflow files never carry plaintext tokens.
 */
export const resolveSecretReference = (
  value: string,
  name: string,
): Effect.Effect<ResolvedSecretReference, WorkflowError> => {
  const environmentName = environmentReferenceName(value)
  if (environmentName === null) {
    return Effect.fail(
      new WorkflowError({
        category: 'invalid_config',
        message: `${name} must reference an environment variable; literal credentials are not allowed in repository-owned workflow files`,
      }),
    )
  }
  if (codexAuthenticationEnvironmentNames.has(environmentName)) {
    return Effect.fail(
      new WorkflowError({
        category: 'invalid_config',
        message: `${name} must not use Codex authentication environment variable ${environmentName}`,
      }),
    )
  }
  return Config.redacted(presentValue(environmentName)).pipe(
    Effect.mapBoth({
      onFailure: () => missingReference(name),
      onSuccess: (secret: Redacted.Redacted<string>): ResolvedSecretReference => ({
        value: secret,
        environmentName,
      }),
    }),
  )
}

/** Expands a leading `~` for a declared path field. */
export const expandHomePath = (value: string): string => {
  if (value === '~') {
    return homedir()
  }
  if (value.startsWith('~/')) {
    return `${homedir()}/${value.slice(2)}`
  }
  return value
}
