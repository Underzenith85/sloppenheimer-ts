import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Effect } from 'effect'
import { Liquid } from 'liquidjs'
import { parse } from 'yaml'

import type { Issue, JsonObject, JsonValue } from '../domain/domain.js'
import { expandHomePath, resolvePathReference } from './env-reference.js'
import { WorkflowError } from '../errors.js'
import { emptyJsonObject, JsonConversionError, toJsonObject, toJsonValue } from '../support/json.js'
import type {
  TrackerProviderRegistry,
  ValidatedTrackerProvider,
} from '../domain/tracker-provider.js'
import { trackerProviders } from '../tracker-adapters.js'

export type { ValidatedTrackerProvider } from '../domain/tracker-provider.js'

export type TrackerConfig = Readonly<{
  kind: string
  /** Adapter-owned configuration, preserved exactly as authored until an adapter validates it. */
  provider: JsonObject
  requiredLabels: readonly string[]
  activeStates: readonly string[]
  terminalStates: readonly string[]
}>

export type HooksConfig = Readonly<{
  afterCreate: string | null
  beforeRun: string | null
  afterRun: string | null
  beforeRemove: string | null
  timeoutMs: number
}>

export type AgentConfig = Readonly<{
  maxConcurrentAgents: number
  maxTurns: number
  maxRetryBackoffMs: number
  maxConcurrentAgentsByState: ReadonlyMap<string, number>
}>

export type CodexConfig = Readonly<{
  command: string
  approvalPolicy: string
  threadSandbox: string
  /** Verbatim pass-through for the App Server turn sandbox policy. */
  turnSandboxPolicy: JsonObject | null
  turnTimeoutMs: number
  readTimeoutMs: number
  stallTimeoutMs: number
}>

export type EffectiveConfig = Readonly<{
  tracker: TrackerConfig
  pollingIntervalMs: number
  workspaceRoot: string
  hooks: HooksConfig
  agent: AgentConfig
  codex: CodexConfig
  serverPort: number | null
  /** Unknown front-matter keys, preserved verbatim and otherwise ignored. */
  extensions: JsonObject
}>

export type Workflow = Readonly<{
  path: string
  fingerprint: string
  config: EffectiveConfig
  /** The adapter-validated tracker selection for `config.tracker.kind`. */
  tracker: ValidatedTrackerProvider
  promptTemplate: string
}>

export const workflowDefaults = Object.freeze({
  pollingIntervalMs: 30_000,
  workspaceRootBasename: 'symphony_workspaces',
  hookTimeoutMs: 60_000,
  maxConcurrentAgents: 10,
  maxTurns: 20,
  maxRetryBackoffMs: 300_000,
  codexCommand: 'codex app-server',
  approvalPolicy: 'never',
  threadSandbox: 'workspace-write',
  turnTimeoutMs: 3_600_000,
  readTimeoutMs: 5_000,
  stallTimeoutMs: 300_000,
  activeStates: ['open'] as readonly string[],
  terminalStates: ['closed'] as readonly string[],
})

/**
 * Codex-owned policy values, aligned with `codex app-server generate-json-schema`. The App Server's
 * `AskForApproval` also accepts a granular object form, which this host does not expose.
 */
export const codexApprovalPolicies = ['untrusted', 'on-request', 'never'] as const
export const codexSandboxModes = ['read-only', 'workspace-write', 'danger-full-access'] as const

const knownSections = new Set([
  'tracker',
  'polling',
  'workspace',
  'hooks',
  'agent',
  'codex',
  'server',
])

type RawWorkflowConfig = Readonly<{
  tracker: Readonly<{
    kind: string
    provider: JsonObject
    requiredLabels: readonly string[] | undefined
    activeStates: readonly string[] | undefined
    terminalStates: readonly string[] | undefined
  }>
  polling: Readonly<{ intervalMs: number | undefined }>
  workspace: Readonly<{ root: string | undefined }>
  hooks: Readonly<{
    afterCreate: string | undefined
    beforeRun: string | undefined
    afterRun: string | undefined
    beforeRemove: string | undefined
    timeoutMs: number | undefined
  }>
  agent: Readonly<{
    maxConcurrentAgents: number | undefined
    maxTurns: number | undefined
    maxRetryBackoffMs: number | undefined
    maxConcurrentAgentsByState: Readonly<Record<string, number>> | undefined
  }>
  codex: Readonly<{
    command: string | undefined
    approvalPolicy: string | undefined
    threadSandbox: string | undefined
    turnSandboxPolicy: JsonObject | undefined
    turnTimeoutMs: number | undefined
    readTimeoutMs: number | undefined
    stallTimeoutMs: number | undefined
  }>
  server: Readonly<{ port: number | undefined }>
  extensions: JsonObject
}>

type DecodeRecord = Record<string, unknown>

const decodeRecord = (value: unknown, name: string, required = false): DecodeRecord => {
  if (value === undefined && !required) {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowError({ category: 'invalid_config', message: `${name} must be a map` })
  }
  return value as DecodeRecord
}

const decodeJsonObject = (value: unknown, name: string): JsonObject => {
  try {
    return toJsonObject(value, name)
  } catch (cause: unknown) {
    if (cause instanceof JsonConversionError) {
      throw new WorkflowError({
        category: 'invalid_config',
        message: `${cause.path} must be a JSON-safe value`,
      })
    }
    throw new WorkflowError({ category: 'invalid_config', message: `${name} must be a map`, cause })
  }
}

const decodeString = (
  record: DecodeRecord,
  key: string,
  name: string,
  required = false,
): string | undefined => {
  const value = record[key]
  if (value === undefined && !required) {
    return undefined
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `${name} must be a non-empty string`,
    })
  }
  return value
}

const decodeRequiredString = (record: DecodeRecord, key: string, name: string): string => {
  const value = decodeString(record, key, name, true)
  if (value === undefined) {
    throw new WorkflowError({ category: 'invalid_config', message: `${name} is required` })
  }
  return value
}

const decodeNumber = (record: DecodeRecord, key: string, name: string): number | undefined => {
  const value = record[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new WorkflowError({ category: 'invalid_config', message: `${name} must be an integer` })
  }
  return value
}

const decodeStrings = (
  record: DecodeRecord,
  key: string,
  name: string,
): readonly string[] | undefined => {
  const value = record[key]
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `${name} must be a list of strings`,
    })
  }
  return value
}

const decodeConcurrency = (value: unknown): Readonly<Record<string, number>> | undefined => {
  if (value === undefined) {
    return undefined
  }
  const record = decodeRecord(value, 'agent.max_concurrent_agents_by_state')
  return Object.fromEntries(
    Object.entries(record).flatMap(([state, limit]) =>
      typeof limit === 'number' ? [[state, limit] as const] : [],
    ),
  )
}

const decodeExtensions = (root: DecodeRecord): JsonObject => {
  const entries = Object.entries(root).filter(([key]) => !knownSections.has(key))
  if (entries.length === 0) {
    return emptyJsonObject
  }
  return Object.freeze(
    Object.fromEntries(
      entries.map(
        ([key, value]) =>
          [key, toJsonValue(value, key)] as const satisfies readonly [string, JsonValue],
      ),
    ),
  )
}

const decodeRawConfig = (value: unknown): RawWorkflowConfig => {
  const root = decodeRecord(value, 'workflow front matter', true)
  const tracker = decodeRecord(root['tracker'], 'tracker', true)
  const polling = decodeRecord(root['polling'], 'polling')
  const workspace = decodeRecord(root['workspace'], 'workspace')
  const hooks = decodeRecord(root['hooks'], 'hooks')
  const agent = decodeRecord(root['agent'], 'agent')
  const codex = decodeRecord(root['codex'], 'codex')
  const server = decodeRecord(root['server'], 'server')
  const rawTurnSandboxPolicy = codex['turn_sandbox_policy']
  return {
    tracker: {
      kind: decodeRequiredString(tracker, 'kind', 'tracker.kind'),
      provider: decodeJsonObject(
        decodeRecord(tracker['provider'], 'tracker.provider', true),
        'tracker.provider',
      ),
      requiredLabels: decodeStrings(tracker, 'required_labels', 'tracker.required_labels'),
      activeStates: decodeStrings(tracker, 'active_states', 'tracker.active_states'),
      terminalStates: decodeStrings(tracker, 'terminal_states', 'tracker.terminal_states'),
    },
    polling: { intervalMs: decodeNumber(polling, 'interval_ms', 'polling.interval_ms') },
    workspace: { root: decodeString(workspace, 'root', 'workspace.root') },
    hooks: {
      afterCreate: decodeString(hooks, 'after_create', 'hooks.after_create'),
      beforeRun: decodeString(hooks, 'before_run', 'hooks.before_run'),
      afterRun: decodeString(hooks, 'after_run', 'hooks.after_run'),
      beforeRemove: decodeString(hooks, 'before_remove', 'hooks.before_remove'),
      timeoutMs: decodeNumber(hooks, 'timeout_ms', 'hooks.timeout_ms'),
    },
    agent: {
      maxConcurrentAgents: decodeNumber(
        agent,
        'max_concurrent_agents',
        'agent.max_concurrent_agents',
      ),
      maxTurns: decodeNumber(agent, 'max_turns', 'agent.max_turns'),
      maxRetryBackoffMs: decodeNumber(agent, 'max_retry_backoff_ms', 'agent.max_retry_backoff_ms'),
      maxConcurrentAgentsByState: decodeConcurrency(agent['max_concurrent_agents_by_state']),
    },
    codex: {
      command: decodeString(codex, 'command', 'codex.command'),
      approvalPolicy: decodeString(codex, 'approval_policy', 'codex.approval_policy'),
      threadSandbox: decodeString(codex, 'thread_sandbox', 'codex.thread_sandbox'),
      turnSandboxPolicy:
        rawTurnSandboxPolicy === undefined
          ? undefined
          : decodeJsonObject(
              decodeRecord(rawTurnSandboxPolicy, 'codex.turn_sandbox_policy', true),
              'codex.turn_sandbox_policy',
            ),
      turnTimeoutMs: decodeNumber(codex, 'turn_timeout_ms', 'codex.turn_timeout_ms'),
      readTimeoutMs: decodeNumber(codex, 'read_timeout_ms', 'codex.read_timeout_ms'),
      stallTimeoutMs: decodeNumber(codex, 'stall_timeout_ms', 'codex.stall_timeout_ms'),
    },
    server: { port: decodeNumber(server, 'port', 'server.port') },
    extensions: decodeExtensions(root),
  }
}

const positiveInteger = (value: number | undefined, fallback: number, name: string): number => {
  if (value === undefined) {
    return fallback
  }
  if (value <= 0) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `${name} must be a positive integer`,
    })
  }
  return value
}

const nonNegativeInteger = (value: number | undefined, fallback: number, name: string): number => {
  if (value === undefined) {
    return fallback
  }
  if (value < 0) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `${name} must not be negative`,
    })
  }
  return value
}

const portNumber = (value: number | undefined): number | null => {
  if (value === undefined) {
    return null
  }
  if (value < 0 || value > 65_535) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: 'server.port must be between 0 and 65535',
    })
  }
  return value
}

const enumeratedValue = (
  value: string | undefined,
  allowed: readonly string[],
  fallback: string,
  name: string,
): string => {
  if (value === undefined) {
    return fallback
  }
  if (!allowed.includes(value)) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `${name} must be one of: ${allowed.join(', ')}`,
    })
  }
  return value
}

const resolveWorkspaceRoot = (
  value: string | undefined,
  workflowPath: string,
  environment: NodeJS.ProcessEnv,
): string => {
  const configured =
    value === undefined
      ? join(tmpdir(), workflowDefaults.workspaceRootBasename)
      : expandHomePath(resolvePathReference(value, 'workspace.root', environment))
  return resolve(isAbsolute(configured) ? configured : join(dirname(workflowPath), configured))
}

const parseConcurrencyByState = (
  value: Readonly<Record<string, number>> | undefined,
): ReadonlyMap<string, number> => {
  if (value === undefined) {
    return new Map()
  }
  const entries = Object.entries(value).flatMap(([state, limit]) =>
    Number.isInteger(limit) && limit > 0 ? ([[state.trim().toLowerCase(), limit]] as const) : [],
  )
  return new Map(entries)
}

const parseConfig = (
  raw: RawWorkflowConfig,
  workflowPath: string,
  environment: NodeJS.ProcessEnv,
): EffectiveConfig => {
  const { tracker, polling, workspace, hooks, agent, codex, server } = raw
  const command = codex.command ?? workflowDefaults.codexCommand
  if (command.trim().length === 0) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: 'codex.command must be a non-empty string',
    })
  }

  return {
    tracker: {
      kind: tracker.kind,
      provider: tracker.provider,
      requiredLabels: (tracker.requiredLabels ?? []).map((label) => label.trim().toLowerCase()),
      activeStates: tracker.activeStates ?? workflowDefaults.activeStates,
      terminalStates: tracker.terminalStates ?? workflowDefaults.terminalStates,
    },
    pollingIntervalMs: positiveInteger(
      polling.intervalMs,
      workflowDefaults.pollingIntervalMs,
      'polling.interval_ms',
    ),
    workspaceRoot: resolveWorkspaceRoot(workspace.root, workflowPath, environment),
    hooks: {
      afterCreate: hooks.afterCreate ?? null,
      beforeRun: hooks.beforeRun ?? null,
      afterRun: hooks.afterRun ?? null,
      beforeRemove: hooks.beforeRemove ?? null,
      timeoutMs: positiveInteger(
        hooks.timeoutMs,
        workflowDefaults.hookTimeoutMs,
        'hooks.timeout_ms',
      ),
    },
    agent: {
      maxConcurrentAgents: positiveInteger(
        agent.maxConcurrentAgents,
        workflowDefaults.maxConcurrentAgents,
        'agent.max_concurrent_agents',
      ),
      maxTurns: positiveInteger(agent.maxTurns, workflowDefaults.maxTurns, 'agent.max_turns'),
      maxRetryBackoffMs: positiveInteger(
        agent.maxRetryBackoffMs,
        workflowDefaults.maxRetryBackoffMs,
        'agent.max_retry_backoff_ms',
      ),
      maxConcurrentAgentsByState: parseConcurrencyByState(agent.maxConcurrentAgentsByState),
    },
    codex: {
      command,
      approvalPolicy: enumeratedValue(
        codex.approvalPolicy,
        codexApprovalPolicies,
        workflowDefaults.approvalPolicy,
        'codex.approval_policy',
      ),
      threadSandbox: enumeratedValue(
        codex.threadSandbox,
        codexSandboxModes,
        workflowDefaults.threadSandbox,
        'codex.thread_sandbox',
      ),
      turnSandboxPolicy: codex.turnSandboxPolicy ?? null,
      turnTimeoutMs: positiveInteger(
        codex.turnTimeoutMs,
        workflowDefaults.turnTimeoutMs,
        'codex.turn_timeout_ms',
      ),
      readTimeoutMs: positiveInteger(
        codex.readTimeoutMs,
        workflowDefaults.readTimeoutMs,
        'codex.read_timeout_ms',
      ),
      stallTimeoutMs: nonNegativeInteger(
        codex.stallTimeoutMs,
        workflowDefaults.stallTimeoutMs,
        'codex.stall_timeout_ms',
      ),
    },
    serverPort: portNumber(server.port),
    extensions: raw.extensions,
  }
}

const splitWorkflow = (source: string): Readonly<{ config: unknown; prompt: string }> => {
  if (!source.startsWith('---')) {
    return { config: {}, prompt: source.trim() }
  }
  const lines = source.split(/\r?\n/u)
  const closing = lines.findIndex((line, index) => index > 0 && line === '---')
  if (closing < 0) {
    throw new WorkflowError({
      category: 'workflow_parse_error',
      message: 'YAML front matter is not closed',
    })
  }
  const yaml = lines.slice(1, closing).join('\n')
  let config: unknown
  try {
    config = parse(yaml) as unknown
  } catch (cause: unknown) {
    throw new WorkflowError({
      category: 'workflow_parse_error',
      message: 'invalid YAML front matter',
      cause,
    })
  }
  return {
    config,
    prompt: lines
      .slice(closing + 1)
      .join('\n')
      .trim(),
  }
}

/**
 * Re-runs the validation that must hold before every dispatch: a supported `tracker.kind`, an
 * adapter-accepted `tracker.provider` (including its secret indirection), and a usable
 * `codex.command`.
 *
 * `providers` defaults to the composition root's registry, which is where a tracker kind is
 * registered; this layer knows only that some adapter owns each kind.
 */
export const preflightWorkflow = (
  workflow: Workflow,
  environment: NodeJS.ProcessEnv = process.env,
  providers: TrackerProviderRegistry = trackerProviders,
): Effect.Effect<ValidatedTrackerProvider, WorkflowError> =>
  Effect.try({
    try: () => {
      if (workflow.config.codex.command.trim().length === 0) {
        throw new WorkflowError({
          category: 'invalid_config',
          message: 'codex.command must be a non-empty string',
        })
      }
      return providers.validate(
        workflow.config.tracker.kind,
        workflow.config.tracker.provider,
        environment,
      )
    },
    catch: (cause: unknown) =>
      cause instanceof WorkflowError
        ? cause
        : new WorkflowError({
            category: 'invalid_config',
            message: 'workflow preflight validation failed',
            cause,
          }),
  })

export const loadWorkflow = (
  path = resolve(process.cwd(), 'WORKFLOW.md'),
  environment: NodeJS.ProcessEnv = process.env,
  providers: TrackerProviderRegistry = trackerProviders,
): Effect.Effect<Workflow, WorkflowError> =>
  Effect.tryPromise({
    try: async () => {
      let source: string
      try {
        source = await readFile(path, 'utf8')
      } catch (cause: unknown) {
        throw new WorkflowError({
          category: 'missing_workflow_file',
          message: `cannot read workflow file: ${path}`,
          cause,
        })
      }
      const definition = splitWorkflow(source)
      if (
        typeof definition.config !== 'object' ||
        definition.config === null ||
        Array.isArray(definition.config)
      ) {
        throw new WorkflowError({
          category: 'workflow_front_matter_not_a_map',
          message: 'workflow front matter must be a map',
        })
      }
      const config = parseConfig(decodeRawConfig(definition.config), path, environment)
      return {
        path,
        fingerprint: createHash('sha256').update(source).digest('hex'),
        config,
        tracker: providers.validate(config.tracker.kind, config.tracker.provider, environment),
        promptTemplate: definition.prompt,
      }
    },
    catch: (cause: unknown) =>
      cause instanceof WorkflowError
        ? cause
        : new WorkflowError({
            category: 'workflow_parse_error',
            message: 'failed to load workflow',
            cause,
          }),
  })

const liquid = new Liquid({ strictFilters: true, strictVariables: true })
const parseAndRender: (template: string, context: JsonObject) => Promise<unknown> =
  liquid.parseAndRender.bind(liquid)

const issueForTemplate = (issue: Issue): JsonObject => ({
  id: issue.id,
  native_ref: issue.nativeRef,
  identifier: issue.identifier,
  title: issue.title,
  description: issue.description,
  priority: issue.priority,
  state: issue.state,
  branch_name: issue.branchName,
  url: issue.url,
  assignee_id: issue.assigneeId,
  labels: issue.labels,
  blocked_by: issue.blockedBy,
  dispatchable: issue.dispatchable,
  created_at: issue.createdAt?.toISOString() ?? null,
  updated_at: issue.updatedAt?.toISOString() ?? null,
})

export const renderPrompt = (
  workflow: Workflow,
  issue: Issue,
  attempt: number | null,
): Effect.Effect<string, WorkflowError> =>
  Effect.tryPromise({
    try: async () => {
      const template =
        workflow.promptTemplate || 'You are working on an issue from the configured tracker.'
      const rendered = await parseAndRender(template, { issue: issueForTemplate(issue), attempt })
      if (typeof rendered !== 'string') {
        throw new WorkflowError({
          category: 'template_render_error',
          message: 'template result is not a string',
        })
      }
      return rendered
    },
    catch: (cause: unknown) =>
      new WorkflowError({
        category: 'template_render_error',
        message: 'failed to render workflow prompt',
        cause,
      }),
  })
