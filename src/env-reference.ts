import { homedir } from 'node:os'

import { WorkflowError } from './errors.js'

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

const readEnvironment = (
  environmentName: string,
  name: string,
  environment: NodeJS.ProcessEnv,
): string => {
  const resolved = environment[environmentName]
  if (resolved === undefined || resolved.length === 0) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `${name} references a missing environment variable`,
    })
  }
  return resolved
}

/**
 * Resolves `$VAR` indirection for a declared path field. Values that are not a bare reference are
 * kept literally; no other field performs environment expansion.
 */
export const resolvePathReference = (
  value: string,
  name: string,
  environment: NodeJS.ProcessEnv,
): string => {
  const environmentName = environmentReferenceName(value)
  if (environmentName === null) {
    return value
  }
  return readEnvironment(environmentName, name, environment)
}

/**
 * Resolves `$VAR` indirection for a declared secret field. Literal credentials are rejected so
 * repository-owned workflow files never carry plaintext tokens.
 */
export const resolveSecretReference = (
  value: string,
  name: string,
  environment: NodeJS.ProcessEnv,
): Readonly<{ value: string; environmentName: string }> => {
  const environmentName = environmentReferenceName(value)
  if (environmentName === null) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `${name} must reference an environment variable; literal credentials are not allowed in repository-owned workflow files`,
    })
  }
  if (codexAuthenticationEnvironmentNames.has(environmentName)) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `${name} must not use Codex authentication environment variable ${environmentName}`,
    })
  }
  return { value: readEnvironment(environmentName, name, environment), environmentName }
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
