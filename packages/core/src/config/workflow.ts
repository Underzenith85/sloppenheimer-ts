import { Effect } from 'effect'
import { Liquid } from 'liquidjs'

import type { Issue, JsonObject } from '../domain/domain.js'
import { WorkflowError } from '../domain/errors.js'
import type { TraceCapture, TraceLimits } from '../domain/trace.js'
import type { ValidatedAgentRunner } from '../domain/agent-runner-provider.js'
import type { ValidatedTrackerProvider } from '../domain/tracker-provider.js'

export type { ValidatedAgentRunner } from '../domain/agent-runner-provider.js'
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

/**
 * The agent-runner section, split the way `tracker` is: the fields the core itself consumes, plus
 * the authored settings the owning adapter validates and nothing above it reads.
 */
export type RunnerConfig = Readonly<{
  command: string
  turnTimeoutMs: number
  readTimeoutMs: number
  stallTimeoutMs: number
  /** Adapter-owned configuration, preserved exactly as authored until an adapter validates it. */
  settings: JsonObject
}>

/**
 * High-fidelity agent tracing, off unless a workflow turns it on.
 *
 * It is an explicit operator choice rather than a default because of what it costs: the trace
 * retains complete messages, command output and tool payloads, and the redaction that guards them
 * is heuristic — it removes the configured secrets and the credential shapes the host recognizes,
 * and it cannot remove an arbitrary secret an agent printed out of ordinary source text. With it
 * off, retention is exactly what it was before the trace existed: the bounded timeline and nothing
 * on disk.
 */
export type TraceConfig = Readonly<{
  enabled: boolean
  limits: TraceLimits
}>

export type EffectiveConfig = Readonly<{
  tracker: TrackerConfig
  pollingIntervalMs: number
  workspaceRoot: string
  hooks: HooksConfig
  agent: AgentConfig
  runner: RunnerConfig
  serverPort: number | null
  trace: TraceConfig
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
  /** The adapter-validated runner selection for the workflow's `runner.kind`. */
  runner: ValidatedAgentRunner
  promptTemplate: string
}>

export const workflowDefaults = Object.freeze({
  pollingIntervalMs: 30_000,
  workspaceRootBasename: 'sloppenheimer_workspaces',
  hookTimeoutMs: 60_000,
  maxConcurrentAgents: 10,
  maxTurns: 20,
  maxRetryBackoffMs: 300_000,
  turnTimeoutMs: 3_600_000,
  readTimeoutMs: 5_000,
  stallTimeoutMs: 300_000,
  // Pull-request handoff is on unless a workflow turns it off. Since #70 it is observation-only —
  // a normal exit schedules the continuation retry and the handoff holds no claim — so the default
  // adds an extension without departing from the core lifecycle.
  handoffEnabled: true,
  activeStates: ['open'] as readonly string[],
  terminalStates: ['closed'] as readonly string[],
  trace: {
    enabled: false,
    limits: {
      // Large enough for a realistic command's output or a tool's arguments, small enough that one
      // pathological field cannot become the whole segment.
      fieldLimitBytes: 16_384,
      eventLimitBytes: 65_536,
      sessionLimitBytes: 8_388_608,
      totalLimitBytes: 268_435_456,
      retentionMs: 604_800_000,
    },
  } as const satisfies TraceConfig,
})

/** What a launch hands its runner: the ceilings, and whether to build observations at all. */
export const traceCaptureOf = (trace: TraceConfig): TraceCapture => ({
  enabled: trace.enabled,
  fieldLimitBytes: trace.limits.fieldLimitBytes,
  eventLimitBytes: trace.limits.eventLimitBytes,
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
