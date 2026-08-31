import { Effect } from 'effect'

import {
  findDependencyCycles,
  unresolvedBlockers,
  type DependencyCycle,
} from '@symphony/core/domain/dependencies.js'
import { normalizeState, type Issue } from '@symphony/core/domain/domain.js'
import type {
  AgentDetailLookup,
  OrchestratorControl,
  OrchestratorSnapshot,
  RefreshOutcome,
} from '@symphony/core'
import { CurrentIssueControl, type IssueControlPort } from '@symphony/core/ports/issue-control.js'
import { WorkflowLoader } from '@symphony/core/ports/workflow.js'
import { TrackerError, WorkflowError } from '@symphony/core/domain/errors.js'
import type { Workflow } from '@symphony/core/config/workflow.js'

export type BacklogIssue = Readonly<{
  number: number
  identifier: string
  title: string
  url: string | null
  labels: readonly string[]
  priority: number | null
  createdAt: string | null
  enabled: boolean
  dispatchable: boolean
  state: string
  /**
   * The issue's state under the runtime's own normalization, so the console can match it against
   * the saturated states the snapshot publishes without restating that rule in the browser.
   */
  normalizedState: string
  blockedBy: Issue['blockedBy']
  readiness: 'ready' | 'blocked' | 'cyclic'
  reason: string | null
  /**
   * How many other open issues stop being blocked, directly or transitively, once this one is
   * finished. It is the console's ranking signal, and it is computed here because the dependency
   * graph the count comes from is already assembled here.
   */
  unlocks: number
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
  refresh: Effect.Effect<RefreshOutcome>
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

/**
 * How many open issues each issue unblocks, counted transitively.
 *
 * An issue is unlocked only once *every* one of its unresolved blockers is accounted for, so an
 * issue held by two blockers is credited to neither of them alone. The walk is a cascade rather
 * than plain reachability: completing the issue frees whatever it was the last blocker of, and
 * those in turn free whatever they were the last blocker of. A member of a dependency cycle can
 * never have all its blockers satisfied, so the cascade stops there rather than diverging.
 *
 * Blockers already in a terminal state are excluded, because they are not holding anything back.
 */
const downstreamCounts = (
  openIssues: readonly Issue[],
  terminalStates: readonly string[],
): ReadonlyMap<string, number> => {
  const blockers = new Map<string, ReadonlySet<string>>()
  const dependents = new Map<string, string[]>()
  for (const issue of openIssues) {
    const unresolved = unresolvedBlockers(issue, terminalStates)
    blockers.set(issue.identifier, new Set(unresolved.map((blocker) => blocker.identifier)))
    for (const blocker of unresolved) {
      const existing = dependents.get(blocker.identifier)
      if (existing === undefined) {
        dependents.set(blocker.identifier, [issue.identifier])
      } else {
        existing.push(issue.identifier)
      }
    }
  }
  const counts = new Map<string, number>()
  for (const issue of openIssues) {
    const cleared = new Set<string>([issue.identifier])
    const frontier: string[] = [issue.identifier]
    while (frontier.length > 0) {
      const finished = frontier.pop()
      if (finished === undefined) {
        continue
      }
      for (const dependent of dependents.get(finished) ?? []) {
        if (cleared.has(dependent)) {
          continue
        }
        const remaining = blockers.get(dependent) ?? new Set<string>()
        if ([...remaining].every((blocker) => cleared.has(blocker))) {
          cleared.add(dependent)
          frontier.push(dependent)
        }
      }
    }
    counts.set(issue.identifier, cleared.size - 1)
  }
  return counts
}

export const buildBacklogSnapshot = (
  openIssues: readonly Issue[],
  label: string,
  terminalStates: readonly string[],
  pausedIssueNumbers: ReadonlySet<number> = new Set(),
): BacklogSnapshot => {
  const cycles = findDependencyCycles(openIssues)
  const cyclic = new Set(cycles.flatMap((cycle) => cycle.members))
  const unlocks = downstreamCounts(openIssues, terminalStates)
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
      dispatchable: issue.dispatchable,
      state: issue.state,
      normalizedState: normalizeState(issue.state),
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
      unlocks: unlocks.get(issue.identifier) ?? 0,
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
): Effect.Effect<OperatorBackend, never, CurrentIssueControl | WorkflowLoader> =>
  Effect.map(
    Effect.all({ issueControl: CurrentIssueControl, loader: WorkflowLoader }),
    ({ issueControl, loader }): OperatorBackend => {
      type LoadedControl = Readonly<{
        label: string
        issues: IssueControlPort
        terminalStates: readonly string[]
      }>
      /**
       * The workflow is reloaded per request, so the console reflects an edit without a restart. The
       * issue control itself is not rebuilt per request: the cell hands back the instance already in
       * force unless the workflow now names a different provider, which keeps the adapter's
       * dependency-hydration cache warm across requests while a credential rotation still takes
       * effect.
       */
      const loadControl: Effect.Effect<LoadedControl, OperatorBackendError> = loader
        .load(workflowPath)
        .pipe(
          Effect.flatMap((workflow) =>
            Effect.all({
              label: controlLabel(workflow),
              issues: issueControl.forProvider(workflow.tracker),
              terminalStates: Effect.succeed(workflow.config.tracker.terminalStates),
            }),
          ),
        )

      /**
       * Paused issues are read from the orchestrator's snapshot rather than tracked here. The
       * orchestrator owns the set that decides dispatch, so a second copy in the console could only
       * ever disagree with the behaviour the operator is looking at.
       */
      const pausedIssueNumbers = Effect.map(
        orchestrator.snapshot,
        (snapshot) => new Set(snapshot.pausedIssueNumbers),
      )

      return {
        snapshot: orchestrator.snapshot,
        refresh: orchestrator.refresh,
        agentDetail: orchestrator.agentDetail,
        backlog: Effect.gen(function* () {
          const { label, issues, terminalStates } = yield* loadControl
          const openIssues = yield* issues.listOpenIssues()
          return buildBacklogSnapshot(openIssues, label, terminalStates, yield* pausedIssueNumbers)
        }),
        setIssueEnabled: (issueNumber, enabled) =>
          loadControl.pipe(
            Effect.flatMap(({ label, issues, terminalStates }) => {
              if (!enabled) {
                return orchestrator.setIssuePaused(issueNumber, true)
              }
              return issues.listOpenIssues().pipe(
                Effect.flatMap((openIssues) => {
                  const target = buildBacklogSnapshot(
                    openIssues,
                    label,
                    terminalStates,
                  ).issues.find((issue) => issue.number === issueNumber)
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
                  return issues
                    .addLabel(issueNumber, label)
                    .pipe(Effect.zipRight(orchestrator.setIssuePaused(issueNumber, false)))
                }),
              )
            }),
          ),
      }
    },
  )
