import { describe, expect, it } from 'vitest'

import { issueId, issueIdentifier } from '../src/domain.js'
import { bound, commandSummary, makeRedactor, redact } from '../src/redaction.js'
import {
  buildAgentDetail,
  clientPayload,
  createAgentDetailRecord,
  normalizePayload,
  qualityPhaseOf,
  recordAgentEvent,
  recordAttemptStarted,
  recordCancellation,
  recordHandoff,
  recordRetryScheduled,
  retainedAttemptLimit,
  timelineEventLimit,
  type AgentDetailRecord,
  type AgentDetailSnapshot,
  type AgentEvent,
  type AgentEventPayload,
} from '../src/telemetry.js'

const startedAt = new Date('2026-08-30T10:00:00.000Z')

const makeRecord = (): AgentDetailRecord =>
  createAgentDetailRecord({
    issueId: issueId('34'),
    identifier: issueIdentifier('example/symphony#34'),
    title: 'Live agent inspection',
    url: 'https://example.test/issues/34',
    attempt: null,
    startedAt,
    workspacePathKey: 'example_symphony_34',
    expectedBranch: 'symphony/issue-34',
    dispatchLabels: ['symphony'],
  })

const event = (payload: AgentEventPayload, overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  event: 'item/completed',
  timestamp: new Date('2026-08-30T10:00:05.000Z'),
  processId: 4242,
  message: null,
  usage: null,
  rateLimits: null,
  threadId: 'thread-1',
  turnId: 'turn-1',
  sessionId: 'thread-1:turn-1',
  turnCount: 1,
  turnStatus: null,
  payload,
  ...overrides,
})

const snapshotOf = (
  record: AgentDetailRecord,
  now = new Date('2026-08-30T10:00:30.000Z'),
): AgentDetailSnapshot =>
  buildAgentDetail(record, {
    self: '/api/v1/agents/example%2Fsymphony%2334',
    now,
    status: 'running',
    stallTimeoutMs: 60_000,
    workerHost: 'local',
    branch: 'symphony/issue-34',
    retry: null,
  })

describe('field-level redaction', (): void => {
  it('removes credentials by shape wherever they appear', (): void => {
    const samples = [
      'cloning with github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz012345',
      'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.012345',
      'git remote add origin https://octocat:hunter2secret@github.com/example/symphony.git',
      'GET /repos?access_token=abcdefghijklmnop&per_page=100',
      'AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
      'aws key AKIAIOSFODNN7EXAMPLE rejected',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
    ]

    for (const sample of samples) {
      // Every sample loses its credential; a PEM block is replaced whole, with its own marker.
      expect(redact(sample)).toMatch(/\[REDACTED( PEM PRIVATE KEY)?\]/u)
    }
    expect(redact(samples[7] ?? '')).toBe('[REDACTED PEM PRIVATE KEY]')
    expect(redact(samples[1] ?? '')).toBe('export OPENAI_API_KEY=[REDACTED]')
    expect(redact(samples[3] ?? '')).toBe(
      'git remote add origin https://[REDACTED]@github.com/example/symphony.git',
    )
    expect(redact('nothing secret about pnpm check')).toBe('nothing secret about pnpm check')
  })

  it('removes the resolved values of the environment variables the host treats as secret', (): void => {
    const redactor = makeRedactor(['s3cret-token-value', 'x'])

    expect(redactor('used s3cret-token-value twice: s3cret-token-value')).toBe(
      'used [REDACTED] twice: [REDACTED]',
    )
    // A value too short to be distinctive is left alone rather than corrupting unrelated text.
    expect(redactor('an x marks the spot')).toBe('an x marks the spot')
  })

  it('bounds oversized text and reports the truncation', (): void => {
    const long = 'a'.repeat(5_000)

    expect(bound(long)).toEqual({ text: 'a'.repeat(240), truncated: true })
    expect(bound('short')).toEqual({ text: 'short', truncated: false })
  })

  it('reduces a command to its program and argument count', (): void => {
    expect(commandSummary('pnpm check --filter core')).toEqual({
      program: 'pnpm',
      argumentCount: 3,
    })
    expect(commandSummary(['/usr/bin/git', 'commit', '-m', 'token=abcdefghijklmnop'])).toEqual({
      program: 'git',
      argumentCount: 3,
    })
    expect(commandSummary('bash -lc "pnpm test"').program).toBe('pnpm')
  })
})

describe('protocol normalization', (): void => {
  it('keeps only counts for tool input and output', (): void => {
    const payload = normalizePayload('item/completed', {
      item: {
        type: 'mcpToolCall',
        name: 'search',
        status: 'completed',
        input: { query: 'ghp_abcdefghijklmnopqrstuvwxyz012345' },
        output: { rows: [1, 2, 3] },
      },
    })

    expect(payload).toMatchObject({ kind: 'tool', name: 'search', state: 'completed' })
    expect(JSON.stringify(payload)).not.toContain('ghp_')
    expect(JSON.stringify(payload)).not.toContain('query')
  })

  it('never retains reasoning content', (): void => {
    const payload = normalizePayload('item/completed', {
      item: { type: 'reasoning', text: 'the private chain of thought' },
    })

    expect(payload).toEqual({ kind: 'reasoning' })
    expect(JSON.stringify(payload)).not.toContain('private')
  })

  it('redacts and bounds agent messages', (): void => {
    const payload = normalizePayload('item/completed', {
      item: {
        type: 'agentMessage',
        text: `pushed with github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz012345 ${'x'.repeat(500)}`,
      },
    })

    expect(payload).toMatchObject({ kind: 'message', role: 'assistant', truncated: true })
    expect(JSON.stringify(payload)).toContain('[REDACTED]')
    expect(JSON.stringify(payload)).not.toContain('github_pat_')
  })

  it('summarizes commands, file changes, usage, and errors', (): void => {
    expect(
      normalizePayload('item/started', {
        item: { type: 'commandExecution', command: 'pnpm lint --fix', status: 'in_progress' },
      }),
    ).toEqual({
      kind: 'command',
      program: 'pnpm',
      argumentCount: 2,
      quality: 'lint',
      state: 'started',
      exitCode: null,
      durationMs: null,
    })
    expect(
      normalizePayload('item/completed', {
        item: {
          type: 'fileChange',
          path: '/home/agent/work/src/telemetry.ts',
          kind: 'updated',
          addedLines: 12,
          deletedLines: 3,
        },
      }),
    ).toEqual({
      kind: 'file',
      path: 'work/src/telemetry.ts',
      change: 'update',
      addedLines: 12,
      deletedLines: 3,
    })
    // Token totals and rate limits are extracted once, by the client, and arrive on the event
    // itself; the payload for such a method carries nothing that would compete with them.
    expect(
      normalizePayload('turn/usage', {
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      }),
    ).toEqual({ kind: 'session' })
    expect(
      normalizePayload('item/completed', { item: { type: 'error', message: 'boom' } }),
    ).toEqual({ kind: 'error', severity: 'error', code: null, message: 'boom', truncated: false })
  })

  it('degrades an unrecognized message to its method name alone', (): void => {
    const payload = normalizePayload('vendor/unknown', {
      prompt: 'the full rendered prompt that must never be retained',
    })

    expect(payload).toEqual({ kind: 'none' })
  })

  it('classifies client-side notices without treating them as session failures', (): void => {
    expect(clientPayload('session_started', 'https://example.test/issues/34')).toEqual({
      kind: 'session',
    })
    expect(clientPayload('diagnostic', 'warning: token=abcdefghijklmnop')).toMatchObject({
      kind: 'error',
      severity: 'warning',
      code: 'diagnostic',
    })
    expect(JSON.stringify(clientPayload('diagnostic', 'token=abcdefghijklmnop'))).toContain(
      '[REDACTED]',
    )
    expect(qualityPhaseOf('pnpm run typecheck')).toBe('typecheck')
    expect(qualityPhaseOf('ls -la')).toBeNull()
  })
})

describe('agent detail records', (): void => {
  it('preserves order and bounds retention', (): void => {
    const record = makeRecord()
    for (let index = 0; index < timelineEventLimit + 25; index += 1) {
      recordAgentEvent(
        record,
        event(
          {
            kind: 'command',
            program: 'pnpm',
            argumentCount: index,
            quality: null,
            state: 'started',
            exitCode: null,
            durationMs: null,
          },
          { timestamp: new Date(startedAt.getTime() + index * 1_000) },
        ),
      )
    }
    const snapshot = snapshotOf(record)
    const sequences = snapshot.timeline.events.map((entry) => entry.sequence)

    expect(snapshot.timeline.retained).toBe(timelineEventLimit)
    expect(snapshot.timeline.dropped).toBe(25)
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right))
    expect(sequences.at(0)).toBe(26)
    expect(sequences.at(-1)).toBe(timelineEventLimit + 25)
  })

  it('separates attempts while keeping one rising sequence and the session identity', (): void => {
    const record = makeRecord()
    recordAgentEvent(record, event({ kind: 'session' }))
    recordRetryScheduled(
      record,
      new Date('2026-08-30T10:00:10.000Z'),
      1,
      new Date('2026-08-30T10:00:20.000Z'),
      'agent stalled',
    )
    recordAttemptStarted(record, new Date('2026-08-30T10:00:20.000Z'), 1)
    recordAgentEvent(
      record,
      event({ kind: 'reasoning' }, { turnId: 'turn-2', sessionId: 'thread-1', turnCount: 2 }),
    )
    const snapshot = snapshotOf(record, new Date('2026-08-30T10:00:40.000Z'))

    expect(snapshot.timeline.events.map((entry) => [entry.attempt, entry.category])).toEqual([
      [0, 'session'],
      [0, 'retry'],
      [1, 'session'],
      [1, 'reasoning'],
    ])
    expect(snapshot.attempt.current).toBe(1)
    expect(snapshot.attempt.retries).toBe(1)
    expect(snapshot.attempt.attempts.map((attempt) => attempt.outcome)).toEqual([
      'retrying',
      'running',
    ])
    expect(snapshot.identity.sessionId).toBe('thread-1')
    expect(snapshot.identity.threadId).toBe('thread-1')
    expect(snapshot.identity.turnNumber).toBe(2)
  })

  it('aggregates workspace diagnostics without retaining file contents', (): void => {
    const record = makeRecord()
    recordAgentEvent(
      record,
      event({
        kind: 'file',
        path: 'src/telemetry.ts',
        change: 'update',
        addedLines: 10,
        deletedLines: 2,
      }),
    )
    recordAgentEvent(
      record,
      event(
        { kind: 'file', path: 'src/server.ts', change: 'add', addedLines: 5, deletedLines: 0 },
        { timestamp: new Date('2026-08-30T10:00:07.000Z') },
      ),
    )
    recordAgentEvent(
      record,
      event({
        kind: 'command',
        program: 'pnpm',
        argumentCount: 1,
        quality: 'check',
        state: 'completed',
        exitCode: 0,
        durationMs: 900,
      }),
    )
    const snapshot = snapshotOf(record)

    expect(snapshot.workspace).toMatchObject({
      pathKey: 'example_symphony_34',
      branch: 'symphony/issue-34',
      dirtyFileCount: 2,
      addedLines: 15,
      deletedLines: 2,
      lastFileActivityAt: '2026-08-30T10:00:07.000Z',
      qualityPhase: 'check',
      qualityCommandState: 'completed',
      pathsTruncated: false,
    })
  })

  it('leaves the running phase when a tool or command finishes', (): void => {
    const record = makeRecord()
    recordAgentEvent(
      record,
      event({
        kind: 'command',
        program: 'pnpm',
        argumentCount: 1,
        quality: 'check',
        state: 'started',
        exitCode: null,
        durationMs: null,
      }),
    )
    expect(snapshotOf(record).phase).toMatchObject({
      phase: 'running_command',
      operation: 'Running pnpm',
    })

    recordAgentEvent(
      record,
      event(
        {
          kind: 'command',
          program: 'pnpm',
          argumentCount: 1,
          quality: 'check',
          state: 'completed',
          exitCode: 0,
          durationMs: 900,
        },
        { timestamp: new Date('2026-08-30T10:00:08.000Z') },
      ),
    )
    expect(snapshotOf(record).phase).toMatchObject({
      phase: 'awaiting_model',
      operation: 'Finished pnpm (exit 0)',
    })

    recordAgentEvent(
      record,
      event(
        { kind: 'tool', name: 'search', state: 'completed', inputBytes: 12, outputBytes: 34 },
        { timestamp: new Date('2026-08-30T10:00:09.000Z') },
      ),
    )
    expect(snapshotOf(record).phase).toMatchObject({
      phase: 'awaiting_model',
      operation: 'Finished search',
    })

    recordAgentEvent(
      record,
      event(
        { kind: 'tool', name: 'search', state: 'started', inputBytes: 12, outputBytes: null },
        { timestamp: new Date('2026-08-30T10:00:10.000Z') },
      ),
    )
    expect(snapshotOf(record).phase.phase).toBe('running_tool')
  })

  it('counts every retry, including attempts older than the retained summaries', (): void => {
    const record = makeRecord()
    const total = retainedAttemptLimit + 5
    for (let attempt = 1; attempt <= total; attempt += 1) {
      recordRetryScheduled(
        record,
        new Date(startedAt.getTime() + attempt * 2_000),
        attempt,
        new Date(startedAt.getTime() + attempt * 2_000 + 1_000),
        'turn failed',
      )
      recordAttemptStarted(record, new Date(startedAt.getTime() + attempt * 2_000 + 1_000), attempt)
    }
    const snapshot = snapshotOf(record, new Date(startedAt.getTime() + 120_000))

    expect(snapshot.attempt.current).toBe(total)
    expect(snapshot.attempt.retries).toBe(total)
    // The summaries stay bounded even though the count does not.
    expect(snapshot.attempt.attempts).toHaveLength(retainedAttemptLimit)
  })

  it('reports the stall deadline, countdown, and stalled phase from the last activity', (): void => {
    const record = makeRecord()
    recordAgentEvent(record, event({ kind: 'reasoning' }))

    const live = snapshotOf(record, new Date('2026-08-30T10:00:35.000Z'))
    expect(live.activity).toMatchObject({
      lastActivityAt: '2026-08-30T10:00:05.000Z',
      idleMs: 30_000,
      stallDeadline: '2026-08-30T10:01:05.000Z',
      stallCountdownMs: 30_000,
      stalled: false,
    })
    expect(live.phase.phase).toBe('reasoning')

    const late = snapshotOf(record, new Date('2026-08-30T10:02:05.000Z'))
    expect(late.activity.stalled).toBe(true)
    expect(late.activity.stallCountdownMs).toBe(0)
    expect(late.phase.phase).toBe('stalled')
  })

  it('keeps an attempt that is retried out of the handed-off outcome', (): void => {
    const record = makeRecord()
    recordAgentEvent(record, event({ kind: 'reasoning' }))
    // The worker finished, but there was no branch to hand off, so the session continues.
    recordHandoff(record, new Date('2026-08-30T10:00:10.000Z'), {
      step: 'remote_branch',
      status: 'absent',
      message: 'No remote branch symphony/issue-34 exists yet; continuing the session',
      remoteBranch: 'symphony/issue-34',
      outcome: 'no_branch',
    })
    recordRetryScheduled(
      record,
      new Date('2026-08-30T10:00:11.000Z'),
      1,
      new Date('2026-08-30T10:00:12.000Z'),
      null,
    )
    const continued = snapshotOf(record, new Date('2026-08-30T10:00:12.000Z'))

    expect(continued.attempt.attempts.map((attempt) => attempt.outcome)).toEqual(['retrying'])
    expect(continued.attempt.attempts.at(-1)?.endedAt).toBe('2026-08-30T10:00:11.000Z')

    // A cancellation followed by a retry is the same story: the retry is the later, more specific
    // account of how that attempt ended.
    const cancelled = makeRecord()
    recordCancellation(cancelled, new Date('2026-08-30T10:00:10.000Z'), 'the agent stalled')
    recordRetryScheduled(
      cancelled,
      new Date('2026-08-30T10:00:11.000Z'),
      1,
      new Date('2026-08-30T10:00:21.000Z'),
      'agent stalled',
    )

    expect(
      snapshotOf(cancelled, new Date('2026-08-30T10:00:12.000Z')).attempt.attempts.map(
        (attempt) => attempt.outcome,
      ),
    ).toEqual(['retrying'])
  })

  it('tracks handoff progress and cancellation as explicit timeline steps', (): void => {
    const record = makeRecord()
    recordHandoff(record, new Date('2026-08-30T10:01:00.000Z'), {
      step: 'remote_branch',
      status: 'observed',
      message: 'Remote branch symphony/issue-34 is present',
      remoteBranch: 'symphony/issue-34',
    })
    recordHandoff(record, new Date('2026-08-30T10:01:01.000Z'), {
      step: 'pull_request',
      status: 'observed',
      message: 'Opened a pull request for the completed work',
      pullRequest: {
        status: 'created',
        number: 61,
        url: 'https://example.test/pull/61',
        state: 'awaiting_checks',
      },
      outcome: 'pull_request_open',
    })
    recordCancellation(
      record,
      new Date('2026-08-30T10:01:02.000Z'),
      'the operator paused the issue',
    )
    const snapshot = snapshotOf(record, new Date('2026-08-30T10:01:03.000Z'))

    expect(snapshot.handoff).toMatchObject({
      expectedBranch: 'symphony/issue-34',
      remoteBranch: { status: 'observed', name: 'symphony/issue-34' },
      pullRequest: { status: 'created', number: 61, url: 'https://example.test/pull/61' },
      dispatchLabels: { labels: ['symphony'], status: 'not_performed' },
      outcome: 'pull_request_open',
    })
    expect(snapshot.timeline.events.map((entry) => entry.category)).toEqual([
      'handoff',
      'handoff',
      'cancellation',
    ])
    expect(snapshot.phase.phase).toBe('cancelled')
  })

  it('publishes frozen snapshots that cannot be edited by a consumer', (): void => {
    const record = makeRecord()
    recordAgentEvent(record, event({ kind: 'reasoning' }))
    const snapshot = snapshotOf(record)

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.timeline.events)).toBe(true)
    // Elements too: freezing only the arrays would leave each element shared with the actor's own
    // record, so an edit in place would be carried forward by the next actor update.
    expect(snapshot.timeline.events.every((entry) => Object.isFrozen(entry))).toBe(true)
    expect(snapshot.attempt.attempts.every((attempt) => Object.isFrozen(attempt))).toBe(true)
    expect(snapshot.errors.every((error) => Object.isFrozen(error))).toBe(true)
    const events = snapshot.timeline.events as unknown as { push: (value: unknown) => number }
    expect(() => events.push('tampered')).toThrow()
  })
})
