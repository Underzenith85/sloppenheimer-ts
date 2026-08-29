import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeGitHubPullRequestMonitor } from '../src/github-handoff.js'
import type { GitHubProviderConfig } from '../src/workflow.js'

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'symphony',
  token: 'secret',
  tokenEnvironmentName: 'TEST_TOKEN',
  apiBaseUrl: 'https://api.github.test',
  baseBranch: 'main',
}

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('GitHub pull request monitor', (): void => {
  it('reads the exact head, checks, and unresolved review threads', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.endsWith('/pulls/41')) {
          return Response.json({
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
        return Response.json({ merged: true, sha: 'merge-1', message: 'merged' })
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      Effect.runPromise(makeGitHubPullRequestMonitor(provider).merge(41, 'head-1')),
    ).resolves.toBe('merge-1')
  })
})
