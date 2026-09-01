import { issueId, issueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import type { BacklogSnapshot } from '../../src/operator/operator.js'
import type { OrchestratorSnapshot } from '@sloppenheimer/core'

/**
 * One repository state exercising every classification the console can make: running, stalled,
 * retrying, awaiting checks, repair needed, intervention required, merged, completed, ready,
 * blocked and cyclic. The whole console suite is built from it so that no test has to invent a
 * shape the runtime would never publish.
 */

export const runningIdentifier = 'example/sloppenheimer#17'
export const stalledIdentifier = 'example/sloppenheimer#21'
export const retryingIdentifier = 'example/sloppenheimer#18'
export const awaitingIdentifier = 'example/sloppenheimer#30'
export const repairIdentifier = 'example/sloppenheimer#31'
export const interventionIdentifier = 'example/sloppenheimer#32'
export const mergedIdentifier = 'example/sloppenheimer#40'
export const staleMergedIdentifier = 'example/sloppenheimer#41'
export const readyTopIdentifier = 'example/sloppenheimer#50'
export const readyMiddleIdentifier = 'example/sloppenheimer#52'
export const readyLastIdentifier = 'example/sloppenheimer#51'
export const blockedIdentifier = 'example/sloppenheimer#60'
export const escalatedBlockedIdentifier = 'example/sloppenheimer#61'
export const cyclicIdentifier = 'example/sloppenheimer#70'
export const cyclicPartnerIdentifier = 'example/sloppenheimer#71'

const tokens = { inputTokens: 10, outputTokens: 5, totalTokens: 15 } as const

const runningEntry = (
  number: number,
  identifier: string,
  title: string,
  stallDeadline: string | null,
  lastEvent: string | null,
): OrchestratorSnapshot['running'][number] => ({
  issueId: issueId(String(number)),
  identifier,
  title,
  url: `https://example.test/issues/${String(number)}`,
  state: 'open',
  attempt: null,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  lastEventAt: new Date(Date.now() - 5_000).toISOString(),
  lastEvent,
  lastMessage: null,
  processId: 42,
  threadId: 'thread-1',
  turnId: 'turn-1',
  sessionId: 'thread-1',
  turnCount: 1,
  tokens,
  lastReportedTokens: tokens,
  workerHost: 'local',
  stallDeadline,
  detailUrl: `/api/v1/agents/${encodeURIComponent(identifier)}`,
})

const handoffEntry = (
  number: number,
  identifier: string,
  state: OrchestratorSnapshot['handoffs'][number]['state'],
  reason: string | null,
): OrchestratorSnapshot['handoffs'][number] => ({
  issueId: String(number),
  identifier,
  pullRequestUrl: `https://example.test/pull/${String(number)}`,
  branchName: `sloppenheimer/issue-${String(number)}`,
  state,
  headSha: `head-${String(number)}`,
  reason,
  repairAttempts: 0,
  observedAt: new Date(Date.now() - 30_000).toISOString(),
})

export const consoleState = (): OrchestratorSnapshot => ({
  generatedAt: new Date().toISOString(),
  workflowPath: '/tmp/WORKFLOW.md',
  effectiveWorkflow: { fingerprint: 'ui', loadedAt: new Date(Date.now() - 600_000).toISOString() },
  workflowReloadError: null,
  pollingIntervalMs: 10_000,
  maxConcurrentAgents: 4,
  counts: { running: 2, retrying: 1, completed: 2 },
  pausedIssueNumbers: [],
  handoffRecovery: {
    status: 'completed',
    loaded: 0,
    recovered: 0,
    skipped: 0,
    failed: 0,
    storeError: null,
  },
  handoffs: [
    handoffEntry(30, awaitingIdentifier, 'awaiting_checks', 'Waiting for required checks'),
    handoffEntry(31, repairIdentifier, 'repair_needed', 'The pull request conflicts with main'),
    handoffEntry(
      32,
      interventionIdentifier,
      'intervention_required',
      'Repair attempts were exhausted',
    ),
  ],
  running: [
    runningEntry(
      17,
      runningIdentifier,
      'Operator console',
      new Date(Date.now() + 300_000).toISOString(),
      'item/completed',
    ),
    runningEntry(
      21,
      stalledIdentifier,
      'Silent agent',
      new Date(Date.now() - 1_000).toISOString(),
      'item/started',
    ),
  ],
  retrying: [
    {
      issueId: issueId('18'),
      identifier: retryingIdentifier,
      title: 'Flaky dependency',
      url: 'https://example.test/issues/18',
      attempt: 1,
      dueAt: new Date(Date.now() + 15_000).toISOString(),
      error: 'turn failed',
      workerHost: 'local',
      detailUrl: `/api/v1/agents/${encodeURIComponent(retryingIdentifier)}`,
    },
  ],
  completed: [
    {
      issueId: issueId('40'),
      identifier: mergedIdentifier,
      title: 'Merged an hour ago',
      url: 'https://example.test/issues/40',
      outcome: 'merged',
      finishedAt: new Date(Date.now() - 3_600_000).toISOString(),
      pullRequestUrl: 'https://example.test/pull/40',
    },
    {
      issueId: issueId('41'),
      identifier: staleMergedIdentifier,
      title: 'Merged two days ago',
      url: 'https://example.test/issues/41',
      outcome: 'merged',
      finishedAt: new Date(Date.now() - 40 * 3_600_000).toISOString(),
      pullRequestUrl: 'https://example.test/pull/41',
    },
  ],
  saturatedStates: [],
  inspectableAgents: [runningIdentifier, stalledIdentifier, retryingIdentifier],
  totals: { inputTokens: 20, outputTokens: 10, totalTokens: 30, secondsRunning: 120 },
  rateLimits: null,
})

const issue = (
  number: number,
  identifier: string,
  title: string,
  overrides: Partial<BacklogSnapshot['issues'][number]> = {},
): BacklogSnapshot['issues'][number] => ({
  number,
  identifier,
  title,
  url: `https://example.test/issues/${String(number)}`,
  labels: ['sloppenheimer'],
  priority: 2,
  createdAt: null,
  enabled: true,
  dispatchable: true,
  state: 'open',
  normalizedState: 'open',
  blockedBy: [],
  readiness: 'ready',
  reason: null,
  unlocks: 0,
  ...overrides,
})

const blocker = (
  number: number,
  identifier: string,
): BacklogSnapshot['issues'][number]['blockedBy'][number] => ({
  id: String(number),
  identifier: issueIdentifier(identifier),
  title: `Blocker ${String(number)}`,
  url: `https://example.test/issues/${String(number)}`,
  state: 'open',
})

export const consoleBacklog = (): BacklogSnapshot => {
  const issues = [
    issue(17, runningIdentifier, 'Operator console', { priority: 1 }),
    issue(21, stalledIdentifier, 'Silent agent', { priority: 2 }),
    issue(18, retryingIdentifier, 'Flaky dependency', { priority: 2 }),
    issue(30, awaitingIdentifier, 'Awaiting checks', { priority: 2 }),
    issue(31, repairIdentifier, 'Repair needed', { priority: 2 }),
    issue(32, interventionIdentifier, 'Needs intervention', { priority: 1 }),
    issue(50, readyTopIdentifier, 'Unblocks the most work', {
      priority: 1,
      unlocks: 8,
      labels: ['observability'],
      enabled: false,
    }),
    issue(52, readyMiddleIdentifier, 'Also urgent', {
      priority: 1,
      unlocks: 2,
      labels: ['observability'],
      enabled: false,
    }),
    issue(51, readyLastIdentifier, 'Nice to have', {
      priority: 3,
      unlocks: 5,
      labels: ['observability'],
      enabled: false,
    }),
    issue(60, blockedIdentifier, 'Waiting on a dependency', {
      priority: 3,
      dispatchable: false,
      readiness: 'blocked',
      reason: 'Waiting for example/sloppenheimer#50',
      blockedBy: [blocker(50, readyTopIdentifier)],
    }),
    issue(61, escalatedBlockedIdentifier, 'Urgent but blocked', {
      priority: 1,
      dispatchable: false,
      readiness: 'blocked',
      reason: 'Waiting for example/sloppenheimer#50',
      blockedBy: [blocker(50, readyTopIdentifier)],
    }),
    issue(70, cyclicIdentifier, 'First half of a cycle', {
      priority: 2,
      dispatchable: false,
      readiness: 'cyclic',
      reason:
        'Dependency cycle: example/sloppenheimer#70 → example/sloppenheimer#71 → example/sloppenheimer#70',
      blockedBy: [blocker(71, cyclicPartnerIdentifier)],
    }),
    issue(71, cyclicPartnerIdentifier, 'Second half of a cycle', {
      priority: 2,
      dispatchable: false,
      readiness: 'cyclic',
      reason:
        'Dependency cycle: example/sloppenheimer#71 → example/sloppenheimer#70 → example/sloppenheimer#71',
      blockedBy: [blocker(70, cyclicIdentifier)],
    }),
  ]
  return {
    controlLabel: 'sloppenheimer',
    issues,
    nodes: issues.map((entry) => ({
      identifier: entry.identifier,
      number: entry.number,
      title: entry.title,
      url: entry.url,
      state: entry.state,
      readiness: entry.readiness,
      reason: entry.reason,
      actionable: true,
    })),
    edges: [
      { blocker: readyTopIdentifier, dependent: blockedIdentifier },
      { blocker: readyTopIdentifier, dependent: escalatedBlockedIdentifier },
      { blocker: cyclicIdentifier, dependent: cyclicPartnerIdentifier },
      { blocker: cyclicPartnerIdentifier, dependent: cyclicIdentifier },
    ],
    cycles: [
      {
        members: [cyclicIdentifier, cyclicPartnerIdentifier],
        message:
          'Dependency cycle: example/sloppenheimer#70 → example/sloppenheimer#71 → example/sloppenheimer#70',
      },
    ],
  }
}
