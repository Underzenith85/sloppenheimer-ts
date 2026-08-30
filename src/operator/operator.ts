import { Effect } from 'effect'

import {
  findDependencyCycles,
  unresolvedBlockers,
  type DependencyCycle,
} from '../domain/dependencies.js'
import { normalizeState, type Issue } from '../domain/domain.js'
import type {
  AgentDetailLookup,
  OrchestratorControl,
  OrchestratorSnapshot,
} from '../orchestrator.js'
import { makeGitHubIssueControl } from '../tracker.js'
import { TrackerError, WorkflowError } from '../errors.js'
import { loadWorkflow, type Workflow } from '../config/workflow.js'

export type BacklogIssue = Readonly<{
  number: number
  identifier: string
  title: string
  url: string | null
  labels: readonly string[]
  priority: number | null
  createdAt: string | null
  enabled: boolean
  state: string
  blockedBy: Issue['blockedBy']
  readiness: 'ready' | 'blocked' | 'cyclic'
  reason: string | null
}>

export type DependencyNode = Readonly<{
  identifier: string
  number: number | null
  title: string
  url: string | null
  state: string
  readiness: 'ready' | 'blocked' | 'cyclic' | 'completed'
  reason: string | null
  actionable: boolean
}>

export type DependencyEdge = Readonly<{
  blocker: string
  dependent: string
}>

export type BacklogSnapshot = Readonly<{
  controlLabel: string
  issues: readonly BacklogIssue[]
  nodes: readonly DependencyNode[]
  edges: readonly DependencyEdge[]
  cycles: readonly DependencyCycle[]
}>

export type OperatorBackendError = WorkflowError | TrackerError

export type OperatorBackend = Readonly<{
  snapshot: Effect.Effect<OrchestratorSnapshot>
  refresh: Effect.Effect<void>
  /**
   * Live detail for one agent. It is served from the orchestrator's published index, so polling it
   * cannot queue behind — or interfere with — tracker polling.
   */
  agentDetail: (identifier: string) => Effect.Effect<AgentDetailLookup>
  backlog: Effect.Effect<BacklogSnapshot, OperatorBackendError>
  setIssueEnabled: (
    issueNumber: number,
    enabled: boolean,
  ) => Effect.Effect<void, OperatorBackendError>
}>

const controlLabel = (workflow: Workflow): Effect.Effect<string, WorkflowError> => {
  const labels = workflow.config.tracker.requiredLabels
  if (labels.length !== 1 || labels[0] === undefined || labels[0].trim().length === 0) {
    return Effect.fail(
      new WorkflowError({
        category: 'invalid_config',
        message: 'operator controls require exactly one tracker.required_labels entry',
      }),
    )
  }
  return Effect.succeed(labels[0].trim())
}

const terminalState = (state: string, terminalStates: readonly string[]): boolean =>
  terminalStates.some((candidate) => normalizeState(candidate) === normalizeState(state))

const issueNumber = (identifier: string): number | null => {
  const match = /#(\d+)$/u.exec(identifier)
  return match?.[1] === undefined ? null : Number(match[1])
}

export const buildBacklogSnapshot = (
  openIssues: readonly Issue[],
  label: string,
  terminalStates: readonly string[],
  pausedIssueNumbers: ReadonlySet<number> = new Set(),
): BacklogSnapshot => {
  const cycles = findDependencyCycles(openIssues)
  const cyclic = new Set(cycles.flatMap((cycle) => cycle.members))
  const issues = openIssues.map((issue): BacklogIssue => {
    const blockers = unresolvedBlockers(issue, terminalStates)
    const isCyclic = cyclic.has(issue.identifier)
    return {
      number: Number(issue.id),
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      labels: issue.labels,
      priority: issue.priority,
      createdAt: issue.createdAt?.toISOString() ?? null,
      enabled:
        !pausedIssueNumbers.has(Number(issue.id)) && issue.labels.includes(label.toLowerCase()),
      state: issue.state,
      // The table presents active scheduling constraints. Keep the complete dependency history in
      // `nodes` and `edges`, but do not label an issue as "Blocked by" a terminal dependency.
      blockedBy: blockers,
      readiness: isCyclic ? 'cyclic' : blockers.length > 0 ? 'blocked' : 'ready',
      reason: isCyclic
        ? (cycles.find((cycle) => cycle.members.includes(issue.identifier))?.message ??
          'Issue belongs to a dependency cycle')
        : blockers.length > 0
          ? `Waiting for ${blockers.map((blocker) => blocker.identifier).join(', ')}`
          : null,
    }
  })
  const nodes = new Map<string, DependencyNode>()
  for (const issue of issues) {
    nodes.set(issue.identifier, {
      identifier: issue.identifier,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      readiness: issue.readiness,
      reason: issue.reason,
      actionable: true,
    })
  }
  const edges: DependencyEdge[] = []
  for (const issue of openIssues) {
    for (const blocker of issue.blockedBy) {
      edges.push({ blocker: blocker.identifier, dependent: issue.identifier })
      if (!nodes.has(blocker.identifier)) {
        nodes.set(blocker.identifier, {
          identifier: blocker.identifier,
          number: issueNumber(blocker.identifier),
          title: blocker.title,
          url: blocker.url,
          state: blocker.state,
          readiness: terminalState(blocker.state, terminalStates) ? 'completed' : 'blocked',
          reason: terminalState(blocker.state, terminalStates)
            ? null
            : 'Unresolved blocker outside the open backlog',
          actionable: false,
        })
      }
    }
  }
  return {
    controlLabel: label,
    issues,
    nodes: [...nodes.values()].sort((left, right) =>
      left.identifier.localeCompare(right.identifier),
    ),
    edges: edges.sort((left, right) =>
      `${left.blocker}\0${left.dependent}`.localeCompare(`${right.blocker}\0${right.dependent}`),
    ),
    cycles,
  }
}

export const makeOperatorBackend = (
  workflowPath: string,
  orchestrator: OrchestratorControl,
): OperatorBackend => {
  type LoadedControl = Readonly<{
    label: string
    issues: ReturnType<typeof makeGitHubIssueControl>
    terminalStates: readonly string[]
  }>
  let cachedControl: Readonly<{ fingerprint: string; control: LoadedControl }> | null = null
  const pausedIssueNumbers = new Set<number>()
  const loadControl = loadWorkflow(workflowPath).pipe(
    Effect.flatMap((workflow) =>
      controlLabel(workflow).pipe(
        Effect.map((label) => {
          if (cachedControl?.fingerprint === workflow.fingerprint) {
            return cachedControl.control
          }
          const control: LoadedControl = {
            label,
            issues: makeGitHubIssueControl(workflow.tracker.provider),
            terminalStates: workflow.config.tracker.terminalStates,
          }
          cachedControl = { fingerprint: workflow.fingerprint, control }
          return control
        }),
      ),
    ),
  )

  return {
    snapshot: orchestrator.snapshot,
    refresh: orchestrator.refresh,
    agentDetail: orchestrator.agentDetail,
    backlog: loadControl.pipe(
      Effect.flatMap(({ label, issues, terminalStates }) =>
        issues
          .listOpenIssues()
          .pipe(
            Effect.map((openIssues) =>
              buildBacklogSnapshot(openIssues, label, terminalStates, pausedIssueNumbers),
            ),
          ),
      ),
    ),
    setIssueEnabled: (issueNumber, enabled) =>
      loadControl.pipe(
        Effect.flatMap(({ label, issues, terminalStates }) => {
          if (!enabled) {
            return orchestrator
              .setIssuePaused(issueNumber, true)
              .pipe(Effect.tap(() => Effect.sync(() => pausedIssueNumbers.add(issueNumber))))
          }
          return issues.listOpenIssues().pipe(
            Effect.flatMap((openIssues) => {
              const target = buildBacklogSnapshot(openIssues, label, terminalStates).issues.find(
                (issue) => issue.number === issueNumber,
              )
              if (target === undefined) {
                return Effect.fail(
                  new TrackerError({
                    category: 'tracker_response',
                    message: 'issue is not present in the open backlog',
                    retryable: false,
                  }),
                )
              }
              if (target.readiness !== 'ready') {
                return Effect.fail(
                  new TrackerError({
                    category: 'tracker_response',
                    message: target.reason ?? 'issue is not ready',
                    retryable: false,
                  }),
                )
              }
              return issues.addLabel(issueNumber, label).pipe(
                Effect.zipRight(orchestrator.setIssuePaused(issueNumber, false)),
                Effect.tap(() => Effect.sync(() => pausedIssueNumbers.delete(issueNumber))),
              )
            }),
          )
        }),
      ),
  }
}
