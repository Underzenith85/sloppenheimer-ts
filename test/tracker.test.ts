import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { issueId, issueIdentifier, type Issue, type JsonObject } from '../src/domain.js'
import { issueBranchName, makeGitHubTracker } from '../src/tracker.js'
import type { GitHubProviderConfig } from '../src/workflow.js'

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'symphony',
  token: 'secret',
  apiBaseUrl: 'https://api.example.test',
  baseBranch: 'main',
}

const githubIssue = (number: number): JsonObject => ({
  number,
  node_id: `node-${String(number)}`,
  title: `Issue ${String(number)}`,
  body: null,
  state: 'open',
  html_url: `https://example.test/issues/${String(number)}`,
  assignee: null,
  labels: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
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

describe('GitHub tracker pagination', (): void => {
  it('combines all pages and removes duplicate issues', async (): Promise<void> => {
    const secondPageUrl =
      'https://api.example.test/repos/example/symphony/issues?state=open&per_page=100&page=2'
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      if (requestUrl(input) === secondPageUrl) {
        return Response.json([githubIssue(2), githubIssue(3)])
      }
      return Response.json([githubIssue(1), githubIssue(2)], {
        headers: {
          Link: `<${secondPageUrl}>; rel="next", <${secondPageUrl}>; rel="last"`,
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const issues = await Effect.runPromise(
      makeGitHubTracker(provider).fetchIssuesByStates(['open']),
    )

    expect(issues.map((issue) => issue.id)).toEqual(['1', '2', '3'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
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
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'])),
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
      Effect.flip(makeGitHubTracker(provider).fetchIssuesByStates(['open'])),
    )

    expect(error.category).toBe('tracker_pagination')
    expect(fetchMock).toHaveBeenCalledTimes(1)
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

  it('creates a pull request and removes dispatch labels after a branch is pushed', async (): Promise<void> => {
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
        if (url.endsWith('/issues/28/labels/symphony') && method === 'DELETE') {
          return new Response(null, { status: 204 })
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
    })
    expect(requests.map(({ method }) => method)).toEqual(['GET', 'GET', 'POST', 'DELETE'])
  })

  it('reuses an existing pull request and still removes dispatch labels', async (): Promise<void> => {
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
    expect(methods).toEqual(['GET', 'GET', 'DELETE'])
  })
})
