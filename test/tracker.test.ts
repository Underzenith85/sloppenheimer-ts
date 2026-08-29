import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { issueId, issueIdentifier, type Issue, type JsonObject } from '../src/domain.js'
import { issueBranchName, makeGitHubTracker } from '../src/tracker.js'
import type { GitHubProviderConfig } from '../src/workflow.js'

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'symphony',
  token: 'secret',
  tokenEnvironmentName: 'CUSTOM_GITHUB_TOKEN',
  apiBaseUrl: 'https://api.example.test',
  baseBranch: 'main',
}

const githubIssue = (number: number, labels: readonly string[] = []): JsonObject => ({
  number,
  node_id: `node-${String(number)}`,
  title: `Issue ${String(number)}`,
  body: null,
  state: 'open',
  html_url: `https://example.test/issues/${String(number)}`,
  assignee: null,
  labels: labels.map((name) => ({ name })),
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
})

const githubDependency = (number: number, state = 'open'): JsonObject => ({
  id: 10_000 + number,
  number,
  title: `Blocker ${String(number)}`,
  state,
  repository_url: 'https://api.example.test/repos/example/symphony',
  html_url: `https://example.test/issues/${String(number)}`,
})

const handoffIssue: Issue = {
  id: issueId('28'),
  nativeRef: null,
  identifier: issueIdentifier('example/symphony#28'),
  title: 'Migrate to pnpm',
  description: null,
  priority: null,
  state: 'open',
  branchName: null,
  url: 'https://example.test/issues/28',
  assigneeId: null,
  labels: ['symphony'],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
}

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === 'string') {
    return input
  }
  return input instanceof URL ? input.href : input.url
}

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('GitHub tracker authentication provenance', (): void => {
  it('declares the configured secret variable and all fallback aliases', (): void => {
    expect(makeGitHubTracker(provider).secretEnvironmentNames).toEqual([
      'CUSTOM_GITHUB_TOKEN',
      'GITHUB_TOKEN',
      'GH_TOKEN',
    ])
  })

  it('deduplicates a configured fallback alias', (): void => {
    expect(
      makeGitHubTracker({ ...provider, tokenEnvironmentName: 'GH_TOKEN' }).secretEnvironmentNames,
    ).toEqual(['GH_TOKEN', 'GITHUB_TOKEN'])
  })
})

describe('GitHub tracker pagination', (): void => {
  it('combines all pages and removes duplicate issues', async (): Promise<void> => {
    const secondPageUrl =
      'https://api.example.test/repos/example/symphony/issues?state=open&per_page=100&page=2'
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        if (requestUrl(input).includes('/dependencies/blocked_by')) {
          return Response.json([])
        }
        if (requestUrl(input) === secondPageUrl) {
          return Response.json([githubIssue(2), githubIssue(3)])
        }
        return Response.json([githubIssue(1), githubIssue(2)], {
          headers: {
            Link: `<${secondPageUrl}>; rel="next", <${secondPageUrl}>; rel="last"`,
          },
        })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByStates(['open'], null),
    )

    expect(issues.map((issue) => issue.id)).toEqual(['1', '2', '3'])
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true)
    expect(fetchMock.mock.calls.slice(0, 2).map(([input]) => requestUrl(input))).toEqual([
      'https://api.example.test/repos/example/symphony/issues?state=open&per_page=100',
      secondPageUrl,
    ])
  })

  it('preserves response decoding errors from later pages', async (): Promise<void> => {
    const secondPageUrl =
      'https://api.example.test/repos/example/symphony/issues?state=open&per_page=100&page=2'
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      if (requestUrl(input) === secondPageUrl) {
        return Response.json({ issue: githubIssue(2) })
      }
      return Response.json([githubIssue(1)], {
        headers: { Link: `<${secondPageUrl}>; rel="next"` },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'], null)),
    )

    expect(error.category).toBe('tracker_response')
    expect(error.retryable).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not send the tracker token to a different origin', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      Response.json([githubIssue(1)], {
        headers: { Link: '<https://attacker.example.test/issues?page=2>; rel="next"' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'], null)),
    )

    expect(error.category).toBe('tracker_pagination')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('GitHub native issue dependencies', (): void => {
  it('skips dependency hydration when the caller requests issue metadata only', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> => Response.json([githubIssue(1)]))
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByStates(['closed'], null, {
        hydrateDependencies: false,
      }),
    )

    expect(issues).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('hydrates dependencies when the label filter is empty', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      requestUrl(input).includes('/dependencies/blocked_by')
        ? Response.json([githubDependency(2)])
        : Response.json([githubIssue(1)]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const [issue] = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByStates(['open'], []),
    )

    expect(issue?.blockedBy).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('hydrates only dispatch candidates for scheduler list requests', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = requestUrl(input)
      return url.includes('/dependencies/blocked_by')
        ? Response.json([])
        : Response.json([githubIssue(1, ['symphony']), githubIssue(2)])
    })
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByStates(['open'], ['symphony']),
    )

    expect(issues).toHaveLength(2)
    expect(
      fetchMock.mock.calls
        .map(([input]) => requestUrl(input))
        .filter((url) => url.includes('/dependencies/blocked_by')),
    ).toEqual([
      'https://api.example.test/repos/example/symphony/issues/1/dependencies/blocked_by?per_page=100',
    ])
  })

  it('caches console dependency hydration between backlog refreshes', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      requestUrl(input).includes('/dependencies/blocked_by')
        ? Response.json([githubDependency(2)])
        : Response.json([githubIssue(1)]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const tracker = makeGitHubTracker(provider)

    await Effect.runPromise(tracker.fetchIssuesByStates(['open'], null))
    const [second] = await Effect.runPromise(tracker.fetchIssuesByStates(['open'], null))

    expect(second?.blockedBy).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('bypasses the dependency cache for issue ID refreshes', async (): Promise<void> => {
    let dependencyFetches = 0
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = requestUrl(input)
      if (url.endsWith('/issues/2')) {
        return Response.json(githubIssue(2))
      }
      dependencyFetches += 1
      return Response.json([githubDependency(3, dependencyFetches === 1 ? 'closed' : 'open')])
    })
    vi.stubGlobal('fetch', fetchMock)
    const tracker = makeGitHubTracker(provider)

    await Effect.runPromise(tracker.fetchIssuesByIds([issueId('2')]))
    const [refreshed] = await Effect.runPromise(tracker.fetchIssuesByIds([issueId('2')]))

    expect(refreshed?.blockedBy[0]?.state).toBe('open')
    expect(dependencyFetches).toBe(2)
  })

  it('decodes blockers and follows dependency pagination', async (): Promise<void> => {
    const next =
      'https://api.example.test/repos/example/symphony/issues/2/dependencies/blocked_by?per_page=100&page=2'
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = requestUrl(input)
        if (url.endsWith('/issues/2')) {
          return Response.json(githubIssue(2))
        }
        if (url === next) {
          return Response.json([githubDependency(4, 'closed')])
        }
        expect(new Headers(init?.headers).get('X-GitHub-Api-Version')).toBe('2026-03-10')
        return Response.json([githubDependency(3)], { headers: { Link: `<${next}>; rel="next"` } })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    const [issue] = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByIds([issueId('2')]),
    )

    expect(issue?.blockedBy).toEqual([
      {
        id: '10003',
        identifier: 'example/symphony#3',
        title: 'Blocker 3',
        state: 'open',
        url: 'https://example.test/issues/3',
      },
      {
        id: '10004',
        identifier: 'example/symphony#4',
        title: 'Blocker 4',
        state: 'closed',
        url: 'https://example.test/issues/4',
      },
    ])
  })

  it.each([
    ['missing state', { ...githubDependency(3), state: undefined }],
    ['malformed id', { ...githubDependency(3), id: 'not-a-number' }],
    ['missing repository', { ...githubDependency(3), repository_url: undefined }],
  ])('fails conservatively for %s', async (_name, dependency): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      requestUrl(input).endsWith('/issues/2')
        ? Response.json(githubIssue(2))
        : Response.json([dependency]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByIds([issueId('2')])),
    )

    expect(error.category).toBe('tracker_response')
    expect(error.retryable).toBe(false)
  })

  it('preserves useful dependency API errors', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      requestUrl(input).endsWith('/issues/2')
        ? Response.json(githubIssue(2))
        : new Response(null, { status: 503 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByIds([issueId('2')])),
    )

    expect(error.category).toBe('tracker_status')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('503')
  })
})

describe('GitHub pull request handoff', (): void => {
  it('continues when the expected issue branch has not been pushed', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await Effect.runPromise(
      makeGitHubTracker(provider).handoffCompletedWork(handoffIssue, ['symphony']),
    )

    expect(result).toEqual({ _tag: 'NoBranch', branchName: 'symphony/issue-28' })
    expect(issueBranchName(handoffIssue)).toBe('symphony/issue-28')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('creates a pull request without changing dispatch labels after a branch is pushed', async (): Promise<void> => {
    const requests: Array<Readonly<{ url: string; method: string }>> = []
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = requestUrl(input)
        const method = init?.method ?? 'GET'
        requests.push({ url, method })
        if (url.endsWith('/git/ref/heads/symphony%2Fissue-28')) {
          return Response.json({ ref: 'refs/heads/symphony/issue-28' })
        }
        if (url.includes('/pulls?')) {
          return Response.json([])
        }
        if (url.endsWith('/pulls') && method === 'POST') {
          expect(init?.body).toBe(
            JSON.stringify({
              base: 'main',
              head: 'symphony/issue-28',
              title: 'Migrate to pnpm',
              body: 'Closes #28',
            }),
          )
          return Response.json({ html_url: 'https://example.test/pulls/31' }, { status: 201 })
        }
        return new Response(null, { status: 500 })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await Effect.runPromise(
      makeGitHubTracker(provider).handoffCompletedWork(handoffIssue, ['symphony']),
    )

    expect(result).toEqual({
      _tag: 'PullRequest',
      branchName: 'symphony/issue-28',
      pullRequestUrl: 'https://example.test/pulls/31',
      pullRequestNumber: 31,
    })
    expect(requests.map(({ method }) => method)).toEqual(['GET', 'GET', 'POST'])
  })

  it('reuses an existing pull request without changing dispatch labels', async (): Promise<void> => {
    const methods: string[] = []
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = requestUrl(input)
        const method = init?.method ?? 'GET'
        methods.push(method)
        if (url.includes('/git/ref/heads/')) {
          return Response.json({ ref: 'refs/heads/symphony/issue-28' })
        }
        if (url.includes('/pulls?')) {
          return Response.json([{ html_url: 'https://example.test/pulls/31' }])
        }
        return new Response(null, { status: 204 })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await Effect.runPromise(
      makeGitHubTracker(provider).handoffCompletedWork(handoffIssue, ['symphony']),
    )

    expect(result._tag).toBe('PullRequest')
    expect(methods).toEqual(['GET', 'GET'])
  })
})
