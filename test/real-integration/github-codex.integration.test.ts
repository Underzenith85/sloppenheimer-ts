import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect, Redacted } from 'effect'
import { describe, expect } from 'vitest'

import { runAgent, type AgentLaunch, type AgentResult } from '@symphony/adapter-codex/codex.js'
import type { AgentError } from '@symphony/core/domain/errors.js'
import { issueId, issueIdentifier, type Issue } from '@symphony/core/domain/domain.js'
import { makeGitHubTracker } from '@symphony/adapter-github/issues.js'
import { githubProviderDefaults } from '@symphony/adapter-github/provider.js'
import { hostFileSystem } from '../harness/filesystem.js'
import { codexRunnerConfig } from '../harness/codex-runner-config.js'

/** Launch verification reads the workspace through `FileSystem`; the host's is bound here. */
const runAgentOnHost = (launch: AgentLaunch): Effect.Effect<AgentResult, AgentError> =>
  runAgent(launch).pipe(Effect.provide(hostFileSystem))

const environment = process.env
const nonEmptyEnvironmentValue = (name: string): string | undefined => {
  const value = environment[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

const enabledInCi = environment['CI'] === 'true' && environment['SYMPHONY_REAL_INTEGRATION'] === '1'
const repository = nonEmptyEnvironmentValue('SYMPHONY_INTEGRATION_REPOSITORY')
const githubToken = nonEmptyEnvironmentValue('GITHUB_TOKEN')
const codexToken =
  nonEmptyEnvironmentValue('OPENAI_API_KEY') ?? nonEmptyEnvironmentValue('CODEX_ACCESS_TOKEN')
const githubMissing = [
  repository === undefined ? 'SYMPHONY_INTEGRATION_REPOSITORY' : null,
  githubToken === undefined ? 'GITHUB_TOKEN' : null,
].filter((name): name is string => name !== null)
const codexMissing = [
  codexToken === undefined ? 'OPENAI_API_KEY or CODEX_ACCESS_TOKEN' : null,
].filter((name): name is string => name !== null)

// `live`: both cases talk to real services on real timeouts.
const githubIntegration = githubMissing.length === 0 ? it.live : it.live.skip
const codexIntegration = codexMissing.length === 0 ? it.live : it.live.skip

describe('Real GitHub/Codex Integration Profile', (): void => {
  if (enabledInCi && githubMissing.length > 0) {
    it('has every GitHub credential required by the explicitly enabled CI profile', (): void => {
      expect(
        githubMissing,
        `missing GitHub integration credentials: ${githubMissing.join(', ')}`,
      ).toEqual([])
    })
  } else if (githubMissing.length > 0) {
    it.skip(`GitHub credentials unavailable: ${githubMissing.join(', ')}`, (): void => {})
  }

  if (enabledInCi && codexMissing.length > 0) {
    it('has every Codex credential required by the explicitly enabled CI profile', (): void => {
      expect(
        codexMissing,
        `missing Codex integration credentials: ${codexMissing.join(', ')}`,
      ).toEqual([])
    })
  } else if (codexMissing.length > 0) {
    it.skip(`Codex credentials unavailable: ${codexMissing.join(', ')}`, (): void => {})
  }

  githubIntegration('authenticates against the isolated GitHub repository scope', () =>
    Effect.gen(function* () {
      const selectedRepository = repository ?? ''
      const token = githubToken ?? ''
      const repositoryParts = selectedRepository.split('/')
      expect(repositoryParts).toHaveLength(2)
      const owner = repositoryParts[0] ?? ''
      const repositoryName = repositoryParts[1] ?? ''
      expect(owner.length).toBeGreaterThan(0)
      expect(repositoryName.length).toBeGreaterThan(0)
      const tracker = yield* makeGitHubTracker({
        owner,
        repository: repositoryName,
        token: Redacted.make(token),
        tokenEnvironmentName: 'GITHUB_TOKEN',
        apiBaseUrl: githubProviderDefaults.apiBaseUrl,
        baseBranch: githubProviderDefaults.baseBranch,
      })
      const issues = yield* tracker.fetchIssuesByStates(['open'], null, {
        hydrateDependencies: false,
      })
      expect(Array.isArray(issues)).toBe(true)
    }),
  )

  codexIntegration('runs Codex in a disposable isolated workspace and always cleans it', () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), 'symphony-real-integration-')),
      )
      const identifier = `real-integration-${process.pid}-${Date.now().toString(36)}`
      const workspacePath = join(workspaceRoot, identifier)
      yield* Effect.promise(() => mkdir(workspacePath))
      const issue: Issue = {
        id: issueId(identifier),
        nativeRef: null,
        identifier: issueIdentifier(identifier),
        title: 'Real integration smoke test',
        description: null,
        priority: null,
        state: 'open',
        branchName: null,
        url: null,
        assigneeId: null,
        labels: [],
        blockedBy: [],
        dispatchable: true,
        createdAt: null,
        updatedAt: null,
      }
      const config = codexRunnerConfig({
        command: environment['SYMPHONY_INTEGRATION_CODEX_COMMAND'] ?? 'codex app-server',
        turnTimeoutMs: 90_000,
        readTimeoutMs: 10_000,
        stallTimeoutMs: 30_000,
      })
      const result = yield* runAgentOnHost({
        issue,
        workspace: { path: workspacePath, key: identifier, createdNow: true },
        workspaceRoot,
        config,
        prompt: 'This is an integration smoke test. Reply briefly without changing files.',
        maxTurns: 1,
        secretEnvironmentNames: ['GITHUB_TOKEN', 'GH_TOKEN'],
        refreshIssue: () => Effect.succeed(null),
        isRoutable: () => false,
        onEvent: () => {},
      }).pipe(
        // The `finally` this replaces: the disposable workspace goes however the run ends.
        Effect.ensuring(Effect.promise(() => rm(workspaceRoot, { recursive: true, force: true }))),
      )

      expect(result.threadId.length).toBeGreaterThan(0)
      expect(result.turnId.length).toBeGreaterThan(0)
    }),
  )
})
