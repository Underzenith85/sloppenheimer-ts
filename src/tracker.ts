import { Effect } from 'effect'

import {
  issueId,
  issueIdentifier,
  type BlockerRef,
  type Issue,
  type IssueId,
  type JsonValue,
} from './domain.js'
import { TrackerError } from './errors.js'
import type { GitHubProviderConfig } from './workflow.js'

export type TrackerAdapter = Readonly<{
  fetchIssuesByStates: (
    states: readonly string[],
    dependencyLabels: readonly string[] | null,
  ) => Effect.Effect<readonly Issue[], TrackerError>
  fetchIssuesByIds: (ids: readonly IssueId[]) => Effect.Effect<readonly Issue[], TrackerError>
  handoffCompletedWork: (
    issue: Issue,
    dispatchLabels: readonly string[],
  ) => Effect.Effect<HandoffResult, TrackerError>
  secretEnvironmentNames: readonly string[]
}>

export type HandoffResult =
  | Readonly<{ _tag: 'NoBranch'; branchName: string }>
  | Readonly<{ _tag: 'PullRequest'; branchName: string; pullRequestUrl: string }>

export type GitHubIssueControl = Readonly<{
  listOpenIssues: () => Effect.Effect<readonly Issue[], TrackerError>
  setLabel: (
    issueNumber: number,
    label: string,
    enabled: boolean,
  ) => Effect.Effect<void, TrackerError>
}>

type JsonRecord = Record<string, JsonValue>

type GitHubResponse = Readonly<{
  body: JsonValue
  nextUrl: string | null
}>

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }
  return isJsonRecord(value) && Object.values(value).every(isJsonValue)
}

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value)

type GitHubLabel = Readonly<{ name: string | null }>
type GitHubUser = Readonly<{ login: string }>
type GitHubIssue = Readonly<{
  number: number
  nodeId: string
  title: string
  body: string | null
  state: string
  htmlUrl: string
  assignee: GitHubUser | null
  labels: readonly GitHubLabel[]
  isPullRequest: boolean
  createdAt: string
  updatedAt: string
}>

type GitHubDependency = Readonly<{
  id: number
  number: number
  title: string
  state: string
  repositoryUrl: string
  htmlUrl: string
}>

const githubApiVersion = '2026-03-10'
const dependencyConcurrency = 4
const dependencyCacheTtlMs = 60_000

type DependencyCacheEntry = Readonly<{
  blockedBy: readonly BlockerRef[]
  issueUpdatedAt: number | null
  expiresAt: number
}>

const nullableString = (value: JsonValue | undefined): string | null =>
  typeof value === 'string' ? value : null
const parseDate = (value: string): Date | null => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const decodeGitHubLabel = (value: JsonValue): GitHubLabel | null => {
  if (!isJsonRecord(value)) {
    return null
  }
  const name = value['name']
  return name === null || typeof name === 'string' ? { name } : null
}

const decodeGitHubIssue = (value: JsonValue): GitHubIssue => {
  if (!isJsonRecord(value)) {
    throw new TrackerError({
      category: 'tracker_response',
      message: 'GitHub issue is not an object',
      retryable: false,
    })
  }
  const number = value['number']
  const nodeId = value['node_id']
  const title = value['title']
  const state = value['state']
  const htmlUrl = value['html_url']
  const createdAt = value['created_at']
  const updatedAt = value['updated_at']
  if (
    typeof number !== 'number' ||
    !Number.isInteger(number) ||
    typeof nodeId !== 'string' ||
    typeof title !== 'string' ||
    title.length === 0 ||
    typeof state !== 'string' ||
    state.length === 0 ||
    typeof htmlUrl !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    throw new TrackerError({
      category: 'tracker_response',
      message: 'GitHub issue is missing required fields',
      retryable: false,
    })
  }
  const rawLabels = value['labels']
  const labels =
    rawLabels !== undefined && isJsonArray(rawLabels)
      ? rawLabels.flatMap((item) => {
          const label = decodeGitHubLabel(item)
          return label === null ? [] : [label]
        })
      : []
  const rawAssignee = value['assignee']
  const assignee =
    isJsonRecord(rawAssignee) && typeof rawAssignee['login'] === 'string'
      ? { login: rawAssignee['login'] }
      : null
  return {
    number,
    nodeId,
    title,
    body: nullableString(value['body']),
    state,
    htmlUrl,
    assignee,
    labels,
    isPullRequest: value['pull_request'] !== undefined,
    createdAt,
    updatedAt,
  }
}

const decodeGitHubDependency = (value: JsonValue): GitHubDependency => {
  if (!isJsonRecord(value)) {
    throw new TrackerError({
      category: 'tracker_response',
      message: 'GitHub issue dependency is not an object',
      retryable: false,
    })
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
    throw new TrackerError({
      category: 'tracker_response',
      message: 'GitHub issue dependency is missing required fields',
      retryable: false,
    })
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
    throw new TrackerError({
      category: 'tracker_response',
      message: 'GitHub issue dependency has an invalid repository URL',
      retryable: false,
      cause,
    })
  }
}

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
    assigneeId: source.assignee?.login ?? null,
    labels,
    blockedBy,
    dispatchable: !source.isPullRequest,
    createdAt: parseDate(source.createdAt),
    updatedAt: parseDate(source.updatedAt),
  }
}

const paginationError = (message: string, cause?: unknown): TrackerError =>
  new TrackerError({
    category: 'tracker_pagination',
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  })

const parseNextUrl = (
  linkHeader: string | null,
  requestUrl: string,
  apiBaseUrl: string,
): string | null => {
  if (linkHeader === null) {
    return null
  }
  for (const entry of linkHeader.split(',')) {
    const [target, ...parameters] = entry.trim().split(';')
    const relations = parameters.flatMap((parameter) => {
      const match = /^\s*rel\s*=\s*"([^"]*)"\s*$/iu.exec(parameter)
      return match?.[1]?.split(/\s+/u) ?? []
    })
    if (!relations.includes('next')) {
      continue
    }
    const targetMatch = /^<([^<>]+)>$/u.exec(target ?? '')
    if (targetMatch?.[1] === undefined) {
      throw paginationError('GitHub returned an invalid next page link')
    }
    try {
      const nextUrl = new URL(targetMatch[1], requestUrl)
      if (nextUrl.origin !== new URL(apiBaseUrl).origin) {
        throw paginationError('GitHub next page URL has an unexpected origin')
      }
      return nextUrl.href
    } catch (cause: unknown) {
      if (cause instanceof TrackerError) {
        throw cause
      }
      throw paginationError('GitHub returned an invalid next page URL', cause)
    }
  }
  return null
}

const githubRequest = (
  provider: GitHubProviderConfig,
  url: string,
): Effect.Effect<GitHubResponse, TrackerError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${provider.token}`,
          'User-Agent': 'symphony-ts/0.1',
          'X-GitHub-Api-Version': githubApiVersion,
        },
      })
      if (response.status === 403 && response.headers.has('retry-after')) {
        throw new TrackerError({
          category: 'tracker_rate_limited',
          message: 'GitHub rate limit exceeded',
          retryable: true,
        })
      }
      if (!response.ok) {
        throw new TrackerError({
          category: 'tracker_status',
          message: `GitHub returned HTTP ${String(response.status)}`,
          retryable: response.status >= 500,
        })
      }
      const body: unknown = await response.json()
      if (!isJsonValue(body)) {
        throw new TrackerError({
          category: 'tracker_response',
          message: 'GitHub returned non-JSON data',
          retryable: false,
        })
      }
      return {
        body,
        nextUrl: parseNextUrl(response.headers.get('link'), url, provider.apiBaseUrl),
      }
    },
    catch: (cause: unknown) =>
      cause instanceof TrackerError
        ? cause
        : new TrackerError({
            category: 'tracker_request',
            message: 'GitHub request failed',
            retryable: true,
            cause,
          }),
  })

const githubBranchExists = (
  provider: GitHubProviderConfig,
  prefix: string,
  branchName: string,
): Effect.Effect<boolean, TrackerError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `${provider.apiBaseUrl}${prefix}/git/ref/heads/${encodeURIComponent(branchName)}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${provider.token}`,
            'User-Agent': 'symphony-ts/0.1',
            'X-GitHub-Api-Version': githubApiVersion,
          },
        },
      )
      if (response.status === 404) {
        return false
      }
      if (!response.ok) {
        throw new TrackerError({
          category: 'tracker_status',
          message: `GitHub returned HTTP ${String(response.status)}`,
          retryable: response.status >= 500,
        })
      }
      return true
    },
    catch: (cause: unknown) =>
      cause instanceof TrackerError
        ? cause
        : new TrackerError({
            category: 'tracker_request',
            message: 'GitHub branch lookup failed',
            retryable: true,
            cause,
          }),
  })

const decodePullRequestUrl = (value: JsonValue): string => {
  if (!isJsonRecord(value) || typeof value['html_url'] !== 'string') {
    throw new TrackerError({
      category: 'tracker_response',
      message: 'GitHub pull request is missing html_url',
      retryable: false,
    })
  }
  return value['html_url']
}

const findPullRequest = (
  provider: GitHubProviderConfig,
  prefix: string,
  branchName: string,
): Effect.Effect<string | null, TrackerError> =>
  githubRequest(
    provider,
    `${provider.apiBaseUrl}${prefix}/pulls?state=open&head=${encodeURIComponent(`${provider.owner}:${branchName}`)}&base=${encodeURIComponent(provider.baseBranch)}&per_page=100`,
  ).pipe(
    Effect.flatMap(({ body }) => {
      if (!isJsonArray(body)) {
        return Effect.fail(
          new TrackerError({
            category: 'tracker_response',
            message: 'GitHub pull request list is not an array',
            retryable: false,
          }),
        )
      }
      const first = body[0]
      return Effect.succeed(first === undefined ? null : decodePullRequestUrl(first))
    }),
  )

const createPullRequest = (
  provider: GitHubProviderConfig,
  prefix: string,
  issue: Issue,
  branchName: string,
): Effect.Effect<string, TrackerError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${provider.apiBaseUrl}${prefix}/pulls`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${provider.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'symphony-ts/0.1',
          'X-GitHub-Api-Version': githubApiVersion,
        },
        body: JSON.stringify({
          base: provider.baseBranch,
          head: branchName,
          title: issue.title,
          body: `Closes #${issue.id}`,
        }),
      })
      if (!response.ok) {
        throw new TrackerError({
          category: 'tracker_status',
          message: `GitHub returned HTTP ${String(response.status)}`,
          retryable: response.status >= 500,
        })
      }
      const body: unknown = await response.json()
      if (!isJsonValue(body)) {
        throw new TrackerError({
          category: 'tracker_response',
          message: 'GitHub returned non-JSON pull request data',
          retryable: false,
        })
      }
      return decodePullRequestUrl(body)
    },
    catch: (cause: unknown) =>
      cause instanceof TrackerError
        ? cause
        : new TrackerError({
            category: 'tracker_request',
            message: 'GitHub pull request creation failed',
            retryable: true,
            cause,
          }),
  })

export const issueBranchName = (issue: Issue): string => `symphony/issue-${issue.id}`

const fetchBlockedBy = (
  provider: GitHubProviderConfig,
  prefix: string,
  issue: Issue,
): Effect.Effect<readonly BlockerRef[], TrackerError> => {
  const fetchPage = (
    url: string,
    visitedUrls: ReadonlySet<string>,
  ): Effect.Effect<readonly BlockerRef[], TrackerError> =>
    Effect.suspend(() => {
      if (visitedUrls.has(url)) {
        return Effect.fail(paginationError('GitHub dependency pagination contains a cycle'))
      }
      return githubRequest(provider, url).pipe(
        Effect.flatMap(({ body, nextUrl }) => {
          if (!isJsonArray(body)) {
            return Effect.fail(
              new TrackerError({
                category: 'tracker_response',
                message: 'GitHub issue dependency list is not an array',
                retryable: false,
              }),
            )
          }
          let blockers: readonly BlockerRef[]
          try {
            blockers = body.map((value) =>
              normalizeDependency(decodeGitHubDependency(value), provider),
            )
          } catch (cause: unknown) {
            return Effect.fail(
              cause instanceof TrackerError
                ? cause
                : new TrackerError({
                    category: 'tracker_response',
                    message: 'GitHub issue dependency could not be decoded',
                    retryable: false,
                    cause,
                  }),
            )
          }
          if (nextUrl === null) {
            return Effect.succeed(blockers)
          }
          return fetchPage(nextUrl, new Set([...visitedUrls, url])).pipe(
            Effect.map((nextBlockers) => [...blockers, ...nextBlockers]),
          )
        }),
      )
    })
  return fetchPage(
    `${provider.apiBaseUrl}${prefix}/issues/${encodeURIComponent(issue.id)}/dependencies/blocked_by?per_page=100`,
    new Set(),
  )
}

const hydrateDependencies = (
  provider: GitHubProviderConfig,
  prefix: string,
  issues: readonly Issue[],
  dependencyLabels: readonly string[] | null,
  cache: Map<IssueId, DependencyCacheEntry>,
): Effect.Effect<readonly Issue[], TrackerError> =>
  Effect.forEach(
    issues,
    (issue) => {
      const shouldHydrate =
        dependencyLabels === null ||
        dependencyLabels.every((label) => issue.labels.includes(label.trim().toLowerCase()))
      if (!shouldHydrate) {
        return Effect.succeed(issue)
      }
      const issueUpdatedAt = issue.updatedAt?.getTime() ?? null
      const cached = cache.get(issue.id)
      if (
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

export const makeGitHubTracker = (provider: GitHubProviderConfig): TrackerAdapter => {
  const prefix = `/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
  const dependencyCache = new Map<IssueId, DependencyCacheEntry>()
  return {
    secretEnvironmentNames: ['GITHUB_TOKEN', 'GH_TOKEN'],
    fetchIssuesByStates: (
      states,
      dependencyLabels,
    ): Effect.Effect<readonly Issue[], TrackerError> => {
      if (states.length === 0) {
        return Effect.succeed([])
      }
      const fetchPage = (
        url: string,
        visitedUrls: ReadonlySet<string>,
      ): Effect.Effect<readonly Issue[], TrackerError> =>
        Effect.suspend(() => {
          if (visitedUrls.has(url)) {
            return Effect.fail(paginationError('GitHub pagination contains a cycle'))
          }
          return githubRequest(provider, url).pipe(
            Effect.flatMap(({ body, nextUrl }) => {
              if (!isJsonArray(body)) {
                return Effect.fail(
                  new TrackerError({
                    category: 'tracker_response',
                    message: 'GitHub issue list is not an array',
                    retryable: false,
                  }),
                )
              }
              const issues: Issue[] = []
              for (const item of body) {
                try {
                  const issue = normalizeIssue(decodeGitHubIssue(item), provider)
                  if (issue.dispatchable) {
                    issues.push(issue)
                  }
                } catch (error: unknown) {
                  if (!(error instanceof TrackerError)) {
                    throw error
                  }
                }
              }
              if (nextUrl === null) {
                return Effect.succeed(issues)
              }
              return fetchPage(nextUrl, new Set([...visitedUrls, url])).pipe(
                Effect.map((nextIssues) => [...issues, ...nextIssues]),
              )
            }),
          )
        })
      const fetchState = (state: string): Effect.Effect<readonly Issue[], TrackerError> =>
        fetchPage(
          `${provider.apiBaseUrl}${prefix}/issues?state=${encodeURIComponent(state.toLowerCase())}&per_page=100`,
          new Set(),
        )
      return Effect.forEach(states, fetchState, { concurrency: 1 }).pipe(
        Effect.map((groups) => [
          ...new Map(groups.flat().map((issue) => [issue.id, issue])).values(),
        ]),
        Effect.flatMap((issues) =>
          hydrateDependencies(provider, prefix, issues, dependencyLabels, dependencyCache),
        ),
      )
    },
    fetchIssuesByIds: (ids): Effect.Effect<readonly Issue[], TrackerError> => {
      if (ids.length === 0) {
        return Effect.succeed([])
      }
      return Effect.forEach(
        [...new Set(ids)],
        (id) =>
          githubRequest(
            provider,
            `${provider.apiBaseUrl}${prefix}/issues/${encodeURIComponent(id)}`,
          ).pipe(Effect.map(({ body }) => normalizeIssue(decodeGitHubIssue(body), provider))),
        { concurrency: 4 },
      ).pipe(
        Effect.flatMap((issues) =>
          hydrateDependencies(provider, prefix, issues, [], dependencyCache),
        ),
      )
    },
    handoffCompletedWork: (issue, dispatchLabels) => {
      const branchName = issueBranchName(issue)
      return githubBranchExists(provider, prefix, branchName).pipe(
        Effect.flatMap((exists) => {
          if (!exists) {
            return Effect.succeed<HandoffResult>({ _tag: 'NoBranch', branchName })
          }
          return findPullRequest(provider, prefix, branchName).pipe(
            Effect.flatMap((existingUrl) =>
              existingUrl === null
                ? createPullRequest(provider, prefix, issue, branchName)
                : Effect.succeed(existingUrl),
            ),
            Effect.flatMap((pullRequestUrl) =>
              Effect.forEach(
                dispatchLabels,
                (label) =>
                  githubMutation(
                    provider,
                    `${prefix}/issues/${encodeURIComponent(issue.id)}/labels/${encodeURIComponent(label)}`,
                    'DELETE',
                    undefined,
                  ),
                { concurrency: 1, discard: true },
              ).pipe(
                Effect.as<HandoffResult>({
                  _tag: 'PullRequest',
                  branchName,
                  pullRequestUrl,
                }),
              ),
            ),
          )
        }),
      )
    },
  }
}

const githubMutation = (
  provider: GitHubProviderConfig,
  path: string,
  method: 'POST' | 'DELETE',
  body: string | undefined,
): Effect.Effect<void, TrackerError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${provider.apiBaseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${provider.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'symphony-ts/0.1',
          'X-GitHub-Api-Version': githubApiVersion,
        },
        ...(body === undefined ? {} : { body }),
      })
      if (method === 'DELETE' && response.status === 404) {
        return
      }
      if (!response.ok) {
        throw new TrackerError({
          category: 'tracker_status',
          message: `GitHub returned HTTP ${String(response.status)}`,
          retryable: response.status >= 500,
        })
      }
    },
    catch: (cause: unknown) =>
      cause instanceof TrackerError
        ? cause
        : new TrackerError({
            category: 'tracker_request',
            message: 'GitHub mutation failed',
            retryable: true,
            cause,
          }),
  })

export const makeGitHubIssueControl = (provider: GitHubProviderConfig): GitHubIssueControl => {
  const prefix = `/repos/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}`
  const tracker = makeGitHubTracker(provider)
  return {
    listOpenIssues: () => tracker.fetchIssuesByStates(['open'], null),
    setLabel: (issueNumber, label, enabled) => {
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
      if (enabled) {
        return githubMutation(
          provider,
          `${prefix}/issues/${String(issueNumber)}/labels`,
          'POST',
          JSON.stringify({ labels: [label] }),
        )
      }
      return githubMutation(
        provider,
        `${prefix}/issues/${String(issueNumber)}/labels/${encodeURIComponent(label)}`,
        'DELETE',
        undefined,
      )
    },
  }
}
