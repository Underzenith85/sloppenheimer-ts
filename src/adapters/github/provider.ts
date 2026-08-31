import {
  registerTrackerProvider,
  trackerProviderOf,
  type RegisteredTrackerProvider,
  type TrackerProviderAdapter,
  type ValidatedTrackerProvider,
} from '../../domain/tracker-provider.js'
import type { JsonObject, JsonValue } from '../../domain/domain.js'
import { resolveSecretReference } from '../../config/env-reference.js'
import { WorkflowError } from '../../errors.js'

export type GitHubProviderConfig = Readonly<{
  owner: string
  repository: string
  token: string
  tokenEnvironmentName: string
  apiBaseUrl: string
  baseBranch: string
}>

/**
 * GitHub authentication fallbacks. The host removes these from Codex subprocess environments
 * alongside the configured tracker secret reference.
 */
export const githubAuthenticationEnvironmentNames = ['GITHUB_TOKEN', 'GH_TOKEN'] as const

export const githubProviderDefaults = Object.freeze({
  apiBaseUrl: 'https://api.github.com',
  baseBranch: 'main',
})

const providerFields = [
  'owner',
  'repository',
  'token',
  'tokenEnvironmentName',
  'apiBaseUrl',
  'baseBranch',
] as const

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

const isGitHubProviderConfig = (value: unknown): value is GitHubProviderConfig => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return providerFields.every((field) => typeof candidate[field] === 'string')
}

const sameGitHubProvider = (left: GitHubProviderConfig, right: GitHubProviderConfig): boolean =>
  providerFields.every((field) => left[field] === right[field])

/** The token's own variable name plus the fallbacks GitHub tooling reads without being told to. */
export const githubSecretEnvironmentNames = (provider: GitHubProviderConfig): readonly string[] => [
  ...new Set([provider.tokenEnvironmentName, ...githubAuthenticationEnvironmentNames]),
]

const githubTrackerProviderAdapter: TrackerProviderAdapter<GitHubProviderConfig> = {
  kind: 'github',
  validate: validateGitHubProvider,
  isProvider: isGitHubProviderConfig,
  same: sameGitHubProvider,
  secretEnvironmentNames: githubSecretEnvironmentNames,
}

/** The registry entry: registering this is all it takes for a build to support `kind: github`. */
export const githubTrackerProvider: RegisteredTrackerProvider = registerTrackerProvider(
  githubTrackerProviderAdapter,
)

/** Reads the GitHub configuration back out of a validated selection. */
export const githubProviderOf = (selection: ValidatedTrackerProvider): GitHubProviderConfig =>
  trackerProviderOf(githubTrackerProviderAdapter, selection)
