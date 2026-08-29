import { Effect } from 'effect'

import type { OrchestratorControl, OrchestratorSnapshot } from './orchestrator.js'
import { makeGitHubIssueControl } from './tracker.js'
import { WorkflowError, type TrackerError } from './errors.js'
import { loadWorkflow, type Workflow } from './workflow.js'

export type BacklogIssue = Readonly<{
  number: number
  identifier: string
  title: string
  url: string | null
  labels: readonly string[]
  priority: number | null
  createdAt: string | null
  enabled: boolean
}>

export type BacklogSnapshot = Readonly<{
  controlLabel: string
  issues: readonly BacklogIssue[]
}>

export type OperatorBackendError = WorkflowError | TrackerError

export type OperatorBackend = Readonly<{
  snapshot: Effect.Effect<OrchestratorSnapshot>
  refresh: Effect.Effect<void>
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

export const makeOperatorBackend = (
  workflowPath: string,
  orchestrator: OrchestratorControl,
): OperatorBackend => {
  const loadControl = loadWorkflow(workflowPath).pipe(
    Effect.flatMap((workflow) =>
      controlLabel(workflow).pipe(
        Effect.map((label) => ({
          label,
          issues: makeGitHubIssueControl(workflow.config.tracker.provider),
        })),
      ),
    ),
  )

  return {
    snapshot: orchestrator.snapshot,
    refresh: orchestrator.refresh,
    backlog: loadControl.pipe(
      Effect.flatMap(({ label, issues }) =>
        issues.listOpenIssues().pipe(
          Effect.map((openIssues) => ({
            controlLabel: label,
            issues: openIssues.map((issue) => ({
              number: Number(issue.id),
              identifier: issue.identifier,
              title: issue.title,
              url: issue.url,
              labels: issue.labels,
              priority: issue.priority,
              createdAt: issue.createdAt?.toISOString() ?? null,
              enabled: issue.labels.includes(label.toLowerCase()),
            })),
          })),
        ),
      ),
    ),
    setIssueEnabled: (issueNumber, enabled) =>
      loadControl.pipe(
        Effect.flatMap(({ label, issues }) => issues.setLabel(issueNumber, label, enabled)),
      ),
  }
}
