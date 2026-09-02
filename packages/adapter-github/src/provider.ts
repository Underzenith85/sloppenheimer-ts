import { Effect, Redacted } from 'effect'

import {
  registerTrackerProvider,
  trackerProviderOf,
  type RegisteredTrackerProvider,
  type TrackerProviderAdapter,
  type ValidatedTrackerProvider,
} from '@sloppenheimer/core/domain/tracker-provider.js'
import type { JsonObject, JsonValue } from '@sloppenheimer/core/domain/domain.js'
import { resolveSecretReference } from '@sloppenheimer/core/config/env-reference.js'
import { WorkflowError } from '@sloppenheimer/core/domain/errors.js'

export type GitHubProviderConfig = Readonly<{
  owner: string
  repository: string
  /**
   * The resolved credential. `Config.redacted` keeps it wrapped from the moment it leaves the
   * environment, so the provider record can be logged or serialized without spilling it; the value
   * is unwrapped only where it is actually sent, in the client's `Authorization` header.
   */
  token: Redacted.Redacted<string>
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

type AuthoredFields = Readonly<{
  owner: string
  repository: string
  token: string
  apiBaseUrl: string
  baseBranch: string
}>

/** The shape checks, which need nothing from the environment. */
const authoredFields = (provider: JsonObject): Effect.Effect<AuthoredFields, WorkflowError> =>
  Effect.try({
    try: (): AuthoredFields => {
      const owner = requiredString(provider, 'owner')
      const repository = requiredString(provider, 'repository')
      const token = requiredString(provider, 'token')
      const apiBaseUrl = optionalString(provider, 'api_base_url')
      const baseBranch = optionalString(provider, 'base_branch')
      return {
        owner,
        repository,
        token,
        apiBaseUrl:
          apiBaseUrl === undefined
            ? githubProviderDefaults.apiBaseUrl
            : absoluteHttpUrl(apiBaseUrl, 'api_base_url'),
        baseBranch: baseBranch ?? githubProviderDefaults.baseBranch,
      }
    },
    catch: (cause: unknown): WorkflowError =>
      cause instanceof WorkflowError ? cause : invalid('tracker.provider is not a valid selection'),
  })

/**
 * The GitHub adapter owns this validation. `tracker.provider` reaches it as the exact JSON object
 * that was authored; only the declared secret field resolves `$VAR` indirection, and it resolves
 * through the calling fiber's `ConfigProvider`.
 */
export const validateGitHubProvider = (
  provider: JsonObject,
): Effect.Effect<GitHubProviderConfig, WorkflowError> =>
  authoredFields(provider).pipe(
    Effect.flatMap((fields) =>
      resolveSecretReference(fields.token, 'tracker.provider.token').pipe(
        Effect.map((token): GitHubProviderConfig => ({
          owner: fields.owner,
          repository: fields.repository,
          token: token.value,
          tokenEnvironmentName: token.environmentName,
          apiBaseUrl: fields.apiBaseUrl,
          baseBranch: fields.baseBranch,
        })),
      ),
    ),
  )

const isGitHubProviderConfig = (value: unknown): value is GitHubProviderConfig => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  const token = candidate['token']
  return (
    Redacted.isRedacted(token) &&
    typeof Redacted.value(token) === 'string' &&
    providerFields.every((field) => typeof candidate[field] === 'string')
  )
}

/**
 * Whether two validated selections are the same credential generation. Exported because the
 * transport's rate limiter is scoped to a generation and has to recognize one: a reload that
 * revalidates an unchanged provider must go on pacing against the limiter already in force.
 */
export const sameGitHubProvider = (
  left: GitHubProviderConfig,
  right: GitHubProviderConfig,
): boolean =>
  providerFields.every((field) => left[field] === right[field]) &&
  // A rotated credential is a different selection, so the values are compared rather than the
  // wrappers, which are distinct objects on every validation.
  Redacted.value(left.token) === Redacted.value(right.token)

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
