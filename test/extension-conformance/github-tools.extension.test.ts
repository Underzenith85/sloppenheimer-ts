import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from '@effect/vitest'
import { Effect, Option, Redacted } from 'effect'
import { describe, expect } from 'vitest'

import {
  runAgent,
  type AgentEvent,
  type AgentLaunch,
  type AgentResult,
} from '@symphony/adapter-codex/codex.js'
import type { AgentError } from '@symphony/core/domain/errors.js'
import { makeHostToolSession } from '@symphony/core/core/dispatch.js'
import {
  issueId,
  issueIdentifier,
  type Issue,
  type JsonValue,
} from '@symphony/core/domain/domain.js'
import type {
  HostToolContext,
  HostToolResult,
  HostToolSession,
  HostToolSpec,
} from '@symphony/core/domain/host-tools.js'
import { makeGitHubCodeReview } from '@symphony/adapter-github/code-review.js'
import { makeGitHubTracker } from '@symphony/adapter-github/issues.js'
import type { TrackerPort } from '@symphony/core/ports/tracker.js'
import type { GitHubProviderConfig } from '@symphony/adapter-github'
import type { CodexConfig } from '@symphony/core/config/workflow.js'
import { hostFileSystem } from '../harness/filesystem.js'

/** Launch verification reads the workspace through `FileSystem`; the host's is bound here. */
const runAgentOnHost = (launch: AgentLaunch): Effect.Effect<AgentResult, AgentError> =>
  runAgent(launch).pipe(Effect.provide(hostFileSystem))

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
  token: Redacted.make('host-token'),
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

/**
 * Tracker construction is an effect only because it allocates the dependency cache `Ref`, so it
 * is yielded in the test's own fiber rather than run out to a value.
 */
const trackerOf = (config: GitHubProviderConfig): Effect.Effect<TrackerPort> =>
  makeGitHubTracker(config)

/**
 * The host-tool boundary answers either synchronously or with a promise, so this normalizes one
 * call into the effect under test.
 */
const executed = (
  work: () => HostToolResult | Promise<HostToolResult>,
): Effect.Effect<HostToolResult> => Effect.promise(async () => work())

describe('GitHub provider-native tool extension', (): void => {
  it.effect('publishes capability-scoped profiles and rejects disabled code-review tools', () =>
    Effect.gen(function* () {
      const tracker = yield* trackerOf(provider)
      const codeReview = makeGitHubCodeReview(provider)

      expect(tracker.toolSpecs.map((tool) => tool.name)).toEqual([
        'github_add_comment',
        'github_handoff_issue',
      ])
      expect(codeReview.toolSpecs.map((tool) => tool.name)).toEqual(['github_link_pull_request'])

      const disabledSession = makeHostToolSession({ tracker, codeReview: Option.none() }, issue)
      expect(disabledSession.specs.map((tool) => tool.name)).toEqual([
        'github_add_comment',
        'github_handoff_issue',
      ])
      expect(
        yield* executed(() =>
          disabledSession.execute(
            'github_link_pull_request',
            { pull_request_number: 7 },
            toolContext,
          ),
        ),
      ).toMatchObject({
        success: false,
        error: { code: 'unsupported_tool', retryable: false },
      })

      const enabledSession = makeHostToolSession(
        { tracker, codeReview: Option.some(codeReview) },
        issue,
      )
      expect(enabledSession.specs.map((tool) => tool.name)).toEqual([
        'github_add_comment',
        'github_handoff_issue',
        'github_link_pull_request',
      ])
      expect(
        yield* executed(() =>
          enabledSession.execute(
            'github_add_comment',
            { body: 'hello', token: 'model-value' },
            toolContext,
          ),
        ),
      ).toMatchObject({
        success: false,
        error: { code: 'invalid_arguments', retryable: false },
      })
      expect(
        yield* executed(() => enabledSession.execute('github_unknown', {}, toolContext)),
      ).toMatchObject({
        success: false,
        error: { code: 'unsupported_tool', retryable: false },
      })
    }),
  )

  it.effect.each([
    {
      name: 'case-insensitive duplicate labels',
      argumentsValue: { add_labels: ['Ready', 'ready'] },
    },
    {
      name: 'case-insensitive overlap between added and removed labels',
      argumentsValue: { add_labels: ['Ready'], remove_labels: ['ready'] },
    },
  ])('rejects $name', ({ argumentsValue }) =>
    Effect.gen(function* () {
      const tracker = yield* trackerOf(provider)

      expect(
        yield* executed(() =>
          tracker.executeTool('github_handoff_issue', argumentsValue, toolContext),
        ),
      ).toMatchObject({
        success: false,
        error: { code: 'invalid_arguments', retryable: false },
      })
    }),
  )

  it.effect(
    'maps auth, authorization, rate-limit, and transport errors to structured failures',
    () => {
      const originalFetch = globalThis.fetch
      const comment = (tracker: TrackerPort): Effect.Effect<HostToolResult> =>
        executed(() => tracker.executeTool('github_add_comment', { body: 'hello' }, toolContext))

      return Effect.gen(function* () {
        const missingAuth = yield* trackerOf({ ...provider, token: Redacted.make('') })
        expect(yield* comment(missingAuth)).toMatchObject({
          success: false,
          error: { code: 'missing_auth' },
        })

        globalThis.fetch = async (): Promise<Response> =>
          new Response(null, {
            status: 429,
            headers: { 'retry-after': '2' },
          })
        expect(yield* comment(yield* trackerOf(provider))).toMatchObject({
          success: false,
          error: { code: 'rate_limited', retryable: true, retryAfterMs: 2_000 },
        })

        globalThis.fetch = async (): Promise<Response> => new Response(null, { status: 403 })
        expect(yield* comment(yield* trackerOf(provider))).toMatchObject({
          success: false,
          error: { code: 'authorization_failed', retryable: false },
        })

        globalThis.fetch = async (): Promise<Response> => {
          throw new TypeError('offline')
        }
        expect(yield* comment(yield* trackerOf(provider))).toMatchObject({
          success: false,
          error: { code: 'transport_error', retryable: true },
        })
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.fetch = originalFetch
          }),
        ),
      )
    },
  )

  it.effect('performs only scoped comment, handoff, and pull-request linkage mutations', () => {
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
    return Effect.gen(function* () {
      const tracker = yield* trackerOf(provider)
      const codeReview = makeGitHubCodeReview(provider)
      const hostTools = makeHostToolSession({ tracker, codeReview: Option.some(codeReview) }, issue)
      expect(
        yield* executed(() =>
          hostTools.execute('github_add_comment', { body: 'status update' }, toolContext),
        ),
      ).toMatchObject({ success: true })
      expect(
        yield* executed(() =>
          hostTools.execute(
            'github_handoff_issue',
            { state: 'closed', add_labels: ['done'], remove_labels: ['symphony'] },
            toolContext,
          ),
        ),
      ).toMatchObject({ success: true })
      expect(
        yield* executed(() =>
          hostTools.execute('github_link_pull_request', { pull_request_number: 7 }, toolContext),
        ),
      ).toMatchObject({
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
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          globalThis.fetch = originalFetch
        }),
      ),
    )
  })

  // `live` for both: the Codex session under test is a real child process on real turn timeouts.
  it.live(
    'advertises the selected profile and executes with frozen host context and no child secret',
    () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), 'symphony-github-tools-')),
        )
        const workspacePath = join(workspaceRoot, 'issue-20')
        yield* Effect.promise(() => mkdir(workspacePath))
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

        const result = yield* runAgentOnHost({
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
        }).pipe(
          // The `finally` this replaces: the borrowed environment variable is put back and the
          // workspace removed however the run ends, interruption included.
          Effect.ensuring(
            Effect.promise(async () => {
              if (previous === undefined) {
                delete process.env['SYMPHONY_HOST_TOOL_TOKEN']
              } else {
                process.env['SYMPHONY_HOST_TOOL_TOKEN'] = previous
              }
              await rm(workspaceRoot, { force: true, recursive: true })
            }),
          ),
        )

        expect(result.turnCount).toBe(1)
        expect(calls).toEqual([{ argumentsValue: { body: 'host-side comment' }, context }])
        expect(JSON.stringify({ calls, events, dynamicTools })).not.toContain(
          'host-only-secret-value',
        )
        expect(events).toEqual(
          expect.arrayContaining([expect.objectContaining({ event: 'host_tool_succeeded' })]),
        )
      }),
    30_000,
  )

  it.live(
    'returns a structured unsupported-name failure without stalling the turn',
    () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), 'symphony-github-tools-')),
        )
        const workspacePath = join(workspaceRoot, 'issue-20')
        yield* Effect.promise(() => mkdir(workspacePath))
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

        const result = yield* runAgentOnHost({
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
        }).pipe(
          Effect.ensuring(
            Effect.promise(() => rm(workspaceRoot, { force: true, recursive: true })),
          ),
        )

        expect(result.turnCount).toBe(1)
      }),
    30_000,
  )
})
