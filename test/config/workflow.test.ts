import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from '@effect/vitest'
import { Effect, Redacted } from 'effect'

import { trackerProviders } from '../../src/tracker-adapters.js'
import { afterEach, describe, expect } from 'vitest'

import { githubProviderOf } from '@sloppenheimer/adapter-github'
import { issueId, issueIdentifier, type Issue } from '@sloppenheimer/core/domain/domain.js'
import { sameTrackerProvider } from '@sloppenheimer/core/domain/tracker-provider.js'
import type { WorkflowError } from '@sloppenheimer/core/domain/errors.js'
import type { TrackerProviderRegistry } from '@sloppenheimer/core/domain/tracker-provider.js'
import { withEnvironment } from '../harness/environment.js'
import { hostFileSystem } from '../harness/filesystem.js'
import { stubProviderToken, stubTrackerProviders } from '../harness/stub-tracker-provider.js'
import { JsonConversionError, toJsonValue } from '@sloppenheimer/core/support/json.js'
import {
  renderPrompt,
  workflowDefaults,
  type Workflow,
} from '@sloppenheimer/core/config/workflow.js'
import { loadWorkflow, preflightWorkflow } from '../../src/config/workflow.js'
import { workflowAdaptersFor } from '../harness/workflow-adapters.js'
import { codexSettingsDefaults, codexSettingsOf } from '@sloppenheimer/adapter-codex'
import { auroraTempo } from '../harness/alien-agent-runner.js'
import { anIssue } from '../harness/fixtures.js'

/**
 * `loadWorkflow` reads its source through `FileSystem`; every test here reads the real files it
 * wrote, so the host filesystem is bound exactly as the composition root binds it.
 */
const loadHostWorkflow = (
  path: string,
  providers: TrackerProviderRegistry,
): Effect.Effect<Workflow, WorkflowError> =>
  loadWorkflow(path, workflowAdaptersFor(providers)).pipe(Effect.provide(hostFileSystem))

const temporaryDirectories: string[] = []

const makeTemporaryDirectory = (): Effect.Effect<string> =>
  Effect.promise(async () => {
    const path = await mkdtemp(join(tmpdir(), 'sloppenheimer-workflow-test-'))
    temporaryDirectories.push(path)
    return path
  })

const issue: Issue = anIssue({
  id: issueId('42'),
  identifier: issueIdentifier('GH-42'),
  title: 'Keep types exact',
  nativeRef: { number: 42 },
  description: 'Use the type system',
  priority: 1,
  url: 'https://example.test/issues/42',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
})

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
    repository: sloppenheimer
    token: $TEST_TRACKER_TOKEN
  required_labels: [Sloppenheimer]
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
        repository: 'sloppenheimer',
        token: '$TEST_TRACKER_TOKEN',
      })
      expect(Redacted.value(githubProviderOf(workflow.tracker).token)).toBe('secret')
      expect(githubProviderOf(workflow.tracker).tokenEnvironmentName).toBe('TEST_TRACKER_TOKEN')
      expect(workflow.config.tracker.requiredLabels).toEqual(['sloppenheimer'])
      expect(githubProviderOf(workflow.tracker).baseBranch).toBe('main')
      expect(workflow.config.workspaceRoot).toBe(join(directory, '.workspaces'))
      expect(workflow.config.agent.maxConcurrentAgents).toBe(2)
      // The sandbox is Codex's own setting now: preserved verbatim under `settings`, and read back
      // through the adapter that owns it rather than off the neutral configuration.
      expect(codexSettingsOf(workflow.runner).threadSandbox).toBe('workspace-write')
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
    repository: sloppenheimer
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
    repository: sloppenheimer
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
    repository: sloppenheimer
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
    repository: sloppenheimer
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
    repository: sloppenheimer
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
    repository: sloppenheimer
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
      expect(workflow.config.runner).toEqual({
        command: codexSettingsDefaults.command,
        turnTimeoutMs: workflowDefaults.turnTimeoutMs,
        readTimeoutMs: workflowDefaults.readTimeoutMs,
        stallTimeoutMs: workflowDefaults.stallTimeoutMs,
        settings: {},
      })
      expect(workflow.config.tracker.activeStates).toEqual(['open'])
      expect(workflow.config.tracker.terminalStates).toEqual(['closed'])
      expect(workflow.config.tracker.requiredLabels).toEqual([])
      expect(workflow.config.serverPort).toBeNull()
      expect(workflow.config.handoffEnabled).toBe(workflowDefaults.handoffEnabled)
      expect(workflow.config.handoffEnabled).toBe(true)
      // High-fidelity tracing is off unless a workflow asks for it: it retains complete agent
      // output, and the redaction guarding that is heuristic, so it is an operator's explicit
      // choice rather than a default.
      expect(workflow.config.trace).toEqual(workflowDefaults.trace)
      expect(workflow.config.trace.enabled).toBe(false)
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
    repository: sloppenheimer
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
    repository: sloppenheimer
    token: $TEST_TRACKER_TOKEN
    adapter_specific:
      nested: [1, 2]`)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })

      expect(workflow.config.tracker.provider).toEqual({
        owner: 'example',
        repository: 'sloppenheimer',
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
  root: ~/sloppenheimer-root`)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })

      expect(workflow.config.workspaceRoot).toBe(join(homedir(), 'sloppenheimer-root'))
    }),
  )

  it.effect('resolves $VAR in the declared workspace path field', () =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`${minimalTracker}
workspace:
  root: $TEST_WORKSPACE_ROOT`)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
        TEST_WORKSPACE_ROOT: '/srv/sloppenheimer',
      })

      expect(workflow.config.workspaceRoot).toBe('/srv/sloppenheimer')
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

      expect(workflow.config.runner.command).toBe('$CODEX_COMMAND')
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
      'codex.approval_policy must be one of: untrusted, on-request, never',
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
      `${minimalTracker}\nrunner:\n  kind: nowhere`,
      'unsupported runner.kind: nowhere (supported: codex, aurora)',
    ],
    [`${minimalTracker}\nrunner:\n  settings: 5`, 'runner.settings must be a map'],
    [
      `${minimalTracker}\nrunner:\n  kind: aurora\n  settings:\n    tempo: allegro`,
      'runner.settings.tempo must be one of: largo, presto',
    ],
    [
      `${minimalTracker}\nrunner:\n  kind: codex\n  settings:\n    approval_policy: sometimes`,
      'runner.settings.approval_policy must be one of: untrusted, on-request, never',
    ],
    [
      `${minimalTracker}\nrunner:\n  kind: codex\ncodex:\n  command: codex app-server`,
      'runner and codex must not both be declared; codex is the deprecated spelling of runner.kind codex',
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
    [`${minimalTracker}\nhandoff: 5`, 'handoff must be a map'],
    [`${minimalTracker}\nhandoff:\n  enabled: 5`, 'handoff.enabled must be a boolean'],
    [`${minimalTracker}\nhandoff:\n  enabled: "false"`, 'handoff.enabled must be a boolean'],
    [`${minimalTracker}\ntrace: 5`, 'trace must be a map'],
    [`${minimalTracker}\ntrace:\n  enabled: yes please`, 'trace.enabled must be a boolean'],
    [
      `${minimalTracker}\ntrace:\n  field_limit_bytes: 0`,
      'trace.field_limit_bytes must be a positive integer',
    ],
    [
      `${minimalTracker}\ntrace:\n  session_limit_bytes: -1`,
      'trace.session_limit_bytes must be a positive integer',
    ],
    [
      `${minimalTracker}\ntrace:\n  retention_hours: -1`,
      'trace.retention_hours must not be negative',
    ],
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
  required_labels: [Sloppenheimer, Ready]
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
  port: 8080
handoff:
  enabled: false
trace:
  enabled: true
  field_limit_bytes: 2048
  event_limit_bytes: 8192
  session_limit_bytes: 131072
  total_limit_bytes: 1048576
  retention_hours: 0`)

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })

      expect(workflow.config.tracker.requiredLabels).toEqual(['sloppenheimer', 'ready'])
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
      // Under the alias, the four neutral fields become the runner's own and everything else the
      // block declared is preserved verbatim as the adapter's settings.
      expect(workflow.config.runner).toEqual({
        command: 'codex app-server --flag',
        turnTimeoutMs: 1_000,
        readTimeoutMs: 500,
        stallTimeoutMs: 0,
        settings: { approval_policy: 'on-request', thread_sandbox: 'read-only' },
      })
      expect(workflow.runner.kind).toBe('codex')
      expect(codexSettingsOf(workflow.runner)).toEqual({
        approvalPolicy: 'on-request',
        threadSandbox: 'read-only',
        turnSandboxPolicy: null,
      })
      expect(workflow.config.serverPort).toBe(8_080)
      expect(workflow.config.handoffEnabled).toBe(false)
      // Retention is authored in hours and compared in milliseconds; zero hours is "retain until
      // the size ceiling evicts it" rather than "retain nothing".
      expect(workflow.config.trace).toEqual({
        enabled: true,
        limits: {
          fieldLimitBytes: 2_048,
          eventLimitBytes: 8_192,
          sessionLimitBytes: 131_072,
          totalLimitBytes: 1_048_576,
          retentionMs: 0,
        },
      })
      // The extension owns a section of its own now, so it is configuration rather than an unknown
      // key the loader carries through.
      expect(workflow.config.extensions).toEqual({})
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
    repository: sloppenheimer
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
    repository: sloppenheimer
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

      expect(codexSettingsOf(workflow.runner).turnSandboxPolicy).toEqual({
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

      expect(Redacted.value(githubProviderOf(validated.tracker).token)).toBe('rotated')
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
        expect(stubProviderToken(validated.tracker)).toBe('rotated')
        expect(sameTrackerProvider(validated.tracker, workflow.tracker)).toBe(false)
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

describe('agent runner selection', (): void => {
  const runnerWorkflow = (frontMatter: string): Effect.Effect<Workflow, WorkflowError> =>
    Effect.gen(function* () {
      const path = yield* writeWorkflow(`${minimalTracker}\n${frontMatter}`)
      return yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        TEST_TRACKER_TOKEN: 'secret',
      })
    })

  it.effect('reads a document that names no runner as the default kind', () =>
    Effect.gen(function* () {
      const workflow = yield* runnerWorkflow('polling:\n  interval_ms: 1000')

      expect(workflow.runner.kind).toBe('codex')
      expect(workflow.config.runner.command).toBe(codexSettingsDefaults.command)
    }),
  )

  it.effect("selects a second kind and takes that adapter's default command", () =>
    Effect.gen(function* () {
      const workflow = yield* runnerWorkflow(
        'runner:\n  kind: aurora\n  settings:\n    tempo: presto',
      )

      expect(workflow.runner.kind).toBe('aurora')
      // The command default belongs to the adapter, not to this loader: selecting a different
      // runner changes which executable a workflow that named none is launching.
      expect(workflow.config.runner.command).toBe('aurora --serve')
      expect(auroraTempo(workflow.runner)).toBe('presto')
      expect(workflow.runner.authenticationEnvironmentNames).toEqual(['AURORA_SIGNING_KEY'])
    }),
  )

  it.effect('keeps the neutral fields under the new spelling', () =>
    Effect.gen(function* () {
      const workflow = yield* runnerWorkflow(
        'runner:\n  kind: aurora\n  command: aurora --once\n  stall_timeout_ms: 42',
      )

      expect(workflow.config.runner.command).toBe('aurora --once')
      expect(workflow.config.runner.stallTimeoutMs).toBe(42)
      expect(workflow.config.runner.settings).toEqual({})
    }),
  )

  it.effect("refuses a tracker credential naming the selected runner's own authentication", () =>
    Effect.gen(function* () {
      // The host has to strip tracker secrets from the agent's environment and preserve the
      // runner's authentication in it; a variable that is both cannot be honoured either way. The
      // rule is stated against whichever runner the workflow chose, not against a fixed list.
      const path = yield* writeWorkflow(
        `tracker:\n  kind: github\n  provider:\n    owner: example\n    repository: sloppenheimer\n    token: $AURORA_SIGNING_KEY\nrunner:\n  kind: aurora`,
      )

      const error = yield* Effect.flip(
        withEnvironment(loadHostWorkflow(path, trackerProviders), {
          AURORA_SIGNING_KEY: 'secret',
        }),
      )

      expect(error.category).toBe('invalid_config')
      expect(error.message).toBe(
        'tracker credentials must not use aurora authentication environment variable AURORA_SIGNING_KEY',
      )
    }),
  )

  it.effect('accepts a credential that only the other registered runner reserves', () =>
    Effect.gen(function* () {
      // OPENAI_API_KEY is Codex's, and Codex is registered — but it is not the selected runner, so
      // nothing about this workflow makes the name unusable.
      const path = yield* writeWorkflow(
        `tracker:\n  kind: github\n  provider:\n    owner: example\n    repository: sloppenheimer\n    token: $OPENAI_API_KEY\nrunner:\n  kind: aurora`,
      )

      const workflow = yield* withEnvironment(loadHostWorkflow(path, trackerProviders), {
        OPENAI_API_KEY: 'secret',
      })

      expect(workflow.runner.kind).toBe('aurora')
    }),
  )
})
