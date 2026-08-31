import { Effect } from 'effect'
import { Liquid } from 'liquidjs'

import type { Issue, JsonObject } from '../domain/domain.js'
import { WorkflowError } from '../domain/errors.js'
import type { ValidatedTrackerProvider } from '../domain/tracker-provider.js'

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
  /**
   * Whether the pull-request handoff extension is composed. The composition root reads this once,
   * at startup, and composes the code-review services when it is set; nothing below it consults the
   * value, because the presence of those services *is* the gate.
   */
  handoffEnabled: boolean
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
  // Pull-request handoff is on unless a workflow turns it off. Since #70 it is observation-only —
  // a normal exit schedules the continuation retry and the handoff holds no claim — so the default
  // adds an extension without departing from the core lifecycle.
  handoffEnabled: true,
  activeStates: ['open'] as readonly string[],
  terminalStates: ['closed'] as readonly string[],
})

/**
 * Codex-owned policy values, aligned with `codex app-server generate-json-schema`. The App Server's
 * `AskForApproval` also accepts a granular object form, which this host does not expose.
 */
export const codexApprovalPolicies = ['untrusted', 'on-request', 'never'] as const
export const codexSandboxModes = ['read-only', 'workspace-write', 'danger-full-access'] as const

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
