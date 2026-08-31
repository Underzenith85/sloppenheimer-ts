import type * as HttpClient from '@effect/platform/HttpClient'
import { Clock, Effect, HashMap, Option, Redacted, Ref, type Layer } from 'effect'

import type { BlockerRef, Issue, IssueId, JsonValue } from '@symphony/core/domain/domain.js'
import { cyclicIssueIdentifiers, unresolvedBlockers } from '@symphony/core/domain/dependencies.js'
import { TrackerError } from '@symphony/core/domain/errors.js'
import { isJsonArray } from '@symphony/core/support/json.js'
import { logWarning } from '@symphony/core/support/logging.js'
import { sameTrackerProvider } from '@symphony/core/domain/tracker-provider.js'
import type { HostToolResult, HostToolSpec } from '@symphony/core/domain/host-tools.js'
import { unsupportedHostTool } from '@symphony/core/domain/host-tools.js'
import {
  IssueControlFactory,
  layerIssueControlFactory,
  type IssueControlFactoryPort,
  type IssueControlPort,
} from '@symphony/core/ports/issue-control.js'
import type { TrackerPort } from '@symphony/core/ports/tracker.js'
import { githubJson, githubPageSize, trackerResponseError, withBoundHttpClient } from './client.js'
import {
  githubProviderOf,
  githubSecretEnvironmentNames,
  type GitHubProviderConfig,
} from './provider.js'
import {
  decodeGitHubDependency,
  decodeGitHubIssue,
  decodeIssuePage,
  normalizeDependency,
  normalizeIssue,
  type DecodedPage,
} from './decode.js'
import { paginate } from './pagination.js'
import {
  exactObject,
  githubIssueNumber,
  githubToolValue,
  invalidToolArguments,
  requiredResponseUrl,
  toolFailure,
} from './tools.js'

const dependencyConcurrency = 4
const idRefreshConcurrency = 4
const dependencyCacheTtlMs = 60_000

type DependencyCacheEntry = Readonly<{
  blockedBy: readonly BlockerRef[]
  issueUpdatedAt: number | null
  expiresAt: number
}>

/**
 * The tracker's dependency cache. It is a `Ref` rather than a `Map` in the constructor's closure
 * because `hydrateDependencies` runs its writes at `dependencyConcurrency`: a `Ref` update is a
 * defined transition in the effect channel, so an interrupted hydration leaves no entry behind and
 * a later read-modify-write has somewhere to happen. `HashMap` is what keeps that affordable — it
 * shares structure between versions, so hydrating a backlog of N issues costs N logarithmic
 * updates rather than N copies of the whole cache.
 */
type DependencyCache = Ref.Ref<HashMap.HashMap<IssueId, DependencyCacheEntry>>

/**
 * A cache hit: present, matching the issue revision it was recorded against, and unexpired at the
 * instant the caller read from `Clock`.
 */
const liveBlockedBy = (
  entry: Option.Option<DependencyCacheEntry>,
  issueUpdatedAt: number | null,
  now: number,
): Option.Option<readonly BlockerRef[]> =>
  entry.pipe(
    Option.filter((cached) => cached.issueUpdatedAt === issueUpdatedAt && cached.expiresAt > now),
    Option.map((cached) => cached.blockedBy),
  )

/** GitHub owns blocker and cycle eligibility; core treats `dispatchable` as authoritative. */
const applyDispatchEligibility = (issues: readonly Issue[]): readonly Issue[] => {
  const cyclic = cyclicIssueIdentifiers(issues)
  return issues.map((issue) => ({
    ...issue,
    dispatchable:
      issue.dispatchable &&
      unresolvedBlockers(issue, ['closed']).length === 0 &&
      !cyclic.has(issue.identifier),
  }))
}

const githubTrackerToolSpecs: readonly HostToolSpec[] = Object.freeze([
  Object.freeze({
    name: 'github_add_comment',
    description:
      'Add a comment to the current GitHub issue. The host chooses the repository and issue; authentication is never exposed.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['body']),
      properties: Object.freeze({
        body: Object.freeze({ type: 'string', minLength: 1, maxLength: 65_536 }),
      }),
    }),
  }),
  Object.freeze({
    name: 'github_handoff_issue',
    description:
      'Update labels and/or open/closed state on the current GitHub issue for workflow handoff. Omitted fields are unchanged.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: Object.freeze({
        state: Object.freeze({ type: 'string', enum: Object.freeze(['open', 'closed']) }),
        add_labels: Object.freeze({
          type: 'array',
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: Object.freeze({ type: 'string', minLength: 1, maxLength: 100 }),
        }),
        remove_labels: Object.freeze({
          type: 'array',
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: Object.freeze({ type: 'string', minLength: 1, maxLength: 100 }),
        }),
      }),
    }),
  }),
])

const labelList = (value: JsonValue | undefined): readonly string[] | null => {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    return null
  }
  const labels: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0 || item.length > 100) {
      return null
    }
    labels.push(item.trim().toLowerCase())
  }
  return new Set(labels).size === labels.length ? labels : null
}

const makeGitHubTrackerToolExecutor =
  (
    provider: GitHubProviderConfig,
    prefix: string,
    httpClient: HttpClient.HttpClient | undefined,
  ): TrackerPort['executeTool'] =>
  async (name, argumentsValue, context): Promise<HostToolResult> => {
    if (!githubTrackerToolSpecs.some((spec) => spec.name === name)) {
      return unsupportedHostTool(name)
    }
    if (Redacted.value(provider.token).length === 0) {
      return toolFailure('missing_auth', 'GitHub credential is not configured')
    }
    const issueNumber = githubIssueNumber(provider, context)
    if (issueNumber === null) {
      return invalidToolArguments('Session issue context is invalid for this GitHub adapter')
    }
    const issuePath = `${provider.apiBaseUrl}${prefix}/issues/${String(issueNumber)}`
    if (name === 'github_add_comment') {
      const argumentsObject = exactObject(argumentsValue, new Set(['body']))
      const body = argumentsObject?.['body']
      if (
        argumentsObject === null ||
        typeof body !== 'string' ||
        body.trim().length === 0 ||
        body.length > 65_536
      ) {
        return invalidToolArguments('github_add_comment requires only a non-empty body string')
      }
      return githubToolValue(
        githubJson(provider, `${issuePath}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        }).pipe(
          Effect.flatMap(({ body: responseBody }) =>
            Effect.try({
              try: (): JsonValue => ({
                issue_number: issueNumber,
                comment_url: requiredResponseUrl(responseBody, 'html_url'),
              }),
              catch: (cause: unknown) =>
                cause instanceof TrackerError
                  ? cause
                  : trackerResponseError('GitHub comment response is invalid', cause),
            }),
          ),
        ),
        httpClient,
      )
    }
    if (name === 'github_handoff_issue') {
      const argumentsObject = exactObject(
        argumentsValue,
        new Set(['state', 'add_labels', 'remove_labels']),
      )
      if (argumentsObject === null || Object.keys(argumentsObject).length === 0) {
        return invalidToolArguments('github_handoff_issue requires at least one supported field')
      }
      const state = argumentsObject['state']
      const addLabels = labelList(argumentsObject['add_labels'])
      const removeLabels = labelList(argumentsObject['remove_labels'])
      if (
        (state !== undefined && state !== 'open' && state !== 'closed') ||
        addLabels === null ||
        removeLabels === null ||
        addLabels.some((label) => removeLabels.includes(label))
      ) {
        return invalidToolArguments('github_handoff_issue arguments do not match its schema')
      }
      const mutations: Effect.Effect<unknown, TrackerError>[] = []
      if (state !== undefined) {
        mutations.push(
          githubJson(provider, issuePath, {
            method: 'PATCH',
            body: JSON.stringify({ state }),
          }),
        )
      }
      if (addLabels.length > 0) {
        mutations.push(
          githubJson(provider, `${issuePath}/labels`, {
            method: 'POST',
            body: JSON.stringify({ labels: addLabels }),
          }),
        )
      }
      for (const label of removeLabels) {
        mutations.push(
          githubJson(
            provider,
            `${issuePath}/labels/${encodeURIComponent(label)}`,
            { method: 'DELETE' },
            [404],
          ),
        )
      }
      return githubToolValue(
        Effect.forEach(mutations, (mutation) => mutation, { concurrency: 1 }).pipe(
          Effect.as({
            issue_number: issueNumber,
            state: state ?? null,
            added_labels: addLabels,
            removed_labels: removeLabels,
          }),
        ),
        httpClient,
      )
    }
    return unsupportedHostTool(name)
  }

const fetchBlockedBy = (
  provider: GitHubProviderConfig,
  prefix: string,
  issue: Issue,
): Effect.Effect<readonly BlockerRef[], TrackerError> =>
  paginate(
    provider,
    `${provider.apiBaseUrl}${prefix}/issues/${encodeURIComponent(issue.id)}/dependencies/blocked_by?per_page=${String(githubPageSize)}`,
    (body): readonly BlockerRef[] => {
      if (!isJsonArray(body)) {
        throw trackerResponseError('GitHub issue dependency list is not an array')
      }
      return body.map((value) => normalizeDependency(decodeGitHubDependency(value), provider))
    },
  ).pipe(Effect.map((pages) => pages.flat()))

const hydrateDependencies = (
  provider: GitHubProviderConfig,
  prefix: string,
  issues: readonly Issue[],
  dependencyLabels: readonly string[] | null,
  cache: DependencyCache,
  useCache = true,
): Effect.Effect<readonly Issue[], TrackerError> =>
  Effect.forEach(
    issues,
    (issue) =>
      Effect.gen(function* () {
        const shouldHydrate =
          issue.dispatchable &&
          (dependencyLabels === null ||
            (dependencyLabels.length > 0 &&
              dependencyLabels.every((label) => issue.labels.includes(label.trim().toLowerCase()))))
        if (!shouldHydrate) {
          return issue
        }
        const issueUpdatedAt = issue.updatedAt?.getTime() ?? null
        const now = yield* Clock.currentTimeMillis
        if (useCache && dependencyLabels === null) {
          const entries = yield* Ref.get(cache)
          const cached = liveBlockedBy(HashMap.get(entries, issue.id), issueUpdatedAt, now)
          if (Option.isSome(cached)) {
            return { ...issue, blockedBy: cached.value }
          }
        }
        const blockedBy = yield* fetchBlockedBy(provider, prefix, issue)
        // `modifyAt` rewrites one entry in place of the whole map, and is where a field derived
        // from the entry it replaces would be computed if one is ever added.
        yield* Ref.update(cache, (entries) =>
          HashMap.modifyAt(entries, issue.id, () =>
            Option.some<DependencyCacheEntry>({
              blockedBy,
              issueUpdatedAt,
              expiresAt: now + dependencyCacheTtlMs,
            }),
          ),
        )
        return { ...issue, blockedBy }
      }),
    { concurrency: dependencyConcurrency },
  ).pipe(Effect.map(applyDispatchEligibility))

/**
 * `httpClient` binds this tracker to one client. An operation that stays in Effect otherwise reads
 * the client from its caller's context; `executeTool` has no context to read, so it uses this one.
 */
export const makeGitHubTracker = (
  configuredProvider: GitHubProviderConfig,
  httpClient?: HttpClient.HttpClient,
): Effect.Effect<TrackerPort> =>
  Effect.gen(function* () {
    const provider = Object.freeze({ ...configuredProvider })
    const prefix = `/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
    const dependencyCache = yield* Ref.make(HashMap.empty<IssueId, DependencyCacheEntry>())
    const bindClient = withBoundHttpClient(httpClient)
    return {
      toolSpecs: githubTrackerToolSpecs,
      executeTool: makeGitHubTrackerToolExecutor(provider, prefix, httpClient),
      secretEnvironmentNames: githubSecretEnvironmentNames(provider),
      fetchIssuesByStates: (
        states,
        dependencyLabels,
        options,
      ): Effect.Effect<readonly Issue[], TrackerError> => {
        if (states.length === 0) {
          return Effect.succeed([])
        }
        const fetchState = (state: string): Effect.Effect<DecodedPage, TrackerError> =>
          paginate(
            provider,
            `${provider.apiBaseUrl}${prefix}/issues?state=${encodeURIComponent(state.toLowerCase())}&per_page=${String(githubPageSize)}`,
            (body) => decodeIssuePage(body, provider),
          ).pipe(
            Effect.map((pages) => ({
              issues: pages.flatMap((page) => page.issues),
              malformed: pages.flatMap((page) => page.malformed),
            })),
          )
        return bindClient(
          Effect.forEach(states, fetchState, { concurrency: 1 }).pipe(
            Effect.tap((pages) => {
              const malformed = pages.flatMap((page) => page.malformed)
              return malformed.length === 0
                ? Effect.void
                : logWarning('tracker state list contained malformed records', {
                    tracker_kind: 'github',
                    provider_scope: `${provider.owner}/${provider.repository}`,
                    skipped: malformed.length,
                    details: malformed.slice(0, 10),
                  })
            }),
            Effect.map((pages) => [
              ...new Map(
                pages.flatMap((page) => page.issues).map((issue) => [issue.id, issue] as const),
              ).values(),
            ]),
            Effect.flatMap((issues) =>
              options?.hydrateDependencies === false
                ? Effect.succeed(issues)
                : hydrateDependencies(provider, prefix, issues, dependencyLabels, dependencyCache),
            ),
          ),
        )
      },
      fetchIssuesByIds: (ids, options): Effect.Effect<readonly Issue[], TrackerError> => {
        const uniqueIds = [...new Set(ids)]
        if (uniqueIds.length === 0) {
          return Effect.succeed([])
        }
        return bindClient(
          Effect.forEach(
            uniqueIds,
            (id) =>
              githubJson(
                provider,
                `${provider.apiBaseUrl}${prefix}/issues/${encodeURIComponent(id)}`,
              ).pipe(
                Effect.flatMap(({ body }) =>
                  Effect.try({
                    try: () => normalizeIssue(decodeGitHubIssue(body ?? null), provider),
                    catch: (cause: unknown) =>
                      cause instanceof TrackerError
                        ? cause
                        : trackerResponseError(`GitHub issue ${id} could not be decoded`, cause),
                  }),
                ),
              ),
            { concurrency: idRefreshConcurrency },
          ).pipe(
            Effect.map((issues) => [
              ...new Map(issues.map((issue) => [issue.id, issue] as const)).values(),
            ]),
            Effect.flatMap((issues) =>
              options?.hydrateDependencies === false
                ? Effect.succeed(issues)
                : hydrateDependencies(provider, prefix, issues, null, dependencyCache, false),
            ),
          ),
        )
      },
    }
  })

export const makeGitHubIssueControl = (
  provider: GitHubProviderConfig,
  httpClient?: HttpClient.HttpClient,
): Effect.Effect<IssueControlPort> =>
  Effect.gen(function* () {
    const prefix = `/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
    const tracker = yield* makeGitHubTracker(provider, httpClient)
    const bindClient = withBoundHttpClient(httpClient)
    return {
      listOpenIssues: () =>
        tracker
          .fetchIssuesByStates(['open'], null)
          .pipe(
            Effect.map((issues) =>
              issues.filter((issue) => issue.dispatchable || issue.blockedBy.length > 0),
            ),
          ),
      addLabel: (issueNumber, label) => {
        if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
          return Effect.fail(
            new TrackerError({
              category: 'tracker_request',
              message: 'issue number must be a positive safe integer',
              retryable: false,
            }),
          )
        }
        if (label.length === 0) {
          return Effect.fail(
            new TrackerError({
              category: 'tracker_request',
              message: 'orchestration label must not be empty',
              retryable: false,
            }),
          )
        }
        return bindClient(
          githubJson(
            provider,
            `${provider.apiBaseUrl}${prefix}/issues/${String(issueNumber)}/labels`,
            {
              method: 'POST',
              body: JSON.stringify({ labels: [label] }),
            },
          ).pipe(Effect.asVoid),
        )
      },
    }
  })

/**
 * Binds the console's issue surface to GitHub. `serves` is `sameTrackerProvider` because the
 * instance captures the whole provider record — owner, repository, credential, and API base — and
 * nothing else about the workflow reaches it.
 */
export const gitHubIssueControlFactory: IssueControlFactoryPort = {
  make: (provider) =>
    Effect.try({
      try: () => githubProviderOf(provider),
      catch: (cause) =>
        new TrackerError({
          category: 'unsupported_tracker_kind',
          message: `tracker.kind ${provider.kind} does not supply GitHub's issue control`,
          retryable: false,
          cause,
        }),
    }).pipe(Effect.flatMap((config) => makeGitHubIssueControl(config))),
  serves: sameTrackerProvider,
}

export const layerGitHubIssueControl: Layer.Layer<IssueControlFactory> =
  layerIssueControlFactory(gitHubIssueControlFactory)
