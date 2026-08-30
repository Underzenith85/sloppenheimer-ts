import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeGitHubPullRequestMonitor } from '../src/github-handoff.js'
import { issueId, issueIdentifier, type Issue } from '../src/domain.js'
import { classifyPullRequest } from '../src/handoff.js'
import { issueBranchName, makeGitHubTracker } from '../src/tracker.js'
import type { GitHubProviderConfig } from '../src/workflow.js'

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'symphony',
  token: 'secret',
  tokenEnvironmentName: 'TEST_TOKEN',
  apiBaseUrl: 'https://api.github.test',
  baseBranch: 'main',
}

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
      created: true,
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

    // Adopted rather than opened, which the agent detail reports as a reused pull request.
    expect(result).toMatchObject({ _tag: 'PullRequest', created: false })
    expect(methods).toEqual(['GET', 'GET'])
  })
})

describe('GitHub pull request monitor', (): void => {
  it('accepts a merged pull request with an omitted merge SHA', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      Response.json({
        state: 'closed',
        merged: true,
        mergeable: null,
        mergeable_state: 'unknown',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await Effect.runPromise(makeGitHubPullRequestMonitor(provider).inspect(44))

    expect(classifyPullRequest(result)).toEqual({ state: 'merged', mergeCommitSha: null })
    expect(result).toMatchObject({
      number: 44,
      state: 'closed',
      url: null,
      headSha: null,
      merged: true,
      mergeCommitSha: null,
      mergeable: null,
      mergeState: 'unknown',
      checks: [],
      reviewThreads: [],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      name: 'missing merged status',
      response: { state: 'open', merge_commit_sha: null },
      message:
        'GitHub pull request #44 field "merged" is invalid: expected boolean, received missing',
    },
    {
      name: 'invalid head SHA',
      response: {
        state: 'open',
        html_url: 'https://github.test/example/symphony/pull/44',
        head: { sha: 42 },
        merged: false,
        merge_commit_sha: null,
        mergeable: true,
        mergeable_state: 'clean',
      },
      message:
        'GitHub pull request #44 field "head.sha" is invalid: expected string, received number',
    },
    {
      name: 'invalid open mergeability',
      response: {
        state: 'open',
        html_url: 'https://github.test/example/symphony/pull/44',
        head: { sha: 'sensitive-head-value' },
        merged: false,
        merge_commit_sha: null,
        mergeable: 'sensitive-payload-value',
        mergeable_state: 'clean',
      },
      message:
        'GitHub pull request #44 field "mergeable" is invalid: expected boolean or null, received string',
    },
  ])('reports a typed field error for $name', async ({ response, message }): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => Response.json(response)),
    )

    const error = await Effect.runPromise(
      Effect.flip(makeGitHubPullRequestMonitor(provider).inspect(44)),
    )

    expect(error).toMatchObject({
      category: 'tracker_response',
      message,
      retryable: false,
    })
    expect(error.message).not.toContain('sensitive')
  })

  it('decodes a closed unmerged pull request without inspecting open-PR status', async (): Promise<void> => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      Response.json({ state: 'closed', merged: false }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await Effect.runPromise(makeGitHubPullRequestMonitor(provider).inspect(50))

    expect(result).toEqual({
      number: 50,
      state: 'closed',
      url: null,
      headSha: null,
      merged: false,
      mergeCommitSha: null,
      mergeable: null,
      mergeState: null,
      checks: [],
      reviewDecision: null,
      reviewThreads: [],
    })
    expect(classifyPullRequest(result).state).toBe('closed_without_merge')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reads the exact head, checks, and unresolved review threads', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.endsWith('/pulls/41')) {
          return Response.json({
            state: 'open',
            html_url: 'https://github.test/example/symphony/pull/41',
            head: { sha: 'head-1' },
            merged: false,
            merge_commit_sha: null,
            mergeable: true,
            mergeable_state: 'clean',
          })
        }
        if (url.includes('/check-runs')) {
          return Response.json({
            check_runs: [
              {
                name: 'quality',
                status: 'completed',
                conclusion: 'success',
                details_url: 'https://github.test/check/1',
              },
            ],
          })
        }
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewDecision: null,
                reviewThreads: {
                  nodes: [
                    {
                      id: 'thread-1',
                      isResolved: false,
                      comments: {
                        nodes: [{ body: 'Fix this', url: 'https://github.test/comment' }],
                      },
                    },
                  ],
                },
              },
            },
          },
        })
      }),
    )

    const result = await Effect.runPromise(makeGitHubPullRequestMonitor(provider).inspect(41))

    expect(result.headSha).toBe('head-1')
    expect(result.checks[0]?.name).toBe('quality')
    expect(result.reviewThreads[0]).toMatchObject({ resolved: false, body: 'Fix this' })
  })

  it('guards the merge with the observed head SHA', async (): Promise<void> => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(init?.method).toBe('PUT')
        expect(init?.body).toBe(JSON.stringify({ sha: 'head-1', merge_method: 'squash' }))
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return Response.json({ merged: true, sha: 'merge-1', message: 'merged' })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      Effect.runPromise(makeGitHubPullRequestMonitor(provider).merge(41, 'head-1')),
    ).resolves.toBe('merge-1')
  })

  it('resolves review threads through explicit GraphQL mutations', async (): Promise<void> => {
    const bodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (typeof init?.body === 'string') {
          bodies.push(init.body)
        }
        return Response.json({ data: { resolveReviewThread: { thread: { isResolved: true } } } })
      }),
    )

    await Effect.runPromise(
      makeGitHubPullRequestMonitor(provider).resolveThreads(['thread-1', 'thread-2']),
    )

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toContain('thread-1')
    expect(bodies[1]).toContain('thread-2')
  })
})
