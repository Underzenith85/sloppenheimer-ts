import { readFile, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Effect } from 'effect'
import { Liquid } from 'liquidjs'
import { parse } from 'yaml'

import type { Issue, JsonObject } from './domain.js'
import { WorkflowError } from './errors.js'

export type GitHubProviderConfig = Readonly<{
  owner: string
  repository: string
  token: string
  tokenEnvironmentName: string
  apiBaseUrl: string
  baseBranch: string
}>

export type TrackerConfig = Readonly<{
  kind: 'github'
  provider: GitHubProviderConfig
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
}>

export type Workflow = Readonly<{
  path: string
  fingerprint: string
  config: EffectiveConfig
  promptTemplate: string
}>

type RawGitHubProvider = Readonly<{
  owner: string
  repository: string
  token: string
  apiBaseUrl: string | undefined
  baseBranch: string | undefined
}>

type RawWorkflowConfig = Readonly<{
  tracker: Readonly<{
    kind: string
    provider: RawGitHubProvider
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
    turnTimeoutMs: number | undefined
    readTimeoutMs: number | undefined
    stallTimeoutMs: number | undefined
  }>
  server: Readonly<{ port: number | undefined }>
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

const decodeRawConfig = (value: unknown): RawWorkflowConfig => {
  const root = decodeRecord(value, 'workflow front matter', true)
  const tracker = decodeRecord(root['tracker'], 'tracker', true)
  const provider = decodeRecord(tracker['provider'], 'tracker.provider', true)
  const polling = decodeRecord(root['polling'], 'polling')
  const workspace = decodeRecord(root['workspace'], 'workspace')
  const hooks = decodeRecord(root['hooks'], 'hooks')
  const agent = decodeRecord(root['agent'], 'agent')
  const codex = decodeRecord(root['codex'], 'codex')
  const server = decodeRecord(root['server'], 'server')
  return {
    tracker: {
      kind: decodeRequiredString(tracker, 'kind', 'tracker.kind'),
      provider: {
        owner: decodeRequiredString(provider, 'owner', 'tracker.provider.owner'),
        repository: decodeRequiredString(provider, 'repository', 'tracker.provider.repository'),
        token: decodeRequiredString(provider, 'token', 'tracker.provider.token'),
        apiBaseUrl: decodeString(provider, 'api_base_url', 'tracker.provider.api_base_url'),
        baseBranch: decodeString(provider, 'base_branch', 'tracker.provider.base_branch'),
      },
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
      turnTimeoutMs: decodeNumber(codex, 'turn_timeout_ms', 'codex.turn_timeout_ms'),
      readTimeoutMs: decodeNumber(codex, 'read_timeout_ms', 'codex.read_timeout_ms'),
      stallTimeoutMs: decodeNumber(codex, 'stall_timeout_ms', 'codex.stall_timeout_ms'),
    },
    server: { port: decodeNumber(server, 'port', 'server.port') },
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

const resolveEnvironment = (
  value: string,
  name: string,
  environment: NodeJS.ProcessEnv,
): string => {
  if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return value
  }
  const resolved = environment[value.slice(1)]
  if (resolved === undefined || resolved.length === 0) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `${name} references a missing environment variable`,
    })
  }
  return resolved
}

const codexAuthenticationEnvironmentNames = new Set(['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'])

const resolveSecretEnvironment = (
  value: string,
  name: string,
  environment: NodeJS.ProcessEnv,
): Readonly<{ value: string; environmentName: string }> => {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(value)
  if (match === null) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `${name} must reference an environment variable; literal credentials are not allowed in repository-owned workflow files`,
    })
  }
  const environmentName = match[1]
  if (environmentName === undefined) {
    throw new WorkflowError({ category: 'invalid_config', message: `${name} is invalid` })
  }
  if (codexAuthenticationEnvironmentNames.has(environmentName)) {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `${name} must not use Codex authentication environment variable ${environmentName}`,
    })
  }
  return {
    value: resolveEnvironment(value, name, environment),
    environmentName,
  }
}

const resolveWorkspaceRoot = (
  value: string | undefined,
  workflowPath: string,
  environment: NodeJS.ProcessEnv,
): string => {
  let configured =
    value === undefined
      ? join(tmpdir(), 'symphony_workspaces')
      : resolveEnvironment(value, 'workspace.root', environment)
  if (configured === '~') {
    configured = homedir()
  }
  if (configured.startsWith('~/')) {
    configured = join(homedir(), configured.slice(2))
  }
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
  const { tracker } = raw
  const { provider } = tracker
  const { kind } = tracker
  if (kind !== 'github') {
    throw new WorkflowError({
      category: 'invalid_config',
      message: `unsupported tracker.kind: ${kind}`,
    })
  }

  const { polling, workspace, hooks, agent, codex, server } = raw
  const trackerToken = resolveSecretEnvironment(
    provider.token,
    'tracker.provider.token',
    environment,
  )

  return {
    tracker: {
      kind: 'github',
      provider: {
        owner: provider.owner,
        repository: provider.repository,
        token: trackerToken.value,
        tokenEnvironmentName: trackerToken.environmentName,
        apiBaseUrl: provider.apiBaseUrl ?? 'https://api.github.com',
        baseBranch: provider.baseBranch ?? 'main',
      },
      requiredLabels: (tracker.requiredLabels ?? []).map((label) => label.trim().toLowerCase()),
      activeStates: tracker.activeStates ?? ['open'],
      terminalStates: tracker.terminalStates ?? ['closed'],
    },
    pollingIntervalMs: positiveInteger(polling.intervalMs, 30_000, 'polling.interval_ms'),
    workspaceRoot: resolveWorkspaceRoot(workspace.root, workflowPath, environment),
    hooks: {
      afterCreate: hooks.afterCreate ?? null,
      beforeRun: hooks.beforeRun ?? null,
      afterRun: hooks.afterRun ?? null,
      beforeRemove: hooks.beforeRemove ?? null,
      timeoutMs: positiveInteger(hooks.timeoutMs, 60_000, 'hooks.timeout_ms'),
    },
    agent: {
      maxConcurrentAgents: positiveInteger(
        agent.maxConcurrentAgents,
        10,
        'agent.max_concurrent_agents',
      ),
      maxTurns: positiveInteger(agent.maxTurns, 20, 'agent.max_turns'),
      maxRetryBackoffMs: positiveInteger(
        agent.maxRetryBackoffMs,
        300_000,
        'agent.max_retry_backoff_ms',
      ),
      maxConcurrentAgentsByState: parseConcurrencyByState(agent.maxConcurrentAgentsByState),
    },
    codex: {
      command: codex.command ?? 'codex app-server',
      approvalPolicy: codex.approvalPolicy ?? 'never',
      threadSandbox: codex.threadSandbox ?? 'workspace-write',
      turnTimeoutMs: positiveInteger(codex.turnTimeoutMs, 3_600_000, 'codex.turn_timeout_ms'),
      readTimeoutMs: positiveInteger(codex.readTimeoutMs, 5_000, 'codex.read_timeout_ms'),
      stallTimeoutMs: codex.stallTimeoutMs ?? 300_000,
    },
    serverPort: portNumber(server.port),
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

export const loadWorkflow = (
  path = resolve(process.cwd(), 'WORKFLOW.md'),
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<Workflow, WorkflowError> =>
  Effect.tryPromise({
    try: async () => {
      let sourceAndMetadata: readonly [string, Awaited<ReturnType<typeof stat>>]
      try {
        sourceAndMetadata = await Promise.all([readFile(path, 'utf8'), stat(path)])
      } catch (cause: unknown) {
        throw new WorkflowError({
          category: 'missing_workflow_file',
          message: `cannot read workflow file: ${path}`,
          cause,
        })
      }
      const [source, metadata] = sourceAndMetadata
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
      return {
        path,
        fingerprint: `${String(metadata.mtimeMs)}:${String(metadata.size)}`,
        config: parseConfig(decodeRawConfig(definition.config), path, environment),
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
