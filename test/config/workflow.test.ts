import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect, Redacted } from 'effect'

import { trackerProviders } from '../../src/tracker-adapters.js'
import { afterEach, describe, expect } from 'vitest'

import { githubProviderOf } from '../../src/adapters/github/index.js'
import { issueId, issueIdentifier, type Issue } from '../../src/domain/domain.js'
import { sameTrackerProvider } from '../../src/domain/tracker-provider.js'
import type { WorkflowError } from '../../src/errors.js'
import type { TrackerProviderRegistry } from '../../src/domain/tracker-provider.js'
import { withEnvironment } from '../harness/environment.js'
import { hostFileSystem } from '../harness/filesystem.js'
import { stubProviderToken, stubTrackerProviders } from '../harness/stub-tracker-provider.js'
import { JsonConversionError, toJsonValue } from '../../src/support/json.js'
import {
  loadWorkflow,
  preflightWorkflow,
  renderPrompt,
  workflowDefaults,
  type Workflow,
} from '../../src/config/workflow.js'

/**
 * `loadWorkflow` reads its source through `FileSystem`; every test here reads the real files it
 * wrote, so the host filesystem is bound exactly as the composition root binds it.
 */
const loadHostWorkflow = (
  path: string,
  providers: TrackerProviderRegistry,
): Effect.Effect<Workflow, WorkflowError> =>
  loadWorkflow(path, providers).pipe(Effect.provide(hostFileSystem))

const temporaryDirectories: string[] = []

const makeTemporaryDirectory = (): Effect.Effect<string> =>
  Effect.promise(async () => {
    const path = await mkdtemp(join(tmpdir(), 'symphony-workflow-test-'))
    temporaryDirectories.push(path)
    return path
  })

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
  it.effect('resolves strict configuration and renders issue data', () =>
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory()
      const path = join(directory, 'WORKFLOW.md')
      yield* Effect.promise(() =>
        writeFile(
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
        ),
      )

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })
      const prompt = yield* renderPrompt(workflow, issue, 3)

      expect(workflow.config.tracker.provider).toEqual({
        owner: 'example',
        repository: 'symphony',
        token: '$TEST_TRACKER_TOKEN',
      })
      expect(Redacted.value(githubProviderOf(workflow.tracker).token)).toBe('secret')
      expect(githubProviderOf(workflow.tracker).tokenEnvironmentName).toBe('TEST_TRACKER_TOKEN')
      expect(workflow.config.tracker.requiredLabels).toEqual(['symphony'])
      expect(githubProviderOf(workflow.tracker).baseBranch).toBe('main')
      expect(workflow.config.workspaceRoot).toBe(join(directory, '.workspaces'))
      expect(workflow.config.agent.maxConcurrentAgents).toBe(2)
      expect(workflow.config.codex.threadSandbox).toBe('workspace-write')
      expect(prompt).toBe('Work on GH-42: Keep types exact (attempt 3)')
    }),
  )

  it.effect('rejects an environment indirection that resolves to an empty value', () =>
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory()
      const path = join(directory, 'WORKFLOW.md')
      yield* Effect.promise(() =>
        writeFile(
          path,
          `---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $EMPTY_TRACKER_TOKEN
---
Do the work
`,
        ),
      )

      const error = yield* Effect.flip(
        withEnvironment(loadHostWorkflow(path, trackerProviders), { EMPTY_TRACKER_TOKEN: '' }),
      )

      expect(error.category).toBe('invalid_config')
      expect(error.message).toContain('missing environment variable')
    }),
  )

  /*
   * `Config.redacted` is what keeps the resolved credential out of anything that prints the
   * provider it belongs to; the value itself is reachable only by asking for it explicitly.
   */
  it.effect('keeps the resolved credential out of a serialized provider', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(minimalTracker)
      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret-value',
      })

      const provider = githubProviderOf(workflow.tracker)

      expect(JSON.stringify(provider)).not.toContain('secret-value')
      expect(JSON.stringify(provider.token)).toBe('"<redacted>"')
      expect(Redacted.value(provider.token)).toBe('secret-value')
    }),
  )

  it.effect('rejects a missing environment indirection', () =>
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory()
      const path = join(directory, 'WORKFLOW.md')
      yield* Effect.promise(() =>
        writeFile(
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
        ),
      )

      const error = yield* Effect.flip(withEnvironment(loadHostWorkflow(path, trackerProviders)))

      expect(error.category).toBe('invalid_config')
    }),
  )

  it.effect('accepts port zero for an ephemeral operator server', () =>
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory()
      const path = join(directory, 'WORKFLOW.md')
      yield* Effect.promise(() =>
        writeFile(
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
        ),
      )

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })

      expect(workflow.config.serverPort).toBe(0)
    }),
  )

  it.effect('rejects literal tracker credentials without exposing them in the error', () =>
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory()
      const path = join(directory, 'WORKFLOW.md')
      const literal = 'github_pat_plaintext_secret'
      yield* Effect.promise(() =>
        writeFile(
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
        ),
      )

      const error = yield* Effect.flip(withEnvironment(loadHostWorkflow(path, trackerProviders)))

      expect(error.category).toBe('invalid_config')
      expect(error.message).toContain('literal credentials are not allowed')
      expect(error.message).not.toContain(literal)
      expect(String(error)).not.toContain(literal)
    }),
  )

  it.effect.each(['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'] as const)(
    'rejects tracker reuse of Codex credential source %s without exposing its value',
    (environmentName) =>
      Effect.gen(function* () {
        const directory = yield* makeTemporaryDirectory()
        const path = join(directory, 'WORKFLOW.md')
        const secret = `secret-for-${environmentName}`
        yield* Effect.promise(() =>
          writeFile(
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
          ),
        )

        const error = yield* Effect.flip(
          withEnvironment(loadHostWorkflow(path, trackerProviders), { [environmentName]: secret }),
        )

        expect(error.category).toBe('invalid_config')
        expect(error.message).toContain(environmentName)
        expect(error.message).not.toContain(secret)
        expect(String(error)).not.toContain(secret)
      }),
  )
})

const minimalTracker = `tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TEST_TRACKER_TOKEN`

const writeWorkflow = (frontMatter: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const directory = yield* makeTemporaryDirectory()
    const path = join(directory, 'WORKFLOW.md')
    yield* Effect.promise(() => writeFile(path, `---\n${frontMatter}\n---\nDo the work\n`))
    return path
  })

describe('workflow defaults and extension keys', (): void => {
  it.effect('applies every documented default when optional sections are omitted', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(minimalTracker)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })

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
      expect(githubProviderOf(workflow.tracker).apiBaseUrl).toBe('https://api.github.com')
    }),
  )

  it.effect('preserves unknown front-matter keys while still enforcing required fields', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`${minimalTracker}
workers:
  pool: [alpha, beta]
  budget: 3
experimental: true`)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })

      expect(workflow.config.extensions).toEqual({
        workers: { pool: ['alpha', 'beta'], budget: 3 },
        experimental: true,
      })
    }),
  )

  it.effect('keeps required-field validation with unknown keys present', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`tracker:
  kind: github
  provider:
    repository: symphony
    token: $TEST_TRACKER_TOKEN
future_section:
  anything: 1`)

      const error = yield* Effect.flip(
        withEnvironment(loadHostWorkflow(path, trackerProviders), { TEST_TRACKER_TOKEN: 'secret' }),
      )

      expect(error.category).toBe('invalid_config')
      expect(error.message).toContain('tracker.provider.owner')
    }),
  )

  it.effect('keeps tracker.provider as the exact authored object', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TEST_TRACKER_TOKEN
    adapter_specific:
      nested: [1, 2]`)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })

      expect(workflow.config.tracker.provider).toEqual({
        owner: 'example',
        repository: 'symphony',
        token: '$TEST_TRACKER_TOKEN',
        adapter_specific: { nested: [1, 2] },
      })
      expect(Object.isFrozen(workflow.config.tracker.provider)).toBe(true)
    }),
  )
})

describe('declared secret and path indirection', (): void => {
  it.effect('expands a leading ~ in the declared workspace path field', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`${minimalTracker}
workspace:
  root: ~/symphony-root`)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })

      expect(workflow.config.workspaceRoot).toBe(join(homedir(), 'symphony-root'))
    }),
  )

  it.effect('resolves $VAR in the declared workspace path field', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`${minimalTracker}
workspace:
  root: $TEST_WORKSPACE_ROOT`)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
        TEST_WORKSPACE_ROOT: '/srv/symphony',
      })

      expect(workflow.config.workspaceRoot).toBe('/srv/symphony')
    }),
  )

  it.effect('never expands $VAR in fields that are not declared secrets or paths', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`${minimalTracker}
hooks:
  before_run: echo $HOME
codex:
  command: $CODEX_COMMAND`)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
        CODEX_COMMAND: 'not-substituted',
      })

      expect(workflow.config.codex.command).toBe('$CODEX_COMMAND')
      expect(workflow.config.hooks.beforeRun).toBe('echo $HOME')
    }),
  )
})

/*
 * The message a rejected document produces is the contract this loader has with whoever authored
 * it, so each one is pinned here rather than asserted by substring. Every message below is the one
 * the imperative decoders produced before the front matter was declared as a schema; the two
 * JSON-safety messages for extension keys are the deliberate exception, and are noted where they
 * appear.
 */
describe('front-matter decoding messages', (): void => {
  const rejects = (frontMatter: string): Effect.Effect<string, Workflow> =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(frontMatter)
      const error = yield* Effect.flip(
        withEnvironment(loadHostWorkflow(path, trackerProviders), { TEST_TRACKER_TOKEN: 'secret' }),
      )
      expect(error.category).toBe('invalid_config')
      return error.message
    })

  it.effect.each([
    ['polling:\n  interval_ms: 10', 'tracker must be a map'],
    ['tracker: 5', 'tracker must be a map'],
    ['tracker:\n  - a', 'tracker must be a map'],
    ['tracker: {}', 'tracker.kind must be a non-empty string'],
    ['tracker:\n  kind: 5\n  provider:\n    a: 1', 'tracker.kind must be a non-empty string'],
    ['tracker:\n  kind: ""\n  provider:\n    a: 1', 'tracker.kind must be a non-empty string'],
    ['tracker:\n  kind: github', 'tracker.provider must be a map'],
    ['tracker:\n  kind: github\n  provider: nope', 'tracker.provider must be a map'],
    ['tracker:\n  kind: github\n  provider: [1]', 'tracker.provider must be a map'],
    [
      'tracker:\n  kind: github\n  provider:\n    ratio: .inf',
      'tracker.provider.ratio must be a JSON-safe value',
    ],
    [
      `${minimalTracker}\n  required_labels: nope`,
      'tracker.required_labels must be a list of strings',
    ],
    [
      `${minimalTracker}\n  required_labels: [ok, 5]`,
      'tracker.required_labels must be a list of strings',
    ],
    [`${minimalTracker}\n  active_states: 5`, 'tracker.active_states must be a list of strings'],
    [
      `${minimalTracker}\n  terminal_states: 5`,
      'tracker.terminal_states must be a list of strings',
    ],
    [`${minimalTracker}\npolling: 5`, 'polling must be a map'],
    [`${minimalTracker}\npolling:`, 'polling must be a map'],
    [`${minimalTracker}\npolling:\n  interval_ms: nope`, 'polling.interval_ms must be an integer'],
    [`${minimalTracker}\npolling:\n  interval_ms: 1.5`, 'polling.interval_ms must be an integer'],
    [
      `${minimalTracker}\npolling:\n  interval_ms: 0`,
      'polling.interval_ms must be a positive integer',
    ],
    [
      `${minimalTracker}\npolling:\n  interval_ms: -3`,
      'polling.interval_ms must be a positive integer',
    ],
    [`${minimalTracker}\nworkspace:\n  root: ""`, 'workspace.root must be a non-empty string'],
    [`${minimalTracker}\nworkspace:\n  root: 5`, 'workspace.root must be a non-empty string'],
    [`${minimalTracker}\nhooks: 5`, 'hooks must be a map'],
    [`${minimalTracker}\nhooks:\n  before_run: 5`, 'hooks.before_run must be a non-empty string'],
    [`${minimalTracker}\nhooks:\n  after_run: ""`, 'hooks.after_run must be a non-empty string'],
    [`${minimalTracker}\nhooks:\n  timeout_ms: 0`, 'hooks.timeout_ms must be a positive integer'],
    [`${minimalTracker}\nagent: 5`, 'agent must be a map'],
    [
      `${minimalTracker}\nagent:\n  max_concurrent_agents: 0`,
      'agent.max_concurrent_agents must be a positive integer',
    ],
    [`${minimalTracker}\nagent:\n  max_turns: nope`, 'agent.max_turns must be an integer'],
    [
      `${minimalTracker}\nagent:\n  max_retry_backoff_ms: -1`,
      'agent.max_retry_backoff_ms must be a positive integer',
    ],
    [
      `${minimalTracker}\nagent:\n  max_concurrent_agents_by_state: 5`,
      'agent.max_concurrent_agents_by_state must be a map',
    ],
    [`${minimalTracker}\ncodex: 5`, 'codex must be a map'],
    [`${minimalTracker}\ncodex:\n  command: ""`, 'codex.command must be a non-empty string'],
    [`${minimalTracker}\ncodex:\n  command: "   "`, 'codex.command must be a non-empty string'],
    [`${minimalTracker}\ncodex:\n  command: 5`, 'codex.command must be a non-empty string'],
    [
      `${minimalTracker}\ncodex:\n  approval_policy: 5`,
      'codex.approval_policy must be a non-empty string',
    ],
    [
      `${minimalTracker}\ncodex:\n  approval_policy: sometimes`,
      'codex.approval_policy must be one of: untrusted, on-request, never',
    ],
    [
      `${minimalTracker}\ncodex:\n  thread_sandbox: everything`,
      'codex.thread_sandbox must be one of: read-only, workspace-write, danger-full-access',
    ],
    [
      `${minimalTracker}\ncodex:\n  turn_sandbox_policy: 5`,
      'codex.turn_sandbox_policy must be a map',
    ],
    [
      `${minimalTracker}\ncodex:\n  turn_sandbox_policy:\n    ratio: .inf`,
      'codex.turn_sandbox_policy.ratio must be a JSON-safe value',
    ],
    [
      `${minimalTracker}\ncodex:\n  turn_timeout_ms: 0`,
      'codex.turn_timeout_ms must be a positive integer',
    ],
    [
      `${minimalTracker}\ncodex:\n  read_timeout_ms: nope`,
      'codex.read_timeout_ms must be an integer',
    ],
    [
      `${minimalTracker}\ncodex:\n  stall_timeout_ms: -1`,
      'codex.stall_timeout_ms must not be negative',
    ],
    [`${minimalTracker}\nserver: 5`, 'server must be a map'],
    [`${minimalTracker}\nserver:\n  port: 70000`, 'server.port must be between 0 and 65535'],
    [`${minimalTracker}\nserver:\n  port: -1`, 'server.port must be between 0 and 65535'],
    // An extension key is passed through rather than decoded, so the only thing it can be wrong
    // about is carrying a value JSON cannot. This message replaces the "failed to load workflow"
    // the imperative path reported, and matches how tracker.provider already reports the same.
    [`${minimalTracker}\nextra: .inf`, 'extra must be a JSON-safe value'],
    [`${minimalTracker}\nextra:\n  ratio: .inf`, 'extra.ratio must be a JSON-safe value'],
  ] as const)('rejects %s', ([frontMatter, expected]) =>
    Effect.gen(function* () {
      expect(yield* rejects(frontMatter)).toBe(expected)
    }),
  )

  it.effect('reports the section before the field when both are wrong', () =>
    Effect.gen(function* () {
      // Sections are read in the order the document declares them, so the first failure a reader is
      // told about is the first one they wrote.
      expect(yield* rejects(`${minimalTracker}\npolling: 5\nserver:\n  port: 70000`)).toBe(
        'polling must be a map',
      )
    }),
  )

  it.effect('keeps every value a valid document declared', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`${minimalTracker}
  required_labels: [Symphony, Ready]
  active_states: [open, in_progress]
  terminal_states: [closed, done]
polling:
  interval_ms: 15000
hooks:
  after_create: echo created
  before_run: echo before
  after_run: echo after
  before_remove: echo removed
  timeout_ms: 1000
agent:
  max_concurrent_agents: 3
  max_turns: 5
  max_retry_backoff_ms: 60000
codex:
  command: codex app-server --flag
  approval_policy: on-request
  thread_sandbox: read-only
  turn_timeout_ms: 1000
  read_timeout_ms: 500
  stall_timeout_ms: 0
server:
  port: 8080`)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })

      expect(workflow.config.tracker.requiredLabels).toEqual(['symphony', 'ready'])
      expect(workflow.config.tracker.activeStates).toEqual(['open', 'in_progress'])
      expect(workflow.config.tracker.terminalStates).toEqual(['closed', 'done'])
      expect(workflow.config.pollingIntervalMs).toBe(15_000)
      expect(workflow.config.hooks).toEqual({
        afterCreate: 'echo created',
        beforeRun: 'echo before',
        afterRun: 'echo after',
        beforeRemove: 'echo removed',
        timeoutMs: 1_000,
      })
      expect(workflow.config.agent.maxConcurrentAgents).toBe(3)
      expect(workflow.config.agent.maxTurns).toBe(5)
      expect(workflow.config.agent.maxRetryBackoffMs).toBe(60_000)
      expect(workflow.config.codex).toEqual({
        command: 'codex app-server --flag',
        approvalPolicy: 'on-request',
        threadSandbox: 'read-only',
        turnSandboxPolicy: null,
        turnTimeoutMs: 1_000,
        readTimeoutMs: 500,
        stallTimeoutMs: 0,
      })
      expect(workflow.config.serverPort).toBe(8_080)
    }),
  )
})

describe('workflow source errors', (): void => {
  const writeSource = (source: string): Effect.Effect<string> =>
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory()
      const path = join(directory, 'WORKFLOW.md')
      yield* Effect.promise(() => writeFile(path, source))
      return path
    })

  it.effect.each([
    [
      '---\ntracker: {}\nno closing fence',
      'workflow_parse_error',
      'YAML front matter is not closed',
    ],
    [
      '---\ntracker: [unterminated\n---\nprompt',
      'workflow_parse_error',
      'invalid YAML front matter',
    ],
    [
      '---\n- a\n- b\n---\nprompt',
      'workflow_front_matter_not_a_map',
      'workflow front matter must be a map',
    ],
    [
      '---\n42\n---\nprompt',
      'workflow_front_matter_not_a_map',
      'workflow front matter must be a map',
    ],
    [
      '---\n\n---\nprompt',
      'workflow_front_matter_not_a_map',
      'workflow front matter must be a map',
    ],
    // A document with no fence is all prompt, so the front matter is an empty map rather than a
    // malformed one, and it fails on the section it did not declare.
    ['no front matter at all', 'invalid_config', 'tracker must be a map'],
  ] as const)('reports %s', ([source, category, message]) =>
    Effect.gen(function* () {
      const path = yield* writeSource(source)

      const error = yield* Effect.flip(withEnvironment(loadHostWorkflow(path, trackerProviders)))

      expect(error.category).toBe(category)
      expect(error.message).toBe(message)
    }),
  )

  it.effect('reports a workflow file that is not there', () =>
    Effect.gen(function* () {
      const directory = yield* makeTemporaryDirectory()
      const path = join(directory, 'absent.md')

      const error = yield* Effect.flip(withEnvironment(loadHostWorkflow(path, trackerProviders)))

      expect(error.category).toBe('missing_workflow_file')
      expect(error.message).toBe(`cannot read workflow file: ${path}`)
    }),
  )
})

describe('adapter-owned validation', (): void => {
  it.effect('rejects an unsupported tracker kind', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`tracker:
  kind: linear
  provider:
    api_key: $TEST_TRACKER_TOKEN`)

      const error = yield* Effect.flip(
        withEnvironment(loadHostWorkflow(path, trackerProviders), { TEST_TRACKER_TOKEN: 'secret' }),
      )

      expect(error.category).toBe('invalid_config')
      expect(error.message).toContain('unsupported tracker.kind: linear')
    }),
  )

  it.effect('rejects a non-absolute adapter API base URL', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TEST_TRACKER_TOKEN
    api_base_url: /repos`)

      const error = yield* Effect.flip(
        withEnvironment(loadHostWorkflow(path, trackerProviders), { TEST_TRACKER_TOKEN: 'secret' }),
      )

      expect(error.category).toBe('invalid_config')
      expect(error.message).toContain('tracker.provider.api_base_url')
    }),
  )

  it.effect('trims a trailing slash from the adapter API base URL', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: $TEST_TRACKER_TOKEN
    api_base_url: https://github.example.test/api/v3/`)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })

      expect(githubProviderOf(workflow.tracker).apiBaseUrl).toBe(
        'https://github.example.test/api/v3',
      )
    }),
  )

  it.effect.each([
    ['polling:\n  interval_ms: 0', 'polling.interval_ms'],
    ['codex:\n  approval_policy: on-failure', 'codex.approval_policy'],
    ['codex:\n  approval_policy: sometimes', 'codex.approval_policy'],
    ['codex:\n  thread_sandbox: everything', 'codex.thread_sandbox'],
    ['codex:\n  stall_timeout_ms: -1', 'codex.stall_timeout_ms'],
    ['server:\n  port: 70000', 'server.port'],
  ] as const)('rejects invalid value in %s', ([section, expected]) =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`${minimalTracker}\n${section}`)

      const error = yield* Effect.flip(
        withEnvironment(loadHostWorkflow(path, trackerProviders), { TEST_TRACKER_TOKEN: 'secret' }),
      )

      expect(error.category).toBe('invalid_config')
      expect(error.message).toContain(expected)
    }),
  )

  it.effect('passes codex.turn_sandbox_policy through verbatim', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`${minimalTracker}
codex:
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots: [/srv/work]
    networkAccess: false`)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })

      expect(workflow.config.codex.turnSandboxPolicy).toEqual({
        type: 'workspaceWrite',
        writableRoots: ['/srv/work'],
        networkAccess: false,
      })
    }),
  )

  it.effect('revalidates the adapter secret on every dispatch preflight', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(minimalTracker)
      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })

      const validated = yield* withEnvironment(preflightWorkflow(workflow), {
        TEST_TRACKER_TOKEN: 'rotated',
      })
      const error = yield* Effect.flip(withEnvironment(preflightWorkflow(workflow)))

      expect(Redacted.value(githubProviderOf(validated).token)).toBe('rotated')
      expect(error.category).toBe('invalid_config')
      expect(error.message).toContain('missing environment variable')
    }),
  )

  /*
   * The preflight revalidates through the adapter that loaded the workflow, not through whichever
   * registry happens to be the default: a caller's own kind must keep adopting rotated credentials
   * rather than being reported as unsupported on every poll.
   */
  it.effect(
    'preflights a workflow loaded with a caller-supplied registry through that registry',
    () =>
      Effect.gen(function* () {
        const path = yield* writeWorkflow(`tracker:
  kind: stub
  provider:
    token: STUB_TRACKER_TOKEN`)
        const workflow = yield* withEnvironment(loadHostWorkflow(path, stubTrackerProviders), {
          STUB_TRACKER_TOKEN: 'secret',
        })

        const validated = yield* withEnvironment(preflightWorkflow(workflow), {
          STUB_TRACKER_TOKEN: 'rotated',
        })

        expect(stubProviderToken(workflow.tracker)).toBe('secret')
        expect(stubProviderToken(validated)).toBe('rotated')
        expect(sameTrackerProvider(validated, workflow.tracker)).toBe(false)
      }),
  )
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
