import { it } from '@effect/vitest'
import { Exit, Fiber, MutableRef, Option } from 'effect'
import { describe, expect } from 'vitest'

import type { Workflow } from '@symphony/core/config/workflow.js'
import { issueId, issueIdentifier, type Issue, type IssueId } from '@symphony/core/domain/domain.js'
import { dispatchAdmission, hasSlot } from '@symphony/core/core/policy.js'
import {
  initialState,
  retainedCompletedDetails,
  type EffectiveWorkflow,
  type ExecutionSnapshot,
  type CompletedEntry,
  type RetryEntry,
  type RunningEntry,
  type RuntimeState,
} from '@symphony/core/core/state.js'
import * as Transitions from '@symphony/core/core/transitions.js'
import {
  createAgentDetailRecord,
  recordAgentEvent,
  recordAttemptStarted,
  type AgentDetailRecord,
  type AgentEvent,
} from '@symphony/core/telemetry.js'
import { stubProvider } from '../harness/stub-tracker-provider.js'

/**
 * These exercise the scheduler's transitions directly: no orchestrator, no mailbox, no ports. A
 * transition is a function from one state value to the next, so the whole test is a value in, a
 * value out, and an assertion about the difference.
 */

/** A fiber that has already finished. The transitions only ever hand one back to be interrupted. */
const settledFiber = Fiber.done(Exit.void)

const workflow: Workflow = {
  path: '/tmp/WORKFLOW.md',
  fingerprint: 'test',
  promptTemplate: 'test',
  tracker: stubProvider('token'),
  config: {
    tracker: {
      kind: 'stub',
      provider: { token: 'token' },
      requiredLabels: ['symphony'],
      activeStates: ['open'],
      terminalStates: ['closed'],
    },
    pollingIntervalMs: 30_000,
    workspaceRoot: '/tmp/symphony',
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 1,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: new Map(),
    },
    codex: {
      command: 'codex app-server',
      approvalPolicy: 'never',
      threadSandbox: 'workspace-write',
      turnSandboxPolicy: null,
      turnTimeoutMs: 60_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 30_000,
    },
    serverPort: null,
    extensions: {},
  },
}

const withAgentLimits = (
  maxConcurrentAgents: number,
  byState: ReadonlyMap<string, number> = new Map(),
): Workflow => ({
  ...workflow,
  config: {
    ...workflow.config,
    agent: {
      ...workflow.config.agent,
      maxConcurrentAgents,
      maxConcurrentAgentsByState: new Map(byState),
    },
  },
})

/**
 * The ports are never called by a transition, so the effective workflow only has to be a value of
 * the right shape. Reaching for one is what would make this an integration test.
 */
const unusedPorts = {
  tracker: { secretEnvironmentNames: [] },
  codeReview: Option.none(),
  workspaces: {},
} as unknown as Omit<EffectiveWorkflow, 'workflow' | 'loadedAt'>

const effective: EffectiveWorkflow = {
  ...unusedPorts,
  workflow,
  loadedAt: new Date('2026-01-01T00:00:00.000Z'),
}

const execution = {
  workflow,
  requiredLabels: workflow.config.tracker.requiredLabels,
  activeStates: workflow.config.tracker.activeStates,
  terminalStates: workflow.config.tracker.terminalStates,
  secretEnvironmentNames: [],
  workspaceRoot: workflow.config.workspaceRoot,
  prompt: '',
  agentRunner: workflow.config.codex,
  maxTurns: 1,
  stallTimeoutMs: 30_000,
  tracker: unusedPorts.tracker,
  codeReview: Option.none(),
  workspaces: unusedPorts.workspaces,
} as unknown as ExecutionSnapshot

const makeIssue = (identifier: string, state = 'open', labels = ['symphony']): Issue => ({
  id: issueId(identifier),
  nativeRef: null,
  identifier: issueIdentifier(identifier),
  title: identifier,
  description: null,
  priority: null,
  state,
  branchName: null,
  url: null,
  assigneeId: null,
  labels,
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
})

const emptyState = (): RuntimeState =>
  Transitions.finishStartupRecovery(
    initialState(effective, { handoffs: [], storeReadFailed: false, storeError: null }),
  )

const runningEntry = (issue: Issue, runId = 1): RunningEntry => ({
  runId,
  issue,
  fiber: settledFiber,
  execution,
  sessionPorts: MutableRef.make({
    tracker: execution.tracker,
    codeReview: Option.none(),
    sourceControl: null,
  }),
  attempt: null,
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  lastEventAt: null,
  lastEvent: null,
  lastMessage: null,
  processId: null,
  threadId: null,
  turnId: null,
  sessionId: null,
  turnCount: 0,
  turnActive: false,
  tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  lastReportedTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
})

const retryEntry = (issue: Issue, attempt: number): RetryEntry => ({
  issue,
  attempt,
  dueAt: 1_000,
  error: null,
  fiber: settledFiber,
})

const finishedWork = (issue: Issue): CompletedEntry => ({
  issueId: issue.id,
  identifier: issue.identifier,
  title: issue.title,
  url: null,
  outcome: 'merged',
  finishedAt: new Date('2026-01-02T00:00:00.000Z'),
  pullRequestUrl: 'https://example.test/pulls/7',
})

const detailFor = (issue: Issue): AgentDetailRecord =>
  createAgentDetailRecord({
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: null,
    attempt: null,
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    workspacePathKey: 'key',
    expectedBranch: 'symphony/branch',
    dispatchLabels: [],
  })

const agentEvent = (
  turnId: string | null,
  sessionId: string | null,
  turnCount: number,
  overrides: Partial<AgentEvent> = {},
): AgentEvent => ({
  event: 'item/agentMessage',
  timestamp: new Date('2026-01-01T00:00:05.000Z'),
  processId: 42,
  message: null,
  usage: null,
  rateLimits: null,
  threadId: 'thread-1',
  turnId,
  sessionId,
  turnCount,
  turnStatus: null,
  payload: { kind: 'session' },
  ...overrides,
})

/** The event that ends a turn, at a later instant than the activity that preceded it. */
const turnCompleted = (turnId: string, sessionId: string, turnCount: number): AgentEvent =>
  agentEvent(turnId, sessionId, turnCount, {
    event: 'turn/completed',
    turnStatus: 'completed',
    timestamp: new Date('2026-01-01T00:00:08.000Z'),
  })

describe('turn identity', (): void => {
  it('adopts the composed session id of the turn an event belongs to', (): void => {
    const entry = runningEntry(makeIssue('example/symphony#1'))

    const applied = Transitions.applyRunEvent(entry, agentEvent('turn-1', 'thread-1-turn-1', 1))

    expect(applied.turnId).toBe('turn-1')
    expect(applied.sessionId).toBe('thread-1-turn-1')
    expect(applied.turnCount).toBe(1)
  })

  it('takes the session id of a session-scoped event that carries no turn', (): void => {
    const entry = runningEntry(makeIssue('example/symphony#1'))

    const applied = Transitions.applyRunEvent(entry, agentEvent(null, 'thread-1', 0))

    expect(applied.turnId).toBeNull()
    expect(applied.sessionId).toBe('thread-1')
  })

  it('holds both surfaces on the current turn when a superseded turn reports late', (): void => {
    const issue = makeIssue('example/symphony#1')
    const turnTwo = agentEvent('turn-2', 'thread-1-turn-2', 2)
    const lateTurnOne = agentEvent('turn-1', 'thread-1-turn-1', 1)

    const entry = Transitions.applyRunEvent(
      Transitions.applyRunEvent(runningEntry(issue), turnTwo),
      lateTurnOne,
    )
    const detail = recordAgentEvent(recordAgentEvent(detailFor(issue), turnTwo), lateTurnOne)

    // The turn count already folded forward, so a session id from turn one here would report an
    // older turn's identity beside `turnNumber: 2` on `/api/v1/agents/...`.
    expect(entry.turnId).toBe('turn-2')
    expect(entry.sessionId).toBe('thread-1-turn-2')
    expect(entry.turnCount).toBe(2)
    expect(detail.turnId).toBe('turn-2')
    expect(detail.sessionId).toBe('thread-1-turn-2')
    expect(detail.turnCount).toBe(2)
  })

  it('retains one session summary per composed session id', (): void => {
    const issue = makeIssue('example/symphony#1')
    let detail = recordAgentEvent(detailFor(issue), agentEvent(null, 'thread-1', 0))

    // The thread is known before any turn runs, so the summary opened there is completed by the
    // first turn rather than left beside a second one describing the same stretch of work.
    expect(detail.sessions.map((session) => session.sessionId)).toEqual(['thread-1'])

    detail = recordAgentEvent(detail, agentEvent('turn-1', 'thread-1-turn-1', 1))

    expect(detail.sessions.map((session) => session.sessionId)).toEqual(['thread-1-turn-1'])
    expect(detail.sessions.at(-1)?.endedAt).toBeNull()

    detail = recordAgentEvent(detail, turnCompleted('turn-1', 'thread-1-turn-1', 1))

    // The turn's own completion ends its session, so the gap before the next turn starts — where a
    // continuation decides whether to run again — belongs to no session.
    expect(detail.sessions.at(-1)?.endedAt).toBe('2026-01-01T00:00:08.000Z')

    detail = recordAgentEvent(detail, agentEvent('turn-2', 'thread-1-turn-2', 2))

    // Each continuation turn is its own session, and the one it succeeds is closed rather than
    // left open beside it.
    expect(detail.sessions.map((session) => session.sessionId)).toEqual([
      'thread-1-turn-1',
      'thread-1-turn-2',
    ])
    expect(detail.sessions.at(0)?.endedAt).toBe('2026-01-01T00:00:08.000Z')
    expect(detail.sessions.at(-1)?.endedAt).toBeNull()
    expect(detail.sessions.every((session) => session.threadId === 'thread-1')).toBe(true)
    expect(detail.sessionId).toBe('thread-1-turn-2')
  })

  it('does not reopen or close a session for a superseded turn reporting late', (): void => {
    const issue = makeIssue('example/symphony#1')
    const running = recordAgentEvent(
      recordAgentEvent(detailFor(issue), agentEvent('turn-1', 'thread-1-turn-1', 1)),
      agentEvent('turn-2', 'thread-1-turn-2', 2),
    )

    const detail = recordAgentEvent(
      recordAgentEvent(running, agentEvent('turn-1', 'thread-1-turn-1', 1)),
      turnCompleted('turn-1', 'thread-1-turn-1', 1),
    )

    // Turn one's late completion names a session that is already history; the one running now is
    // still open.
    expect(detail.sessions.map((session) => session.sessionId)).toEqual([
      'thread-1-turn-1',
      'thread-1-turn-2',
    ])
    expect(detail.sessions.at(-1)?.endedAt).toBeNull()
  })

  it('records a superseded turn on the timeline against the turn that produced it', (): void => {
    const issue = makeIssue('example/symphony#1')
    const running = recordAgentEvent(
      recordAgentEvent(detailFor(issue), agentEvent('turn-1', 'thread-1-turn-1', 1)),
      agentEvent('turn-2', 'thread-1-turn-2', 2),
    )

    const detail = recordAgentEvent(running, turnCompleted('turn-1', 'thread-1-turn-1', 1))

    // The record has moved on, but the timeline is a log of what arrived: turn one's completion is
    // turn one's, not a `turn/completed` attributed to the turn still running.
    const last = detail.events.at(-1)
    expect(last).toMatchObject({
      event: 'turn/completed',
      turnId: 'turn-1',
      sessionId: 'thread-1-turn-1',
      turnNumber: 1,
    })
    expect(detail.turnId).toBe('turn-2')
    expect(detail.sessionId).toBe('thread-1-turn-2')
  })

  it('keeps one summary for a turn that reports activity after it completed', (): void => {
    const issue = makeIssue('example/symphony#1')
    const completed = recordAgentEvent(
      recordAgentEvent(detailFor(issue), agentEvent('turn-1', 'thread-1-turn-1', 1)),
      turnCompleted('turn-1', 'thread-1-turn-1', 1),
    )

    const detail = recordAgentEvent(completed, agentEvent('turn-1', 'thread-1-turn-1', 1))

    // The history is keyed on the composed id, so a trailing event for a session that already
    // ended does not start a second summary naming it.
    expect(detail.sessions.map((session) => session.sessionId)).toEqual(['thread-1-turn-1'])
    expect(detail.sessions.at(-1)?.endedAt).toBe('2026-01-01T00:00:08.000Z')
  })

  it('lets a new attempt start again at turn one after the count was reset', (): void => {
    const issue = makeIssue('example/symphony#1')
    const restarted = recordAttemptStarted(
      recordAgentEvent(detailFor(issue), agentEvent('turn-2', 'thread-1-turn-2', 2)),
      new Date('2026-01-01T00:00:10.000Z'),
      1,
    )

    const detail = recordAgentEvent(restarted, agentEvent('turn-1', 'thread-2-turn-1', 1))

    expect(detail.sessionId).toBe('thread-2-turn-1')
    expect(detail.turnCount).toBe(1)
  })
})

describe('claim lifecycle', (): void => {
  it('claims an issue and remembers its identifier for later detail requests', (): void => {
    const issue = makeIssue('example/symphony#1')

    const claimed = Transitions.claimIssue(emptyState(), issue)

    expect(claimed.claimed.has(issue.id)).toBe(true)
    expect(claimed.identifiers.get(issue.id)).toBe(issue.identifier)
  })

  it('releases a claim without forgetting the issue or counting it completed', (): void => {
    const issue = makeIssue('example/symphony#1')

    const released = Transitions.releaseClaim(Transitions.claimIssue(emptyState(), issue), issue.id)

    expect(released.claimed.has(issue.id)).toBe(false)
    expect(released.completed.has(issue.id)).toBe(false)
    expect(released.identifiers.get(issue.id)).toBe(issue.identifier)
  })

  it('gives up the claim and records completion in one step', (): void => {
    const issue = makeIssue('example/symphony#1')

    const completed = Transitions.completeIssue(
      Transitions.claimIssue(emptyState(), issue),
      issue.id,
      finishedWork(issue),
    )

    expect(completed.claimed.has(issue.id)).toBe(false)
    // Filed with what it finished as, not merely counted.
    expect(completed.completed.get(issue.id)).toMatchObject({
      identifier: issue.identifier,
      outcome: 'merged',
      pullRequestUrl: 'https://example.test/pulls/7',
    })
  })

  it('leaves the state it was given untouched', (): void => {
    const issue = makeIssue('example/symphony#1')
    const before = emptyState()

    Transitions.claimIssue(before, issue)

    expect(before.claimed.size).toBe(0)
    expect(before.identifiers.size).toBe(0)
  })
})

describe('dispatch admission', (): void => {
  const issue = makeIssue('example/symphony#1')

  it('admits an active, routable, unclaimed issue with a free slot', (): void => {
    expect(dispatchAdmission(emptyState(), issue, workflow)).toEqual({ _tag: 'Admit' })
  })

  it('refuses everything until startup recovery has finished', (): void => {
    const recovering = initialState(effective, {
      handoffs: [],
      storeReadFailed: false,
      storeError: null,
    })

    expect(dispatchAdmission(recovering, issue, workflow)).toEqual({
      _tag: 'Refuse',
      reason: 'recovering',
    })
  })

  it('refuses an issue this orchestrator already claimed', (): void => {
    const claimed = Transitions.claimIssue(emptyState(), issue)

    expect(dispatchAdmission(claimed, issue, workflow)).toEqual({
      _tag: 'Refuse',
      reason: 'claimed',
    })
  })

  it('refuses an issue whose number the operator paused', (): void => {
    const paused = Transitions.pauseIssueNumber(emptyState(), 1)

    expect(dispatchAdmission(paused, issue, workflow)).toEqual({
      _tag: 'Refuse',
      reason: 'paused',
    })
  })

  it('refuses an issue outside the active states', (): void => {
    expect(
      dispatchAdmission(emptyState(), makeIssue('example/symphony#2', 'closed'), workflow),
    ).toEqual({ _tag: 'Refuse', reason: 'inactive' })
  })

  it('refuses an issue missing a required label', (): void => {
    expect(
      dispatchAdmission(emptyState(), makeIssue('example/symphony#2', 'open', []), workflow),
    ).toEqual({ _tag: 'Refuse', reason: 'unroutable' })
  })

  it('refuses an issue when every agent slot is taken', (): void => {
    const busy = Transitions.beginRun(emptyState(), runningEntry(makeIssue('example/symphony#9')))

    expect(dispatchAdmission(busy, issue, withAgentLimits(1))).toEqual({
      _tag: 'Refuse',
      reason: 'no_slot',
    })
  })

  it('counts the per-state budget separately from the global one', (): void => {
    const busy = Transitions.beginRun(
      emptyState(),
      runningEntry(makeIssue('example/symphony#9', 'open')),
    )
    const limits = withAgentLimits(4, new Map([['open', 1]]))

    expect(hasSlot(busy, issue, limits)).toBe(false)
    expect(hasSlot(busy, makeIssue('example/symphony#3', 'triage'), limits)).toBe(true)
  })
})

describe('retry scheduling', (): void => {
  const issue = makeIssue('example/symphony#1')

  it('claims the issue and queues the retry together', (): void => {
    const [displaced, scheduled] = Transitions.scheduleRetry(emptyState(), retryEntry(issue, 1))

    expect(Option.isNone(displaced)).toBe(true)
    expect(scheduled.claimed.has(issue.id)).toBe(true)
    expect(scheduled.retries.get(issue.id)?.attempt).toBe(1)
  })

  it('hands back the retry it displaced so its timer can be interrupted', (): void => {
    const [, first] = Transitions.scheduleRetry(emptyState(), retryEntry(issue, 1))

    const [displaced, second] = Transitions.scheduleRetry(first, retryEntry(issue, 2))

    expect(Option.getOrNull(displaced)?.attempt).toBe(1)
    expect(second.retries.get(issue.id)?.attempt).toBe(2)
  })

  it('takes a due retry only for the attempt that came due', (): void => {
    const [, scheduled] = Transitions.scheduleRetry(emptyState(), retryEntry(issue, 2))

    const [stale, unchanged] = Transitions.takeDueRetry(scheduled, issue.id, 1)
    const [due, drained] = Transitions.takeDueRetry(scheduled, issue.id, 2)

    expect(Option.isNone(stale)).toBe(true)
    expect(unchanged.retries.has(issue.id)).toBe(true)
    expect(Option.getOrNull(due)?.attempt).toBe(2)
    expect(drained.retries.has(issue.id)).toBe(false)
  })
})

describe('run lifecycle', (): void => {
  const issue = makeIssue('example/symphony#1')

  it('ends only the run the caller means', (): void => {
    const started = Transitions.beginRun(emptyState(), runningEntry(issue, 7))

    const [superseded, kept] = Transitions.endRun(started, issue.id, 6)
    const [ended, cleared] = Transitions.endRun(started, issue.id, 7)

    expect(Option.isNone(superseded)).toBe(true)
    expect(kept.running.has(issue.id)).toBe(true)
    expect(Option.getOrNull(ended)?.runId).toBe(7)
    expect(cleared.running.has(issue.id)).toBe(false)
  })

  it('folds an ended run into the lifetime totals', (): void => {
    const entry: RunningEntry = {
      ...runningEntry(issue),
      tokens: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    }

    const accounted = Transitions.accountEndedRun(
      emptyState(),
      entry,
      entry.startedAt.getTime() + 2_000,
    )

    expect(accounted.totals).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
      secondsRunning: 2,
    })
  })

  it('never lowers the counters of a run when late usage arrives', (): void => {
    const entry: RunningEntry = {
      ...runningEntry(issue),
      tokens: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    }
    const reported = Transitions.recordPendingUsage(emptyState(), issue.id, {
      inputTokens: 4,
      outputTokens: 12,
      totalTokens: 16,
    })

    const [settled, drained] = Transitions.applyPendingTelemetry(reported, issue.id, entry)

    expect(settled.tokens).toEqual({ inputTokens: 10, outputTokens: 12, totalTokens: 20 })
    expect(settled.lastReportedTokens).toEqual({
      inputTokens: 4,
      outputTokens: 12,
      totalTokens: 16,
    })
    expect(drained.pendingUsage.has(issue.id)).toBe(false)
  })
})

describe('tick debounce', (): void => {
  it('enqueues the first request and coalesces the rest into it', (): void => {
    const [first, queued] = Transitions.requestTick(emptyState(), 'startup')
    const [second, still] = Transitions.requestTick(queued, 'timer')

    expect(first.enqueue).toBe(true)
    expect(first.scheduled).toBe(true)
    expect(second.enqueue).toBe(false)
    expect(second.scheduled).toBe(false)
    expect(still.tickQueued).toBe(true)
    expect(still.followUpRequested).toBe(false)
  })

  it('owes a follow-up pass when a change lands during a poll', (): void => {
    const [, queued] = Transitions.requestTick(emptyState(), 'startup')
    const polling = Transitions.beginPoll(queued)

    const [decision, owed] = Transitions.requestTick(polling, 'change')
    const [second, still] = Transitions.requestTick(owed, 'change')

    expect(decision.enqueue).toBe(false)
    expect(owed.followUpRequested).toBe(true)
    // The change that first asks for the follow-up brings that pass into being; a later one only
    // joins it, which is the difference a refresh acknowledgement reports as `coalesced`.
    expect(decision.scheduled).toBe(true)
    expect(second.scheduled).toBe(false)
    expect(still.followUpRequested).toBe(true)
  })

  it('keeps the tick queued for the follow-up, and drains it otherwise', (): void => {
    const [, queued] = Transitions.requestTick(emptyState(), 'startup')
    const [, owed] = Transitions.requestTick(Transitions.beginPoll(queued), 'change')

    const [followingUp, carried] = Transitions.finishPoll(owed)
    const [settling, drained] = Transitions.finishPoll(Transitions.beginPoll(queued))

    expect(followingUp.followUp).toBe(true)
    expect(carried.tickQueued).toBe(true)
    expect(carried.followUpRequested).toBe(false)
    expect(settling.followUp).toBe(false)
    expect(drained.tickQueued).toBe(false)
  })

  it('does not owe a follow-up for a timer that fires during a poll', (): void => {
    const [, queued] = Transitions.requestTick(emptyState(), 'startup')

    const [decision, observed] = Transitions.requestTick(Transitions.beginPoll(queued), 'timer')

    expect(observed.followUpRequested).toBe(false)
    expect(decision.scheduled).toBe(false)
  })
})

describe('detail publication', (): void => {
  const issue = makeIssue('example/symphony#1')

  it('publishes a live run as running and a finished one as completed', (): void => {
    const withDetail = Transitions.putDetail(
      Transitions.claimIssue(emptyState(), issue),
      issue.id,
      detailFor(issue),
    )

    const running = Transitions.publishDetails(
      Transitions.beginRun(withDetail, runningEntry(issue)),
    )
    const finished = Transitions.publishDetails(withDetail)

    const live = running.publishedDetails.get(issue.identifier)
    expect(live?._tag).toBe('Found')
    expect(live?._tag === 'Found' ? live.context.status : null).toBe('running')
    const done = finished.publishedDetails.get(issue.identifier)
    expect(done?._tag === 'Found' ? done.context.status : null).toBe('completed')
    expect(finished.finishedDetails).toEqual([issue.id])
  })

  it('answers a claimed issue with no session as still starting', (): void => {
    const published = Transitions.publishDetails(Transitions.claimIssue(emptyState(), issue))

    expect(published.publishedDetails.get(issue.identifier)).toEqual({
      _tag: 'Unavailable',
      reason: 'The agent session is still starting',
    })
  })

  it('keeps an aged-out record answering as completed rather than as never run', (): void => {
    let state = emptyState()
    const issues = Array.from({ length: retainedCompletedDetails + 1 }, (_, index) =>
      makeIssue(`example/symphony#${String(index + 1)}`),
    )
    for (const candidate of issues) {
      state = Transitions.putDetail(
        Transitions.claimIssue(state, candidate),
        candidate.id,
        detailFor(candidate),
      )
    }

    const published = Transitions.publishDetails(state)

    const evicted = issues[0] as Issue
    expect(published.details.has(evicted.id)).toBe(false)
    expect(published.agedOutDetails.has(evicted.id)).toBe(true)
    expect(published.publishedDetails.get(evicted.identifier)).toEqual({ _tag: 'Completed' })
    expect(published.finishedDetails.length).toBe(retainedCompletedDetails)
  })

  it('is idempotent, so publishing twice cannot evict twice', (): void => {
    const withDetail = Transitions.putDetail(emptyState(), issue.id, detailFor(issue))

    const once = Transitions.publishDetails(withDetail)
    const twice = Transitions.publishDetails(once)

    expect(twice.finishedDetails).toEqual(once.finishedDetails)
    expect(twice.details.size).toBe(once.details.size)
  })
})

describe('handoff bookkeeping', (): void => {
  it('drops the handoff, completes the issue, and releases the claim together', (): void => {
    const issue = makeIssue('example/symphony#1')
    const id: IssueId = issue.id
    const held = Transitions.putHandoff(emptyState(), id, {
      issue,
      execution,
      pullRequestNumber: 7,
      pullRequestUrl: 'https://example.test/pulls/7',
      branchName: 'symphony/branch',
      state: 'awaiting_checks',
      headSha: 'abc',
      reason: null,
      repairHeadShas: [],
      repairObservedHeadShas: [],
      repair: Option.none(),
      reviewRequestedHeadSha: null,
      reviewCompletedHeadSha: null,
      observedAt: new Date('2026-01-01T00:00:00.000Z'),
    })

    expect(Transitions.handoffSnapshots(held).map((snapshot) => snapshot.issueId)).toEqual([id])
    expect(held.claimed.has(id)).toBe(true)

    const completed = Transitions.completeHandoff(held, id, finishedWork(issue))

    expect(completed.handoffs.has(id)).toBe(false)
    expect(completed.completed.get(id)?.outcome).toBe('merged')
    expect(completed.claimed.has(id)).toBe(false)
    expect(Transitions.handoffSnapshots(completed)).toEqual([])
  })
})
