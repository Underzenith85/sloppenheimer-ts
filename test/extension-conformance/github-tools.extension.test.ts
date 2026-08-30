import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { runAgent, type AgentEvent } from '../../src/codex.js'
import { issueId, issueIdentifier, type Issue, type JsonValue } from '../../src/domain.js'
import type { HostToolContext, HostToolSession, HostToolSpec } from '../../src/host-tools.js'
import { makeGitHubTracker } from '../../src/tracker.js'
import type { GitHubProviderConfig } from '../../src/tracker-config.js'
import type { CodexConfig } from '../../src/workflow.js'

const fakeAppServer = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-app-server.ts',
)

const issue: Issue = {
  id: issueId('20'),
  nativeRef: { node_id: 'I_20', issue_number: 20, owner: 'example', repository: 'symphony' },
  identifier: issueIdentifier('example/symphony#20'),
  title: 'Host tools',
  description: null,
  priority: null,
  state: 'open',
  branchName: null,
  url: null,
  assigneeId: null,
  labels: ['symphony'],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
}

const spec: HostToolSpec = {
  name: 'github_add_comment',
  description: 'Add a comment to the current issue using host authentication.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['body'],
    properties: { body: { type: 'string', minLength: 1 } },
  },
}

const provider: GitHubProviderConfig = {
  owner: 'example',
  repository: 'symphony',
  token: 'host-token',
  tokenEnvironmentName: 'SYMPHONY_HOST_TOOL_TOKEN',
  apiBaseUrl: 'https://api.example.test',
  baseBranch: 'main',
}

const toolContext: HostToolContext = {
  issueId: issue.id,
  issueIdentifier: issue.identifier,
  nativeRef: issue.nativeRef,
}

const configFor = (scenario: string, dynamicTools: readonly JsonValue[]): CodexConfig => ({
  command: `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAppServer)} ${JSON.stringify(scenario)} ${JSON.stringify(JSON.stringify({ dynamicTools }))}`,
  approvalPolicy: 'never',
  threadSandbox: 'workspace-write',
  turnSandboxPolicy: null,
  turnTimeoutMs: 2_000,
  readTimeoutMs: 2_000,
  stallTimeoutMs: 0,
})

describe('GitHub provider-native tool extension', (): void => {
  it('publishes a compact mutation-only profile and validates arguments exactly', async (): Promise<void> => {
    const tracker = makeGitHubTracker(provider)

    expect(tracker.toolSpecs.map((tool) => tool.name)).toEqual([
      'github_add_comment',
      'github_handoff_issue',
      'github_link_pull_request',
    ])
    await expect(
      tracker.executeTool(
        'github_add_comment',
        { body: 'hello', token: 'model-value' },
        toolContext,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'invalid_arguments', retryable: false },
    })
    await expect(tracker.executeTool('github_unknown', {}, toolContext)).resolves.toMatchObject({
      success: false,
      error: { code: 'unsupported_tool', retryable: false },
    })
  })

  it.each([
    {
      name: 'case-insensitive duplicate labels',
      argumentsValue: { add_labels: ['Ready', 'ready'] },
    },
    {
      name: 'case-insensitive overlap between added and removed labels',
      argumentsValue: { add_labels: ['Ready'], remove_labels: ['ready'] },
    },
  ])('rejects $name', async ({ argumentsValue }): Promise<void> => {
    const tracker = makeGitHubTracker(provider)

    await expect(
      tracker.executeTool('github_handoff_issue', argumentsValue, toolContext),
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'invalid_arguments', retryable: false },
    })
  })

  it('maps auth, authorization, rate-limit, and transport errors to structured failures', async (): Promise<void> => {
    const missingAuth = makeGitHubTracker({ ...provider, token: '' })
    await expect(
      missingAuth.executeTool('github_add_comment', { body: 'hello' }, toolContext),
    ).resolves.toMatchObject({ success: false, error: { code: 'missing_auth' } })

    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async (): Promise<Response> =>
        new Response(null, {
          status: 429,
          headers: { 'retry-after': '2' },
        })
      await expect(
        makeGitHubTracker(provider).executeTool(
          'github_add_comment',
          { body: 'hello' },
          toolContext,
        ),
      ).resolves.toMatchObject({
        success: false,
        error: { code: 'rate_limited', retryable: true, retryAfterMs: 2_000 },
      })

      globalThis.fetch = async (): Promise<Response> => new Response(null, { status: 403 })
      await expect(
        makeGitHubTracker(provider).executeTool(
          'github_add_comment',
          { body: 'hello' },
          toolContext,
        ),
      ).resolves.toMatchObject({
        success: false,
        error: { code: 'authorization_failed', retryable: false },
      })

      globalThis.fetch = async (): Promise<Response> => {
        throw new TypeError('offline')
      }
      await expect(
        makeGitHubTracker(provider).executeTool(
          'github_add_comment',
          { body: 'hello' },
          toolContext,
        ),
      ).resolves.toMatchObject({
        success: false,
        error: { code: 'transport_error', retryable: true },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('performs only scoped comment, handoff, and pull-request linkage mutations', async (): Promise<void> => {
    const requests: Array<
      Readonly<{ url: string; method: string; body: string | null; auth: string | null }>
    > = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
        auth: headers.get('authorization'),
      })
      if (url.endsWith('/pulls/7')) {
        return Response.json({ html_url: 'https://example.test/pull/7' })
      }
      if (url.endsWith('/comments')) {
        return Response.json({ html_url: 'https://example.test/comment/1' })
      }
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      return Response.json({ ok: true })
    }
    try {
      const tracker = makeGitHubTracker(provider)
      await expect(
        tracker.executeTool('github_add_comment', { body: 'status update' }, toolContext),
      ).resolves.toMatchObject({ success: true })
      await expect(
        tracker.executeTool(
          'github_handoff_issue',
          { state: 'closed', add_labels: ['done'], remove_labels: ['symphony'] },
          toolContext,
        ),
      ).resolves.toMatchObject({ success: true })
      await expect(
        tracker.executeTool('github_link_pull_request', { pull_request_number: 7 }, toolContext),
      ).resolves.toMatchObject({
        success: true,
        data: { issue_number: 20, pull_request_number: 7 },
      })

      expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        'POST https://api.example.test/repos/example/symphony/issues/20/comments',
        'PATCH https://api.example.test/repos/example/symphony/issues/20',
        'POST https://api.example.test/repos/example/symphony/issues/20/labels',
        'DELETE https://api.example.test/repos/example/symphony/issues/20/labels/symphony',
        'GET https://api.example.test/repos/example/symphony/pulls/7',
        'POST https://api.example.test/repos/example/symphony/issues/20/comments',
      ])
      expect(requests.every((request) => request.auth === 'Bearer host-token')).toBe(true)
      expect(JSON.stringify(requests.map((request) => request.body))).not.toContain('host-token')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('advertises the selected profile and executes with frozen host context and no child secret', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-github-tools-'))
    const workspacePath = join(workspaceRoot, 'issue-20')
    await mkdir(workspacePath)
    const calls: Array<Readonly<{ argumentsValue: JsonValue; context: HostToolContext }>> = []
    const context: HostToolContext = Object.freeze({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      nativeRef: issue.nativeRef,
    })
    const hostTools: HostToolSession = Object.freeze({
      specs: Object.freeze([spec]),
      context,
      execute: (name, argumentsValue, toolContext) => {
        expect(name).toBe('github_add_comment')
        calls.push({ argumentsValue, context: toolContext })
        return { success: true, data: { comment_url: 'https://example.test/comment/1' } }
      },
    })
    const dynamicTools: readonly JsonValue[] = [{ type: 'function', ...spec }]
    const events: AgentEvent[] = []
    const previous = process.env['SYMPHONY_HOST_TOOL_TOKEN']
    process.env['SYMPHONY_HOST_TOOL_TOKEN'] = 'host-only-secret-value'
    try {
      const result = await Effect.runPromise(
        runAgent({
          issue,
          workspace: { path: workspacePath, key: 'issue-20', createdNow: true },
          workspaceRoot,
          config: configFor('host-tool', dynamicTools),
          prompt: 'exercise host tool',
          maxTurns: 1,
          secretEnvironmentNames: ['SYMPHONY_HOST_TOOL_TOKEN'],
          hostTools,
          refreshIssue: () => Effect.succeed(null),
          isRoutable: () => false,
          onEvent: (event) => events.push(event),
        }),
      )

      expect(result.turnCount).toBe(1)
      expect(calls).toEqual([{ argumentsValue: { body: 'host-side comment' }, context }])
      expect(JSON.stringify({ calls, events, dynamicTools })).not.toContain(
        'host-only-secret-value',
      )
      expect(events).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: 'host_tool_succeeded' })]),
      )
    } finally {
      if (previous === undefined) {
        delete process.env['SYMPHONY_HOST_TOOL_TOKEN']
      } else {
        process.env['SYMPHONY_HOST_TOOL_TOKEN'] = previous
      }
      await rm(workspaceRoot, { force: true, recursive: true })
    }
  }, 30_000)

  it('returns a structured unsupported-name failure without stalling the turn', async (): Promise<void> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'symphony-github-tools-'))
    const workspacePath = join(workspaceRoot, 'issue-20')
    await mkdir(workspacePath)
    const hostTools: HostToolSession = {
      specs: [spec],
      context: {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        nativeRef: issue.nativeRef,
      },
      execute: async (name) => ({
        success: false,
        error: {
          code: 'unsupported_tool',
          message: `Unsupported host tool: ${name}`,
          retryable: false,
        },
      }),
    }
    try {
      const result = await Effect.runPromise(
        runAgent({
          issue,
          workspace: { path: workspacePath, key: 'issue-20', createdNow: true },
          workspaceRoot,
          config: configFor('host-tool-unsupported', [{ type: 'function', ...spec }]),
          prompt: 'exercise unsupported tool',
          maxTurns: 1,
          secretEnvironmentNames: [],
          hostTools,
          refreshIssue: () => Effect.succeed(null),
          isRoutable: () => false,
          onEvent: () => undefined,
        }),
      )
      expect(result.turnCount).toBe(1)
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true })
    }
  }, 30_000)
})
