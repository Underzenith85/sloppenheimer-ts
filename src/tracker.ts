import { Effect } from 'effect'

import {
  issueId,
  issueIdentifier,
  type BlockerRef,
  type Issue,
  type IssueId,
  type JsonObject,
  type JsonValue,
} from './domain/domain.js'
import { TrackerError } from './errors.js'
import { logWarning } from './support/logging.js'
import { makeGitHubPullRequestMonitor } from './github-handoff.js'
import {
  githubJson,
  githubMaxPages,
  githubPageSize,
  isJsonRecord,
  parseNextUrl,
  trackerPaginationError,
  trackerResponseError,
} from './github-http.js'
import { isJsonArray } from './support/json.js'
import {
  githubAuthenticationEnvironmentNames,
  type GitHubProviderConfig,
} from './config/tracker-config.js'
import type { PullRequestObservation } from './domain/handoff.js'
import type {
  HostToolContext,
  HostToolFailureCode,
  HostToolResult,
  HostToolSpec,
} from './host-tools.js'
import { unsupportedHostTool } from './host-tools.js'

export type IssueFetchOptions = Readonly<{ hydrateDependencies: boolean }>

export type TrackerPort = Readonly<{
  /**
   * Reads every normalized record in provider scope for the given states, including
   * `dispatchable=false`; dispatch filtering belongs to the orchestrator.
   *
   * `dependencyLabels` selects blocker hydration: `null` hydrates every dispatch candidate, a list
   * hydrates only candidates carrying all of those labels, and an empty list hydrates none.
   */
  fetchIssuesByStates: (
    states: readonly string[],
    dependencyLabels: readonly string[] | null,
    options?: IssueFetchOptions,
  ) => Effect.Effect<readonly Issue[], TrackerError>
  fetchIssuesByIds: (
    ids: readonly IssueId[],
    options?: IssueFetchOptions,
  ) => Effect.Effect<readonly Issue[], TrackerError>
  /** Provider-native mutations advertised only to sessions using this adapter instance. */
  toolSpecs: readonly HostToolSpec[]
  /** Total host-side boundary: every invocation resolves to a JSON-safe success or failure. */
  executeTool: (
    name: string,
    argumentsValue: JsonValue,
    context: HostToolContext,
  ) => Promise<HostToolResult>
  secretEnvironmentNames: readonly string[]
}>

export type HandoffResult =
  | Readonly<{ _tag: 'NoBranch'; branchName: string }>
  | Readonly<{
      _tag: 'PullRequest'
      branchName: string
      pullRequestUrl: string
      pullRequestNumber: number
      /** Whether this handoff opened the pull request or adopted one that already existed. */
      created: boolean
    }>

export type CodeReviewPort = Readonly<{
  /** Provider-native code-review operations advertised only when this capability is present. */
  toolSpecs: readonly HostToolSpec[]
  /** Total host-side boundary: every invocation resolves to a JSON-safe success or failure. */
  executeTool: (
    name: string,
    argumentsValue: JsonValue,
    context: HostToolContext,
  ) => Promise<HostToolResult>
  handoffCompletedWork: (issue: Issue) => Effect.Effect<HandoffResult, TrackerError>
  findExistingHandoff: (issue: Issue) => Effect.Effect<HandoffResult, TrackerError>
  inspectPullRequest: (
    pullRequestNumber: number,
  ) => Effect.Effect<PullRequestObservation, TrackerError>
  mergePullRequest: (
    pullRequestNumber: number,
    expectedHeadSha: string,
  ) => Effect.Effect<string, TrackerError>
  requestPullRequestReview: (
    pullRequestNumber: number,
    expectedHeadSha: string,
  ) => Effect.Effect<void, TrackerError>
  resolveReviewThreads: (threadIds: readonly string[]) => Effect.Effect<void, TrackerError>
}>

export type GitHubIssueControl = Readonly<{
  listOpenIssues: () => Effect.Effect<readonly Issue[], TrackerError>
  addLabel: (issueNumber: number, label: string) => Effect.Effect<void, TrackerError>
}>

type GitHubLabel = Readonly<{ name: string | null }>
type GitHubIssue = Readonly<{
  number: number
  nodeId: string
  title: string
  body: string | null
  state: string
  htmlUrl: string | null
  assigneeLogin: string | null
  labels: readonly GitHubLabel[]
  isPullRequest: boolean
  createdAt: string | null
  updatedAt: string | null
}>

type GitHubDependency = Readonly<{
  id: number
  number: number
  title: string
  state: string
  repositoryUrl: string
  htmlUrl: string
}>

const dependencyConcurrency = 4
const idRefreshConcurrency = 4
const dependencyCacheTtlMs = 60_000

type DependencyCacheEntry = Readonly<{
  blockedBy: readonly BlockerRef[]
  issueUpdatedAt: number | null
  expiresAt: number
}>

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

const githubCodeReviewToolSpecs: readonly HostToolSpec[] = Object.freeze([
  Object.freeze({
    name: 'github_link_pull_request',
    description:
      'Link a pull request in the configured repository to the current issue by adding a handoff comment after verifying the pull request exists.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['pull_request_number']),
      properties: Object.freeze({
        pull_request_number: Object.freeze({ type: 'integer', minimum: 1 }),
      }),
    }),
  }),
])

const toolFailure = (
  code: HostToolFailureCode,
  message: string,
  retryable = false,
  retryAfterMs?: number,
): HostToolResult => ({
  success: false,
  error: { code, message, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
})

const invalidToolArguments = (message: string): HostToolResult =>
  toolFailure('invalid_arguments', message)

const exactObject = (value: JsonValue, allowedKeys: ReadonlySet<string>): JsonObject | null => {
  if (!isJsonRecord(value)) {
    return null
  }
  return Object.keys(value).every((key) => allowedKeys.has(key)) ? value : null
}

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

const githubIssueNumber = (
  provider: GitHubProviderConfig,
  context: HostToolContext,
): number | null => {
  const nativeRef = context.nativeRef
  if (
    nativeRef === null ||
    nativeRef['owner'] !== provider.owner ||
    nativeRef['repository'] !== provider.repository
  ) {
    return null
  }
  const number = nativeRef['issue_number']
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : null
}

const hostToolFailureFrom = (error: TrackerError): HostToolResult => {
  if (error.category === 'tracker_rate_limited') {
    return toolFailure('rate_limited', 'GitHub rate limit exceeded', true, error.retryAfterMs)
  }
  if (error.category === 'tracker_request') {
    return toolFailure('transport_error', 'GitHub request failed', true)
  }
  if (error.category === 'tracker_status' && /HTTP 401/u.test(error.message)) {
    return toolFailure('missing_auth', 'GitHub rejected the configured credential')
  }
  if (error.category === 'tracker_status' && /HTTP 403/u.test(error.message)) {
    return toolFailure('authorization_failed', 'GitHub denied this mutation')
  }
  return toolFailure('provider_error', error.message, error.retryable, error.retryAfterMs)
}

const githubToolValue = (effect: Effect.Effect<JsonValue, TrackerError>): Promise<HostToolResult> =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: hostToolFailureFrom,
        onSuccess: (data): HostToolResult => ({ success: true, data }),
      }),
    ),
  )

const requiredResponseUrl = (body: JsonValue | null, field: string): string => {
  if (!isJsonRecord(body) || typeof body[field] !== 'string' || body[field].length === 0) {
    throw trackerResponseError(`GitHub response is missing ${field}`)
  }
  return body[field]
}

const makeGitHubTrackerToolExecutor =
  (provider: GitHubProviderConfig, prefix: string): TrackerPort['executeTool'] =>
  async (name, argumentsValue, context): Promise<HostToolResult> => {
    if (!githubTrackerToolSpecs.some((spec) => spec.name === name)) {
      return unsupportedHostTool(name)
    }
    if (provider.token.length === 0) {
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
      )
    }
    return unsupportedHostTool(name)
  }

const makeGitHubCodeReviewToolExecutor =
  (provider: GitHubProviderConfig, prefix: string): CodeReviewPort['executeTool'] =>
  async (name, argumentsValue, context): Promise<HostToolResult> => {
    if (!githubCodeReviewToolSpecs.some((spec) => spec.name === name)) {
      return unsupportedHostTool(name)
    }
    if (provider.token.length === 0) {
      return toolFailure('missing_auth', 'GitHub credential is not configured')
    }
    const issueNumber = githubIssueNumber(provider, context)
    if (issueNumber === null) {
      return invalidToolArguments('Session issue context is invalid for this GitHub adapter')
    }
    const argumentsObject = exactObject(argumentsValue, new Set(['pull_request_number']))
    const pullRequestNumber = argumentsObject?.['pull_request_number']
    if (
      argumentsObject === null ||
      typeof pullRequestNumber !== 'number' ||
      !Number.isSafeInteger(pullRequestNumber) ||
      pullRequestNumber <= 0
    ) {
      return invalidToolArguments(
        'github_link_pull_request requires only a positive pull_request_number integer',
      )
    }
    return githubToolValue(
      githubJson(
        provider,
        `${provider.apiBaseUrl}${prefix}/pulls/${String(pullRequestNumber)}`,
      ).pipe(
        Effect.flatMap(({ body }) =>
          Effect.try({
            try: () => requiredResponseUrl(body, 'html_url'),
            catch: (cause: unknown) =>
              cause instanceof TrackerError
                ? cause
                : trackerResponseError('GitHub pull request response is invalid', cause),
          }),
        ),
        Effect.flatMap((pullRequestUrl) =>
          githubJson(
            provider,
            `${provider.apiBaseUrl}${prefix}/issues/${String(issueNumber)}/comments`,
            {
              method: 'POST',
              body: JSON.stringify({
                body: `Linked pull request for handoff: ${pullRequestUrl}`,
              }),
            },
          ).pipe(
            Effect.as({
              issue_number: issueNumber,
              pull_request_number: pullRequestNumber,
              pull_request_url: pullRequestUrl,
            }),
          ),
        ),
      ),
    )
  }

const nullableString = (value: JsonValue | undefined): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  return value
}

const nonEmptyString = (value: JsonValue | undefined): string | null => {
  const text = nullableString(value)
  return text === null || text.length === 0 ? null : text
}

const parseDate = (value: string | null): Date | null => {
  if (value === null) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** GitHub returns labels either as objects or, on some payload shapes, as bare strings. */
const decodeGitHubLabel = (value: JsonValue): GitHubLabel | null => {
  if (typeof value === 'string') {
    return { name: value }
  }
  if (!isJsonRecord(value)) {
    return null
  }
  const name = value['name']
  return name === null || typeof name === 'string' ? { name } : null
}

const decodeGitHubIssue = (value: JsonValue): GitHubIssue => {
  if (!isJsonRecord(value)) {
    throw trackerResponseError('GitHub issue is not an object')
  }
  const number = value['number']
  const nodeId = value['node_id']
  const title = value['title']
  const state = value['state']
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    typeof nodeId !== 'string' ||
    nodeId.length === 0 ||
    typeof title !== 'string' ||
    title.length === 0 ||
    typeof state !== 'string' ||
    state.length === 0
  ) {
    throw trackerResponseError('GitHub issue is missing required fields')
  }
  const rawLabels = value['labels']
  const labels = isJsonArray(rawLabels)
    ? rawLabels.flatMap((item) => {
        const label = decodeGitHubLabel(item)
        return label === null ? [] : [label]
      })
    : []
  const rawAssignee = value['assignee']
  return {
    number,
    nodeId,
    title,
    body: nullableString(value['body']),
    state,
    htmlUrl: nonEmptyString(value['html_url']),
    assigneeLogin: isJsonRecord(rawAssignee) ? nonEmptyString(rawAssignee['login']) : null,
    labels,
    isPullRequest: value['pull_request'] !== undefined && value['pull_request'] !== null,
    createdAt: nonEmptyString(value['created_at']),
    updatedAt: nonEmptyString(value['updated_at']),
  }
}

const decodeGitHubDependency = (value: JsonValue): GitHubDependency => {
  if (!isJsonRecord(value)) {
    throw trackerResponseError('GitHub issue dependency is not an object')
  }
  const id = value['id']
  const number = value['number']
  const title = value['title']
  const state = value['state']
  const repositoryUrl = value['repository_url']
  const htmlUrl = value['html_url']
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    typeof title !== 'string' ||
    title.length === 0 ||
    typeof state !== 'string' ||
    state.length === 0 ||
    typeof repositoryUrl !== 'string' ||
    typeof htmlUrl !== 'string'
  ) {
    throw trackerResponseError('GitHub issue dependency is missing required fields')
  }
  return { id, number, title, state, repositoryUrl, htmlUrl }
}

const normalizeDependency = (
  source: GitHubDependency,
  provider: GitHubProviderConfig,
): BlockerRef => {
  try {
    const repositoryUrl = new URL(source.repositoryUrl)
    if (repositoryUrl.origin !== new URL(provider.apiBaseUrl).origin) {
      throw new Error('unexpected dependency repository origin')
    }
    const match = /\/repos\/([^/]+)\/([^/]+)\/?$/u.exec(repositoryUrl.pathname)
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error('invalid dependency repository URL')
    }
    const owner = decodeURIComponent(match[1])
    const repository = decodeURIComponent(match[2])
    return {
      id: String(source.id),
      identifier: issueIdentifier(`${owner}/${repository}#${String(source.number)}`),
      title: source.title,
      state: source.state,
      url: source.htmlUrl,
    }
  } catch (cause: unknown) {
    throw trackerResponseError('GitHub issue dependency has an invalid repository URL', cause)
  }
}

/**
 * Section 11.3 normalization. Dispatch identity is the opaque issue number, native identity keeps
 * the provider scope plus GraphQL node id, and every nullable field is normalized to `null` rather
 * than an empty value.
 */
const normalizeIssue = (
  source: GitHubIssue,
  provider: GitHubProviderConfig,
  blockedBy: readonly BlockerRef[] = [],
): Issue => {
  const labels = [
    ...new Set(
      source.labels.flatMap((label) => {
        const name = label.name?.trim().toLowerCase()
        return name === undefined || name.length === 0 ? [] : [name]
      }),
    ),
  ]
  const priorityLabel = labels.find((label) => /^priority:[1-4]$/u.test(label))
  const priority = priorityLabel === undefined ? null : Number(priorityLabel.slice(-1))

  return {
    id: issueId(String(source.number)),
    nativeRef: {
      node_id: source.nodeId,
      issue_number: source.number,
      owner: provider.owner,
      repository: provider.repository,
    },
    identifier: issueIdentifier(
      `${provider.owner}/${provider.repository}#${String(source.number)}`,
    ),
    title: source.title,
    description: source.body,
    priority,
    state: source.state,
    branchName: null,
    url: source.htmlUrl,
    assigneeId: source.assigneeLogin,
    labels,
    blockedBy,
    dispatchable: !source.isPullRequest,
    createdAt: parseDate(source.createdAt),
    updatedAt: parseDate(source.updatedAt),
  }
}

type DecodedPage = Readonly<{
  issues: readonly Issue[]
  malformed: readonly string[]
}>

const decodeIssuePage = (body: JsonValue, provider: GitHubProviderConfig): DecodedPage => {
  if (!isJsonArray(body)) {
    throw trackerResponseError('GitHub issue list is not an array')
  }
  const issues: Issue[] = []
  const malformed: string[] = []
  for (const [index, item] of body.entries()) {
    try {
      issues.push(normalizeIssue(decodeGitHubIssue(item), provider))
    } catch (error: unknown) {
      if (!(error instanceof TrackerError)) {
        throw error
      }
      const candidate = isJsonRecord(item) ? item['number'] : undefined
      malformed.push(
        `index ${String(index)}${typeof candidate === 'number' ? ` (number ${String(candidate)})` : ''}: ${error.message}`,
      )
    }
  }
  return { issues, malformed }
}

const pullRequestNumberFromUrl = (url: string): number => {
  const match = /\/pulls?\/(\d+)(?:\/)?$/u.exec(url)
  const number = match?.[1] === undefined ? Number.NaN : Number(match[1])
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw trackerResponseError('GitHub pull request URL has no valid number')
  }
  return number
}

const githubBranchExists = (
  provider: GitHubProviderConfig,
  prefix: string,
  branchName: string,
): Effect.Effect<boolean, TrackerError> =>
  githubJson(
    provider,
    `${provider.apiBaseUrl}${prefix}/git/ref/heads/${encodeURIComponent(branchName)}`,
    undefined,
    [404],
  ).pipe(Effect.map(({ status }) => status !== 404))

const decodePullRequestUrl = (value: JsonValue | null): string => {
  if (!isJsonRecord(value) || typeof value['html_url'] !== 'string') {
    throw trackerResponseError('GitHub pull request is missing html_url')
  }
  return value['html_url']
}

const findPullRequest = (
  provider: GitHubProviderConfig,
  prefix: string,
  branchName: string,
): Effect.Effect<string | null, TrackerError> =>
  githubJson(
    provider,
    `${provider.apiBaseUrl}${prefix}/pulls?state=open&head=${encodeURIComponent(`${provider.owner}:${branchName}`)}&base=${encodeURIComponent(provider.baseBranch)}&per_page=${String(githubPageSize)}`,
  ).pipe(
    Effect.flatMap(({ body }) => {
      if (!isJsonArray(body)) {
        return Effect.fail(trackerResponseError('GitHub pull request list is not an array'))
      }
      const first = body[0]
      return first === undefined
        ? Effect.succeed(null)
        : Effect.try({
            try: () => decodePullRequestUrl(first),
            catch: (cause: unknown) =>
              cause instanceof TrackerError
                ? cause
                : trackerResponseError('GitHub pull request is invalid', cause),
          })
    }),
  )

const createPullRequest = (
  provider: GitHubProviderConfig,
  prefix: string,
  issue: Issue,
  branchName: string,
): Effect.Effect<string, TrackerError> =>
  githubJson(provider, `${provider.apiBaseUrl}${prefix}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      base: provider.baseBranch,
      head: branchName,
      title: issue.title,
      body: `Closes #${issue.id}`,
    }),
  }).pipe(
    Effect.flatMap(({ body }) =>
      Effect.try({
        try: () => decodePullRequestUrl(body),
        catch: (cause: unknown) =>
          cause instanceof TrackerError
            ? cause
            : trackerResponseError('GitHub pull request is invalid', cause),
      }),
    ),
  )

export const issueBranchName = (issue: Issue): string => `symphony/issue-${issue.id}`

const paginate = <Value>(
  provider: GitHubProviderConfig,
  firstUrl: string,
  decode: (body: JsonValue) => Value,
  combine: (accumulated: readonly Value[]) => readonly Value[] = (values) => values,
): Effect.Effect<readonly Value[], TrackerError> => {
  const fetchPage = (
    url: string,
    visitedUrls: ReadonlySet<string>,
    pageCount: number,
  ): Effect.Effect<readonly Value[], TrackerError> =>
    Effect.suspend(() => {
      if (visitedUrls.has(url)) {
        return Effect.fail(trackerPaginationError('GitHub pagination contains a cycle'))
      }
      if (pageCount > githubMaxPages) {
        return Effect.fail(
          trackerPaginationError(
            `GitHub pagination exceeded ${String(githubMaxPages)} pages for a single scoped read`,
          ),
        )
      }
      return githubJson(provider, url).pipe(
        Effect.flatMap(({ body, linkHeader }) =>
          Effect.try({
            try: () => ({
              value: decode(body ?? null),
              nextUrl: parseNextUrl(linkHeader, url, provider.apiBaseUrl),
            }),
            catch: (cause: unknown) =>
              cause instanceof TrackerError
                ? cause
                : trackerResponseError('GitHub returned an undecodable page', cause),
          }),
        ),
        Effect.flatMap(({ value, nextUrl }) =>
          nextUrl === null
            ? Effect.succeed([value])
            : fetchPage(nextUrl, new Set([...visitedUrls, url]), pageCount + 1).pipe(
                Effect.map((rest) => [value, ...rest]),
              ),
        ),
      )
    })
  return fetchPage(firstUrl, new Set(), 1).pipe(Effect.map(combine))
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
  cache: Map<IssueId, DependencyCacheEntry>,
  useCache = true,
): Effect.Effect<readonly Issue[], TrackerError> =>
  Effect.forEach(
    issues,
    (issue) => {
      const shouldHydrate =
        issue.dispatchable &&
        (dependencyLabels === null ||
          (dependencyLabels.length > 0 &&
            dependencyLabels.every((label) => issue.labels.includes(label.trim().toLowerCase()))))
      if (!shouldHydrate) {
        return Effect.succeed(issue)
      }
      const issueUpdatedAt = issue.updatedAt?.getTime() ?? null
      const cached = cache.get(issue.id)
      if (
        useCache &&
        dependencyLabels === null &&
        cached !== undefined &&
        cached.issueUpdatedAt === issueUpdatedAt &&
        cached.expiresAt > Date.now()
      ) {
        return Effect.succeed({ ...issue, blockedBy: cached.blockedBy })
      }
      return fetchBlockedBy(provider, prefix, issue).pipe(
        Effect.map((blockedBy) => {
          cache.set(issue.id, {
            blockedBy,
            issueUpdatedAt,
            expiresAt: Date.now() + dependencyCacheTtlMs,
          })
          return { ...issue, blockedBy }
        }),
      )
    },
    { concurrency: dependencyConcurrency },
  )

export const makeGitHubTracker = (configuredProvider: GitHubProviderConfig): TrackerPort => {
  const provider = Object.freeze({ ...configuredProvider })
  const prefix = `/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
  const dependencyCache = new Map<IssueId, DependencyCacheEntry>()
  return {
    toolSpecs: githubTrackerToolSpecs,
    executeTool: makeGitHubTrackerToolExecutor(provider, prefix),
    secretEnvironmentNames: [
      ...new Set([provider.tokenEnvironmentName, ...githubAuthenticationEnvironmentNames]),
    ],
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
      return Effect.forEach(states, fetchState, { concurrency: 1 }).pipe(
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
      )
    },
    fetchIssuesByIds: (ids, options): Effect.Effect<readonly Issue[], TrackerError> => {
      const uniqueIds = [...new Set(ids)]
      if (uniqueIds.length === 0) {
        return Effect.succeed([])
      }
      return Effect.forEach(
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
      )
    },
  }
}

export const makeGitHubCodeReview = (configuredProvider: GitHubProviderConfig): CodeReviewPort => {
  const provider = Object.freeze({ ...configuredProvider })
  const prefix = `/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
  const pullRequests = makeGitHubPullRequestMonitor(provider)
  return {
    toolSpecs: githubCodeReviewToolSpecs,
    executeTool: makeGitHubCodeReviewToolExecutor(provider, prefix),
    handoffCompletedWork: (issue) => {
      const branchName = issueBranchName(issue)
      return githubBranchExists(provider, prefix, branchName).pipe(
        Effect.flatMap((exists) => {
          if (!exists) {
            return Effect.succeed<HandoffResult>({ _tag: 'NoBranch', branchName })
          }
          return findPullRequest(provider, prefix, branchName).pipe(
            Effect.flatMap((existingUrl) =>
              existingUrl === null
                ? createPullRequest(provider, prefix, issue, branchName).pipe(
                    Effect.map((pullRequestUrl) => ({ pullRequestUrl, created: true })),
                  )
                : Effect.succeed({ pullRequestUrl: existingUrl, created: false }),
            ),
            Effect.flatMap(({ pullRequestUrl, created }) =>
              Effect.try({
                try: (): HandoffResult => ({
                  _tag: 'PullRequest',
                  branchName,
                  pullRequestUrl,
                  pullRequestNumber: pullRequestNumberFromUrl(pullRequestUrl),
                  created,
                }),
                catch: (cause: unknown) =>
                  cause instanceof TrackerError
                    ? cause
                    : trackerResponseError('GitHub pull request URL is invalid', cause),
              }),
            ),
          )
        }),
      )
    },
    findExistingHandoff: (issue) => {
      const branchName = issueBranchName(issue)
      return findPullRequest(provider, prefix, branchName).pipe(
        Effect.flatMap((pullRequestUrl) =>
          pullRequestUrl === null
            ? Effect.succeed<HandoffResult>({ _tag: 'NoBranch', branchName })
            : Effect.try({
                try: (): HandoffResult => ({
                  _tag: 'PullRequest',
                  branchName,
                  pullRequestUrl,
                  pullRequestNumber: pullRequestNumberFromUrl(pullRequestUrl),
                  created: false,
                }),
                catch: (cause: unknown) =>
                  cause instanceof TrackerError
                    ? cause
                    : trackerResponseError('GitHub pull request URL is invalid', cause),
              }),
        ),
      )
    },
    inspectPullRequest: pullRequests.inspect,
    mergePullRequest: pullRequests.merge,
    requestPullRequestReview: pullRequests.requestReview,
    resolveReviewThreads: pullRequests.resolveThreads,
  }
}

export const makeGitHubIssueControl = (provider: GitHubProviderConfig): GitHubIssueControl => {
  const prefix = `/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
  const tracker = makeGitHubTracker(provider)
  return {
    listOpenIssues: () =>
      tracker
        .fetchIssuesByStates(['open'], null)
        .pipe(Effect.map((issues) => issues.filter((issue) => issue.dispatchable))),
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
      return githubJson(
        provider,
        `${provider.apiBaseUrl}${prefix}/issues/${String(issueNumber)}/labels`,
        {
          method: 'POST',
          body: JSON.stringify({ labels: [label] }),
        },
      ).pipe(Effect.asVoid)
    },
  }
}
