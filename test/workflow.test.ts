import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { issueId, issueIdentifier, type Issue } from '../src/domain.js'
import { JsonConversionError, toJsonValue } from '../src/json.js'
import { loadWorkflow, preflightWorkflow, renderPrompt, workflowDefaults } from '../src/workflow.js'

const temporaryDirectories: string[] = []

const makeTemporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'symphony-workflow-test-'))
  temporaryDirectories.push(path)
  return path
}

const issue: Issue = {
  id: issueId('42'),
  nativeRef: { number: 42 },
  identifier: issueIdentifier('GH-42'),
  title: 'Keep types exact',
  description: 'Use the type system',
  priority: 1,
  state: 'open',
  branchName: null,
  url: 'https://example.test/issues/42',
  assigneeId: null,
  labels: ['symphony'],
  blockedBy: [],
  dispatchable: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: null,
}

afterEach(async (): Promise<void> => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('workflow loading', (): void => {
  it('resolves strict configuration and renders issue data', async (): Promise<void> => {
    const directory = await makeTemporaryDirectory()
    const path = join(directory, 'WORKFLOW.md')
    await writeFile(
      path,
      `---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TEST_TRACKER_TOKEN
  required_labels: [Symphony]
workspace:
  root: .workspaces
agent:
  max_concurrent_agents: 2
---
Work on {{ issue.identifier }}: {{ issue.title }} (attempt {{ attempt }})
`,
    )

    const workflow = await Effect.runPromise(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' }))
    const prompt = await Effect.runPromise(renderPrompt(workflow, issue, 3))

    expect(workflow.config.tracker.provider).toEqual({
      owner: 'example',
      repository: 'symphony',
      token: '$TEST_TRACKER_TOKEN',
    })
    expect(workflow.tracker.provider.token).toBe('secret')
    expect(workflow.tracker.provider.tokenEnvironmentName).toBe('TEST_TRACKER_TOKEN')
    expect(workflow.config.tracker.requiredLabels).toEqual(['symphony'])
    expect(workflow.tracker.provider.baseBranch).toBe('main')
    expect(workflow.config.workspaceRoot).toBe(join(directory, '.workspaces'))
    expect(workflow.config.agent.maxConcurrentAgents).toBe(2)
    expect(workflow.config.codex.threadSandbox).toBe('workspace-write')
    expect(prompt).toBe('Work on GH-42: Keep types exact (attempt 3)')
  })

  it('rejects a missing environment indirection', async (): Promise<void> => {
    const directory = await makeTemporaryDirectory()
    const path = join(directory, 'WORKFLOW.md')
    await writeFile(
      path,
      `---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $MISSING_TRACKER_TOKEN
---
Do the work
`,
    )

    const error = await Effect.runPromise(Effect.flip(loadWorkflow(path, {})))

    expect(error.category).toBe('invalid_config')
  })

  it('accepts port zero for an ephemeral operator server', async (): Promise<void> => {
    const directory = await makeTemporaryDirectory()
    const path = join(directory, 'WORKFLOW.md')
    await writeFile(
      path,
      `---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TEST_TRACKER_TOKEN
server:
  port: 0
---
Do the work
`,
    )

    const workflow = await Effect.runPromise(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' }))

    expect(workflow.config.serverPort).toBe(0)
  })

  it('rejects literal tracker credentials without exposing them in the error', async (): Promise<void> => {
    const directory = await makeTemporaryDirectory()
    const path = join(directory, 'WORKFLOW.md')
    const literal = 'github_pat_plaintext_secret'
    await writeFile(
      path,
      `---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: ${literal}
---
Do the work
`,
    )

    const error = await Effect.runPromise(Effect.flip(loadWorkflow(path, {})))

    expect(error.category).toBe('invalid_config')
    expect(error.message).toContain('literal credentials are not allowed')
    expect(error.message).not.toContain(literal)
    expect(String(error)).not.toContain(literal)
  })

  it.each(['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'])(
    'rejects tracker reuse of Codex credential source %s without exposing its value',
    async (environmentName): Promise<void> => {
      const directory = await makeTemporaryDirectory()
      const path = join(directory, 'WORKFLOW.md')
      const secret = `secret-for-${environmentName}`
      await writeFile(
        path,
        `---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $${environmentName}
---
Do the work
`,
      )

      const error = await Effect.runPromise(
        Effect.flip(loadWorkflow(path, { [environmentName]: secret })),
      )

      expect(error.category).toBe('invalid_config')
      expect(error.message).toContain(environmentName)
      expect(error.message).not.toContain(secret)
      expect(String(error)).not.toContain(secret)
    },
  )
})

const minimalTracker = `tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TEST_TRACKER_TOKEN`

const writeWorkflow = async (frontMatter: string): Promise<string> => {
  const directory = await makeTemporaryDirectory()
  const path = join(directory, 'WORKFLOW.md')
  await writeFile(path, `---\n${frontMatter}\n---\nDo the work\n`)
  return path
}

describe('workflow defaults and extension keys', (): void => {
  it('applies every documented default when optional sections are omitted', async (): Promise<void> => {
    const path = await writeWorkflow(minimalTracker)

    const workflow = await Effect.runPromise(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' }))

    expect(workflow.config.pollingIntervalMs).toBe(workflowDefaults.pollingIntervalMs)
    expect(workflow.config.workspaceRoot).toBe(
      join(tmpdir(), workflowDefaults.workspaceRootBasename),
    )
    expect(workflow.config.hooks).toEqual({
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: workflowDefaults.hookTimeoutMs,
    })
    expect(workflow.config.agent.maxConcurrentAgents).toBe(workflowDefaults.maxConcurrentAgents)
    expect(workflow.config.agent.maxTurns).toBe(workflowDefaults.maxTurns)
    expect(workflow.config.agent.maxRetryBackoffMs).toBe(workflowDefaults.maxRetryBackoffMs)
    expect(workflow.config.codex).toEqual({
      command: workflowDefaults.codexCommand,
      approvalPolicy: workflowDefaults.approvalPolicy,
      threadSandbox: workflowDefaults.threadSandbox,
      turnSandboxPolicy: null,
      turnTimeoutMs: workflowDefaults.turnTimeoutMs,
      readTimeoutMs: workflowDefaults.readTimeoutMs,
      stallTimeoutMs: workflowDefaults.stallTimeoutMs,
    })
    expect(workflow.config.tracker.activeStates).toEqual(['open'])
    expect(workflow.config.tracker.terminalStates).toEqual(['closed'])
    expect(workflow.config.tracker.requiredLabels).toEqual([])
    expect(workflow.config.serverPort).toBeNull()
    expect(workflow.tracker.provider.apiBaseUrl).toBe('https://api.github.com')
  })

  it('preserves unknown front-matter keys while still enforcing required fields', async (): Promise<void> => {
    const path = await writeWorkflow(`${minimalTracker}
workers:
  pool: [alpha, beta]
  budget: 3
experimental: true`)

    const workflow = await Effect.runPromise(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' }))

    expect(workflow.config.extensions).toEqual({
      workers: { pool: ['alpha', 'beta'], budget: 3 },
      experimental: true,
    })
  })

  it('keeps required-field validation with unknown keys present', async (): Promise<void> => {
    const path = await writeWorkflow(`tracker:
  kind: github
  provider:
    repository: symphony
    token: $TEST_TRACKER_TOKEN
future_section:
  anything: 1`)

    const error = await Effect.runPromise(
      Effect.flip(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' })),
    )

    expect(error.category).toBe('invalid_config')
    expect(error.message).toContain('tracker.provider.owner')
  })

  it('keeps tracker.provider as the exact authored object', async (): Promise<void> => {
    const path = await writeWorkflow(`tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TEST_TRACKER_TOKEN
    adapter_specific:
      nested: [1, 2]`)

    const workflow = await Effect.runPromise(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' }))

    expect(workflow.config.tracker.provider).toEqual({
      owner: 'example',
      repository: 'symphony',
      token: '$TEST_TRACKER_TOKEN',
      adapter_specific: { nested: [1, 2] },
    })
    expect(Object.isFrozen(workflow.config.tracker.provider)).toBe(true)
  })
})

describe('declared secret and path indirection', (): void => {
  it('expands a leading ~ in the declared workspace path field', async (): Promise<void> => {
    const path = await writeWorkflow(`${minimalTracker}
workspace:
  root: ~/symphony-root`)

    const workflow = await Effect.runPromise(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' }))

    expect(workflow.config.workspaceRoot).toBe(join(homedir(), 'symphony-root'))
  })

  it('resolves $VAR in the declared workspace path field', async (): Promise<void> => {
    const path = await writeWorkflow(`${minimalTracker}
workspace:
  root: $TEST_WORKSPACE_ROOT`)

    const workflow = await Effect.runPromise(
      loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret', TEST_WORKSPACE_ROOT: '/srv/symphony' }),
    )

    expect(workflow.config.workspaceRoot).toBe('/srv/symphony')
  })

  it('never expands $VAR in fields that are not declared secrets or paths', async (): Promise<void> => {
    const path = await writeWorkflow(`${minimalTracker}
hooks:
  before_run: echo $HOME
codex:
  command: $CODEX_COMMAND`)

    const workflow = await Effect.runPromise(
      loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret', CODEX_COMMAND: 'not-substituted' }),
    )

    expect(workflow.config.codex.command).toBe('$CODEX_COMMAND')
    expect(workflow.config.hooks.beforeRun).toBe('echo $HOME')
  })
})

describe('adapter-owned validation', (): void => {
  it('rejects an unsupported tracker kind', async (): Promise<void> => {
    const path = await writeWorkflow(`tracker:
  kind: linear
  provider:
    api_key: $TEST_TRACKER_TOKEN`)

    const error = await Effect.runPromise(
      Effect.flip(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' })),
    )

    expect(error.category).toBe('invalid_config')
    expect(error.message).toContain('unsupported tracker.kind: linear')
  })

  it('rejects a non-absolute adapter API base URL', async (): Promise<void> => {
    const path = await writeWorkflow(`tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TEST_TRACKER_TOKEN
    api_base_url: /repos`)

    const error = await Effect.runPromise(
      Effect.flip(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' })),
    )

    expect(error.category).toBe('invalid_config')
    expect(error.message).toContain('tracker.provider.api_base_url')
  })

  it('trims a trailing slash from the adapter API base URL', async (): Promise<void> => {
    const path = await writeWorkflow(`tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TEST_TRACKER_TOKEN
    api_base_url: https://github.example.test/api/v3/`)

    const workflow = await Effect.runPromise(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' }))

    expect(workflow.tracker.provider.apiBaseUrl).toBe('https://github.example.test/api/v3')
  })

  it.each([
    ['polling:\n  interval_ms: 0', 'polling.interval_ms'],
    ['codex:\n  approval_policy: on-failure', 'codex.approval_policy'],
    ['codex:\n  approval_policy: sometimes', 'codex.approval_policy'],
    ['codex:\n  thread_sandbox: everything', 'codex.thread_sandbox'],
    ['codex:\n  stall_timeout_ms: -1', 'codex.stall_timeout_ms'],
    ['server:\n  port: 70000', 'server.port'],
  ])('rejects invalid value in %s', async (section, expected): Promise<void> => {
    const path = await writeWorkflow(`${minimalTracker}\n${section}`)

    const error = await Effect.runPromise(
      Effect.flip(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' })),
    )

    expect(error.category).toBe('invalid_config')
    expect(error.message).toContain(expected)
  })

  it('passes codex.turn_sandbox_policy through verbatim', async (): Promise<void> => {
    const path = await writeWorkflow(`${minimalTracker}
codex:
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots: [/srv/work]
    networkAccess: false`)

    const workflow = await Effect.runPromise(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' }))

    expect(workflow.config.codex.turnSandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/srv/work'],
      networkAccess: false,
    })
  })

  it('revalidates the adapter secret on every dispatch preflight', async (): Promise<void> => {
    const path = await writeWorkflow(minimalTracker)
    const workflow = await Effect.runPromise(loadWorkflow(path, { TEST_TRACKER_TOKEN: 'secret' }))

    const validated = await Effect.runPromise(
      preflightWorkflow(workflow, { TEST_TRACKER_TOKEN: 'rotated' }),
    )
    const error = await Effect.runPromise(Effect.flip(preflightWorkflow(workflow, {})))

    expect(validated.provider.token).toBe('rotated')
    expect(error.category).toBe('invalid_config')
    expect(error.message).toContain('missing environment variable')
  })
})

describe('JSON-safe adapter configuration', (): void => {
  it('rejects values that cannot round-trip through JSON', (): void => {
    expect(() => toJsonValue({ when: new Date() }, 'tracker.provider')).toThrow(JsonConversionError)
    expect(() => toJsonValue({ ratio: Number.POSITIVE_INFINITY }, 'tracker.provider')).toThrow(
      JsonConversionError,
    )
  })

  it('deeply freezes converted configuration', (): void => {
    const value = toJsonValue({ nested: { list: [1] } }, 'tracker.provider')

    expect(Object.isFrozen(value)).toBe(true)
  })
})
