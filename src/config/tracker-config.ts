import type { JsonObject, JsonValue } from '../domain/domain.js'
import { resolveSecretReference } from './env-reference.js'
import { WorkflowError } from '../errors.js'

export type GitHubProviderConfig = Readonly<{
  owner: string
  repository: string
  token: string
  tokenEnvironmentName: string
  apiBaseUrl: string
  baseBranch: string
}>

/** Result of handing `tracker.provider` to the adapter selected by `tracker.kind`. */
export type ValidatedTrackerProvider = Readonly<{
  kind: 'github'
  provider: GitHubProviderConfig
}>

export const supportedTrackerKinds = ['github'] as const

/**
 * GitHub authentication fallbacks. The host removes these from Codex subprocess environments
 * alongside the configured tracker secret reference.
 */
export const githubAuthenticationEnvironmentNames = ['GITHUB_TOKEN', 'GH_TOKEN'] as const

export const githubProviderDefaults = Object.freeze({
  apiBaseUrl: 'https://api.github.com',
  baseBranch: 'main',
})

const invalid = (message: string): WorkflowError =>
  new WorkflowError({ category: 'invalid_config', message })

const requiredString = (provider: JsonObject, key: string): string => {
  const value: JsonValue | undefined = provider[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(`tracker.provider.${key} must be a non-empty string`)
  }
  return value
}

const optionalString = (provider: JsonObject, key: string): string | undefined => {
  const value: JsonValue | undefined = provider[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(`tracker.provider.${key} must be a non-empty string`)
  }
  return value
}

const absoluteHttpUrl = (value: string, key: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalid(`tracker.provider.${key} must be an absolute http(s) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid(`tracker.provider.${key} must be an absolute http(s) URL`)
  }
  return value.endsWith('/') ? value.slice(0, -1) : value
}

/**
 * The GitHub adapter owns this validation. `tracker.provider` reaches it as the exact JSON object
 * that was authored; only the declared secret field resolves `$VAR` indirection.
 */
export const validateGitHubProvider = (
  provider: JsonObject,
  environment: NodeJS.ProcessEnv,
): GitHubProviderConfig => {
  const owner = requiredString(provider, 'owner')
  const repository = requiredString(provider, 'repository')
  const token = resolveSecretReference(
    requiredString(provider, 'token'),
    'tracker.provider.token',
    environment,
  )
  const apiBaseUrl = optionalString(provider, 'api_base_url')
  const baseBranch = optionalString(provider, 'base_branch')
  return {
    owner,
    repository,
    token: token.value,
    tokenEnvironmentName: token.environmentName,
    apiBaseUrl:
      apiBaseUrl === undefined
        ? githubProviderDefaults.apiBaseUrl
        : absoluteHttpUrl(apiBaseUrl, 'api_base_url'),
    baseBranch: baseBranch ?? githubProviderDefaults.baseBranch,
  }
}

/** Structural equality for a validated selection, used to detect a rotated credential. */
export const sameTrackerProvider = (
  left: ValidatedTrackerProvider,
  right: ValidatedTrackerProvider,
): boolean =>
  left.kind === right.kind &&
  left.provider.owner === right.provider.owner &&
  left.provider.repository === right.provider.repository &&
  left.provider.token === right.provider.token &&
  left.provider.tokenEnvironmentName === right.provider.tokenEnvironmentName &&
  left.provider.apiBaseUrl === right.provider.apiBaseUrl &&
  left.provider.baseBranch === right.provider.baseBranch

export const validateTrackerProvider = (
  kind: string,
  provider: JsonObject,
  environment: NodeJS.ProcessEnv,
): ValidatedTrackerProvider => {
  if (kind !== 'github') {
    throw invalid(
      `unsupported tracker.kind: ${kind} (supported: ${supportedTrackerKinds.join(', ')})`,
    )
  }
  return { kind: 'github', provider: validateGitHubProvider(provider, environment) }
}
