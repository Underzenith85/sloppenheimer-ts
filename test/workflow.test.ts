import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { issueId, issueIdentifier, type Issue } from '../src/domain.js'
import { loadWorkflow, renderPrompt } from '../src/workflow.js'

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
  it('applies every documented core and GitHub adapter default', async (): Promise<void> => {
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
---
Do the work
`,
    )

    const workflow = await Effect.runPromise(loadWorkflow(path, { GITHUB_TOKEN: 'fallback' }))

    expect(workflow.config.tracker.provider).toEqual({
      owner: 'example',
      repository: 'symphony',
    })
    expect(workflow.config.tracker.requiredLabels).toEqual([])
    expect(workflow.config.tracker.activeStates).toEqual(['open'])
    expect(workflow.config.tracker.terminalStates).toEqual(['closed'])
    expect(workflow.config.pollingIntervalMs).toBe(30_000)
    expect(workflow.config.workspaceRoot).toBe(join(tmpdir(), 'symphony_workspaces'))
    expect(workflow.config.hooks).toEqual({
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    })
    expect(workflow.config.agent.maxConcurrentAgents).toBe(10)
    expect(workflow.config.agent.maxTurns).toBe(20)
    expect(workflow.config.agent.maxRetryBackoffMs).toBe(300_000)
    expect(workflow.config.agent.maxConcurrentAgentsByState).toEqual(new Map())
    expect(workflow.config.codex).toEqual({
      command: 'codex app-server',
      approvalPolicy: 'never',
      threadSandbox: 'workspace-write',
      turnSandboxPolicy: null,
      turnTimeoutMs: 3_600_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 300_000,
    })
    expect(workflow.config.serverPort).toBeNull()
  })

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

    expect(workflow.config.tracker.provider['token']).toBe('$TEST_TRACKER_TOKEN')
    expect(workflow.config.tracker.requiredLabels).toEqual(['symphony'])
    expect(workflow.config.tracker.provider['base_branch']).toBeUndefined()
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

  it('preserves JSON-safe provider and front-matter extension keys exactly', async (): Promise<void> => {
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
    token: $TRACKER_TOKEN
    adapter_extension:
      enabled: true
      weights: [1, 2, null]
future_extension:
  nested: [alpha, {flag: false}]
---
Do the work
`,
    )

    const workflow = await Effect.runPromise(loadWorkflow(path, { TRACKER_TOKEN: 'secret' }))

    expect(workflow.config.tracker.provider).toEqual({
      owner: 'example',
      repository: 'symphony',
      token: '$TRACKER_TOKEN',
      adapter_extension: { enabled: true, weights: [1, 2, null] },
    })
    expect(workflow.frontMatter['future_extension']).toEqual({
      nested: ['alpha', { flag: false }],
    })
  })

  it('resolves environment and home expansion only for the declared workspace path', async (): Promise<void> => {
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
    token: $TRACKER_TOKEN
workspace:
  root: $WORKSPACE_PATH
hooks:
  before_run: $HOOK_COMMAND
codex:
  command: $CODEX_COMMAND
---
Do the work
`,
    )

    const workflow = await Effect.runPromise(
      loadWorkflow(path, {
        TRACKER_TOKEN: 'secret',
        WORKSPACE_PATH: '~/adapter-conformance',
        HOOK_COMMAND: 'must not replace',
        CODEX_COMMAND: 'must not replace',
      }),
    )

    expect(workflow.config.workspaceRoot).toBe(join(homedir(), 'adapter-conformance'))
    expect(workflow.config.hooks.beforeRun).toBe('$HOOK_COMMAND')
    expect(workflow.config.codex.command).toBe('$CODEX_COMMAND')
    expect(workflow.config.tracker.provider['token']).toBe('$TRACKER_TOKEN')
  })

  it('passes a generated-schema-shaped turn sandbox policy through unchanged', async (): Promise<void> => {
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
codex:
  approval_policy:
    granular:
      mcp_elicitations: false
      rules: true
      sandbox_approval: false
  thread_sandbox: read-only
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots: [/tmp/one]
    networkAccess: false
    futureCodexField: preserved
---
Do the work
`,
    )

    const workflow = await Effect.runPromise(loadWorkflow(path, { GH_TOKEN: 'fallback' }))

    expect(workflow.config.codex.approvalPolicy).toEqual({
      granular: { mcp_elicitations: false, rules: true, sandbox_approval: false },
    })
    expect(workflow.config.codex.threadSandbox).toBe('read-only')
    expect(workflow.config.codex.turnSandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/tmp/one'],
      networkAccess: false,
      futureCodexField: 'preserved',
    })
  })

  it.each([
    ['unsupported tracker kind', 'linear', 'codex app-server', 'unsupported tracker.kind'],
    ['blank Codex command', 'github', '   ', 'codex.command must be a non-empty string'],
  ])(
    'rejects %s during dispatch preflight',
    async (_name, kind, command, message): Promise<void> => {
      const directory = await makeTemporaryDirectory()
      const path = join(directory, 'WORKFLOW.md')
      await writeFile(
        path,
        `---
tracker:
  kind: ${kind}
  provider:
    owner: example
    repository: symphony
codex:
  command: "${command}"
---
Do the work
`,
      )

      const error = await Effect.runPromise(
        Effect.flip(loadWorkflow(path, { GITHUB_TOKEN: 'fallback' })),
      )

      expect(error.category).toBe('invalid_config')
      expect(error.message).toContain(message)
    },
  )

  it.each([
    ['polling.interval_ms', 'polling:\n  interval_ms: 0'],
    ['hooks.timeout_ms', 'hooks:\n  timeout_ms: -1'],
    ['agent.max_turns', 'agent:\n  max_turns: 0'],
    ['server.port', 'server:\n  port: 65536'],
    ['codex.thread_sandbox', 'codex:\n  thread_sandbox: container'],
    [
      'codex.turn_sandbox_policy',
      'codex:\n  turn_sandbox_policy:\n    type: workspaceWrite\n    networkAccess: enabled',
    ],
  ])('rejects invalid %s', async (name, invalidYaml): Promise<void> => {
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
${invalidYaml}
---
Do the work
`,
    )

    const error = await Effect.runPromise(
      Effect.flip(loadWorkflow(path, { GITHUB_TOKEN: 'fallback' })),
    )

    expect(error.category).toBe('invalid_config')
    expect(error.message).toContain(name)
  })

  it('rejects non-JSON-safe extension values', async (): Promise<void> => {
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
extension: .nan
---
Do the work
`,
    )

    const error = await Effect.runPromise(
      Effect.flip(loadWorkflow(path, { GITHUB_TOKEN: 'fallback' })),
    )

    expect(error.message).toContain('JSON-safe')
  })
})
