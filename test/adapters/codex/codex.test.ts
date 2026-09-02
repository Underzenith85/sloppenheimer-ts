import type { FileSystem } from '@effect/platform'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect, type Scope } from 'effect'
import { afterEach, describe, expect, vi } from 'vitest'

import {
  boundedMessage,
  makeCodexEnvironment,
  runAgent as runAgentAgainstFileSystem,
  sessionSecretValues,
  telemetryFrom,
  type AgentLaunch,
} from '@sloppenheimer/adapter-codex/codex.js'
import { withEnvironment } from '../../harness/environment.js'
import { hostFileSystem } from '../../harness/filesystem.js'
import {
  issueId,
  issueIdentifier,
  type Issue,
  type Workspace,
} from '@sloppenheimer/core/domain/domain.js'
import type { VerifiedWorkspace } from '@sloppenheimer/core/domain/workspace-containment.js'
import type { AgentError, WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import type { AgentResult } from '@sloppenheimer/core/ports/agent-runner.js'
import {
  assertWorkspaceIdentity as assertWorkspaceIdentityAgainstFileSystem,
  openVerifiedWorkspace as openVerifiedWorkspaceAgainstFileSystem,
  verifyWorkspaceForLaunch as verifyWorkspaceForLaunchAgainstFileSystem,
} from '@sloppenheimer/adapter-node/workspace-identity.js'
import { codexRunnerConfig } from '../../harness/codex-runner-config.js'
import { anIssue } from '../../harness/fixtures.js'
import { traceCaptureDisabled } from '@sloppenheimer/core/domain/trace.js'

/**
 * Launch verification reads real directories through `FileSystem`, so each entry point is bound to
 * the host's exactly as the composition root binds it and the tests below call it unchanged.
 */
const onHostFileSystem = <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, Error, Exclude<Requirements, FileSystem.FileSystem>> =>
  Effect.provide(effect, hostFileSystem)

const runAgent = (launch: AgentLaunch): Effect.Effect<AgentResult, AgentError> =>
  onHostFileSystem(runAgentAgainstFileSystem(launch))

const verifyWorkspaceForLaunch = (
  root: string,
  workspace: Workspace,
): Effect.Effect<VerifiedWorkspace, WorkspaceError> =>
  onHostFileSystem(verifyWorkspaceForLaunchAgainstFileSystem(root, workspace))

const assertWorkspaceIdentity = (
  root: string,
  verified: VerifiedWorkspace,
): Effect.Effect<void, WorkspaceError> =>
  onHostFileSystem(assertWorkspaceIdentityAgainstFileSystem(root, verified))

const openVerifiedWorkspace = (
  root: string,
  workspace: Workspace,
): Effect.Effect<VerifiedWorkspace, WorkspaceError, Scope.Scope> =>
  onHostFileSystem(openVerifiedWorkspaceAgainstFileSystem(root, workspace))

describe('Codex child environment', (): void => {
  it('removes custom tracker secrets and every GitHub authentication alias', (): void => {
    const secret = 'custom-tracker-secret'
    const environment = makeCodexEnvironment(
      {
        CUSTOM_GITHUB_TOKEN: secret,
        GITHUB_TOKEN: 'github-token',
        GH_TOKEN: 'gh-token',
        SAFE_VALUE: 'visible',
      },
      ['CUSTOM_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'],
    )

    expect(environment).toEqual({ SAFE_VALUE: 'visible' })
    expect(JSON.stringify(environment)).not.toContain(secret)
  })

  it('never removes authentication sources required by Codex itself', (): void => {
    const environment = makeCodexEnvironment(
      {
        OPENAI_API_KEY: 'openai-key',
        CODEX_ACCESS_TOKEN: 'codex-access-token',
        CUSTOM_GITHUB_TOKEN: 'tracker-token',
      },
      ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CUSTOM_GITHUB_TOKEN'],
    )

    expect(environment).toEqual({
      OPENAI_API_KEY: 'openai-key',
      CODEX_ACCESS_TOKEN: 'codex-access-token',
    })
  })
})

describe('Codex session secret values', (): void => {
  /*
   * Read through the calling fiber's `ConfigProvider`, which is the host environment — deliberately
   * not the environment the subprocess is given, from which the tracker's own secret is stripped.
   */
  it.effect(
    'reads the tracker secret, the GitHub aliases, and Codex authentication from the host',
    () =>
      Effect.gen(function* () {
        const values = yield* withEnvironment(
          sessionSecretValues(['CUSTOM_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']),
          {
            CUSTOM_GITHUB_TOKEN: 'custom-tracker-secret',
            GITHUB_TOKEN: 'github-token',
            GH_TOKEN: 'gh-token',
            OPENAI_API_KEY: 'openai-key',
            CODEX_ACCESS_TOKEN: 'codex-access-token',
            SAFE_VALUE: 'visible',
          },
        )

        expect([...values].sort()).toEqual([
          'codex-access-token',
          'custom-tracker-secret',
          'gh-token',
          'github-token',
          'openai-key',
        ])
      }),
  )

  it.effect('skips a name the environment does not set', () =>
    Effect.gen(function* () {
      const values = yield* withEnvironment(sessionSecretValues(['CUSTOM_GITHUB_TOKEN']), {
        GITHUB_TOKEN: 'github-token',
      })

      expect(values).toEqual(['github-token'])
    }),
  )
})

describe('Codex event message redaction', (): void => {
  it('redacts quoted JSON and object-like credential fields', (): void => {
    expect(
      boundedMessage(String.raw`{"token":"secret","password":"two words",'api_key':'also-secret'}`),
    ).toBe(String.raw`{"token":"[REDACTED]","password":"[REDACTED]",'api_key':'[REDACTED]'}`)
  })

  it('redacts bare retained authentication values', (): void => {
    expect(
      boundedMessage('printed openai-secret and codex-secret', ['openai-secret', 'codex-secret']),
    ).toBe('printed [REDACTED] and [REDACTED]')
  })
})

describe('Codex protocol telemetry', (): void => {
  it('extracts the absolute total from thread token usage updates', (): void => {
    const telemetry = telemetryFrom('thread/tokenUsage/updated', {
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
          total: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
        },
      },
    })

    expect(telemetry).toEqual({
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      rateLimits: null,
    })
  })

  it('ignores response deltas and generic usage maps', (): void => {
    expect(
      telemetryFrom('rawResponse/completed', {
        params: { usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } },
      }),
    ).toEqual({ usage: null, rateLimits: null })
    expect(
      telemetryFrom('other/notification', {
        params: { usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } },
      }),
    ).toEqual({ usage: null, rateLimits: null })
  })

  it('extracts legacy cumulative totals and rate limits without using last-token deltas', (): void => {
    const telemetry = telemetryFrom('codex/event/token_count', {
      params: {
        msg: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 },
            last_token_usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 },
          },
          rate_limits: { primary: { used_percent: 25, window_minutes: 300 } },
        },
      },
    })

    expect(telemetry.usage).toEqual({ inputTokens: 90, outputTokens: 10, totalTokens: 100 })
    expect(telemetry.rateLimits).toEqual({
      primary: { used_percent: 25, window_minutes: 300 },
    })
  })

  it('tracks the targeted account rate-limit notification', (): void => {
    const telemetry = telemetryFrom('account/rateLimits/updated', {
      params: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 31, windowDurationMins: 15, resetsAt: 1_730_948_100 },
        },
      },
    })

    expect(telemetry.rateLimits).toEqual({
      limitId: 'codex',
      primary: { usedPercent: 31, windowDurationMins: 15, resetsAt: 1_730_948_100 },
    })
  })
})

const spawnCalls: string[] = []

vi.mock(
  'node:child_process',
  async (importOriginal): Promise<typeof import('node:child_process')> => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
      ...actual,
      spawn: ((...arguments_: Parameters<typeof actual.spawn>) => {
        spawnCalls.push(String(arguments_[0]))
        return actual.spawn(...arguments_)
      }) as typeof actual.spawn,
    }
  },
)

const roots: string[] = []

/** Lifts one of the host filesystem calls these containment fixtures need into the effect. */
const host = <Value>(work: () => Promise<Value>): Effect.Effect<Value> => Effect.promise(work)

const makeRoot = (): Effect.Effect<string> =>
  host(async () => {
    const root = await mkdtemp(join(tmpdir(), 'sloppenheimer-launch-'))
    roots.push(root)
    return root
  })

afterEach(async (): Promise<void> => {
  spawnCalls.length = 0
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const codexConfig = codexRunnerConfig({
  command: 'cat',
  turnTimeoutMs: 1_000,
  readTimeoutMs: 200,
  stallTimeoutMs: 0,
})

const launchIssue: Issue = anIssue({
  id: issueId('13'),
  identifier: issueIdentifier('example/sloppenheimer#13'),
  title: 'Revalidate containment',
})

const launchFor = (root: string, workspace: Workspace): AgentLaunch => ({
  issue: launchIssue,
  workspace,
  workspaceRoot: root,
  config: codexConfig,
  prompt: 'work',
  maxTurns: 1,
  secretEnvironmentNames: [],
  traceCapture: traceCaptureDisabled,
  refreshIssue: () => Effect.succeed(null),
  isRoutable: () => false,
  onEvent: () => undefined,
})

const workspaceAt = (path: string, key: string): Workspace => ({ path, key })

describe('workspace containment at the agent launch boundary', (): void => {
  it.live('rejects a workspace that is the configured root itself', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()

      const error = yield* Effect.flip(runAgent(launchFor(root, workspaceAt(root, '.'))))

      expect(error.category).toBe('workspace_rejected')
      expect(spawnCalls).toEqual([])
    }),
  )

  it.live('rejects a traversal path that climbs out of the root', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()

      const error = yield* Effect.flip(
        runAgent(launchFor(root, workspaceAt(join(root, '..', 'elsewhere'), 'x'))),
      )

      expect(error.category).toBe('workspace_rejected')
      expect(spawnCalls).toEqual([])
    }),
  )

  it.live('rejects an absolute path outside the root', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()

      const error = yield* Effect.flip(runAgent(launchFor(root, workspaceAt('/etc', 'etc'))))

      expect(error.category).toBe('workspace_rejected')
      expect(spawnCalls).toEqual([])
    }),
  )

  it.live('rejects a workspace directory that was replaced by a symbolic link', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const outside = yield* makeRoot()
      const path = join(root, 'issue-13')
      yield* host(() => symlink(outside, path, 'dir'))

      const error = yield* Effect.flip(runAgent(launchFor(root, workspaceAt(path, 'issue-13'))))

      expect(error.category).toBe('workspace_rejected')
      expect(error.message).toContain('symbolic link')
      expect(spawnCalls).toEqual([])
    }),
  )

  it.live('rejects a workspace path that was replaced by a file', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const path = join(root, 'issue-13')
      yield* host(() => writeFile(path, 'not a directory'))

      const error = yield* Effect.flip(runAgent(launchFor(root, workspaceAt(path, 'issue-13'))))

      expect(error.category).toBe('workspace_rejected')
      expect(error.message).toContain('not a directory')
      expect(spawnCalls).toEqual([])
    }),
  )

  it.live('rejects a stale workspace object whose directory is gone', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()

      const error = yield* Effect.flip(
        runAgent(launchFor(root, workspaceAt(join(root, 'removed'), 'removed'))),
      )

      expect(error.category).toBe('workspace_rejected')
      expect(error.message).toContain('not present')
      expect(spawnCalls).toEqual([])
    }),
  )

  it.live('rejects a workspace reached through a symlinked parent that escapes the root', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const outside = yield* makeRoot()
      yield* host(() => mkdir(join(outside, 'issue-13')))
      yield* host(() => symlink(outside, join(root, 'link'), 'dir'))

      const error = yield* Effect.flip(
        runAgent(launchFor(root, workspaceAt(join(root, 'link', 'issue-13'), 'issue-13'))),
      )

      expect(error.category).toBe('workspace_rejected')
      expect(error.message).toContain('escapes the configured root')
      expect(spawnCalls).toEqual([])
    }),
  )

  it.live('rejects a directory swapped for a symlink after verification', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const outside = yield* makeRoot()
      const path = join(root, 'issue-13')
      yield* host(() => mkdir(path))
      const verified = yield* verifyWorkspaceForLaunch(root, workspaceAt(path, 'issue-13'))

      // The directory is renamed away and the verified path repointed outside the root, exactly as a
      // process started by an earlier hook could do between verification and use.
      yield* host(() => rename(path, join(root, 'issue-13-moved')))
      yield* host(() => symlink(outside, path, 'dir'))
      const error = yield* Effect.flip(assertWorkspaceIdentity(root, verified))

      expect(error.category).toBe('invalid_path')
    }),
  )

  it.live('rejects a directory deleted and recreated at the same path', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const path = join(root, 'issue-13')
      yield* host(() => mkdir(path))

      // The held handle keeps the inode allocated, so the recreated directory cannot reuse it.
      const error = yield* Effect.flip(
        Effect.scoped(
          openVerifiedWorkspace(root, workspaceAt(path, 'issue-13')).pipe(
            Effect.tap(() =>
              Effect.promise(async () => {
                await rm(path, { recursive: true })
                await mkdir(path)
              }),
            ),
            Effect.flatMap((verified) => assertWorkspaceIdentity(root, verified)),
          ),
        ),
      )

      expect(error.category).toBe('invalid_path')
      expect(error.message).toContain('identity changed')
    }),
  )

  it.live('verifies and re-binds a workspace under a symlinked root', () =>
    Effect.gen(function* () {
      const target = yield* makeRoot()
      const linkedRoot = join(yield* makeRoot(), 'root-link')
      yield* host(() => symlink(target, linkedRoot, 'dir'))
      const path = join(linkedRoot, 'issue-13')
      yield* host(() => mkdir(path))

      const verified = yield* verifyWorkspaceForLaunch(linkedRoot, workspaceAt(path, 'issue-13'))

      expect(verified.rootPath).toBe(yield* host(() => realpath(target)))
      expect(yield* assertWorkspaceIdentity(linkedRoot, verified)).toBeUndefined()
    }),
  )

  it.live('rejects a configured root that is repointed after verification', () =>
    Effect.gen(function* () {
      const target = yield* makeRoot()
      const elsewhere = yield* makeRoot()
      const linkedRoot = join(yield* makeRoot(), 'root-link')
      yield* host(() => symlink(target, linkedRoot, 'dir'))
      const path = join(linkedRoot, 'issue-13')
      yield* host(() => mkdir(path))
      const verified = yield* verifyWorkspaceForLaunch(linkedRoot, workspaceAt(path, 'issue-13'))

      yield* host(() => rm(linkedRoot))
      yield* host(() => symlink(elsewhere, linkedRoot, 'dir'))
      const error = yield* Effect.flip(assertWorkspaceIdentity(linkedRoot, verified))

      expect(error.category).toBe('invalid_path')
      expect(error.message).toContain('root changed')
    }),
  )

  it.live('accepts an unchanged workspace at a later boundary', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const path = join(root, 'issue-13')
      yield* host(() => mkdir(path))
      const verified = yield* verifyWorkspaceForLaunch(root, workspaceAt(path, 'issue-13'))

      expect(yield* assertWorkspaceIdentity(root, verified)).toBeUndefined()
    }),
  )

  it.live('launches Codex in the verified real path for a contained workspace', () =>
    Effect.gen(function* () {
      const root = yield* makeRoot()
      const path = join(root, 'issue-13')
      yield* host(() => mkdir(path))

      const error = yield* Effect.flip(runAgent(launchFor(root, workspaceAt(path, 'issue-13'))))

      expect(error.category).not.toBe('workspace_rejected')
      expect(spawnCalls).toEqual(['bash'])
    }),
  )
})
