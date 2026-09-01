import { describe, expect, it } from 'vitest'

import { issueId, issueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import {
  bound,
  commandSummary,
  makeRedactor,
  redact,
} from '@sloppenheimer/core/support/redaction.js'
import { clientPayload, normalizePayload } from '@sloppenheimer/adapter-codex/payload.js'
import {
  buildAgentDetail,
  createAgentDetailRecord,
  qualityPhaseOf,
  recordAgentEvent,
  recordAttemptStarted,
  recordCancellation,
  recordHandoff,
  recordRetryScheduled,
  changedPathLimit,
  retainedAttemptLimit,
  timelineEventLimit,
  type AgentDetailRecord,
  type AgentDetailSnapshot,
  type AgentEvent,
  type AgentEventPayload,
} from '@sloppenheimer/core/telemetry.js'

const startedAt = new Date('2026-08-30T10:00:00.000Z')

const makeRecord = (): AgentDetailRecord =>
  createAgentDetailRecord({
    issueId: issueId('34'),
    identifier: issueIdentifier('example/sloppenheimer#34'),
    title: 'Live agent inspection',
    url: 'https://example.test/issues/34',
    attempt: null,
    startedAt,
    workspacePathKey: 'example_sloppenheimer_34',
    expectedBranch: 'sloppenheimer/issue-34',
    dispatchLabels: ['sloppenheimer'],
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
  lifecycle: null,
  payload,
  ...overrides,
})

const snapshotOf = (
  record: AgentDetailRecord,
  now = new Date('2026-08-30T10:00:30.000Z'),
): AgentDetailSnapshot =>
  buildAgentDetail(record, {
    self: '/api/v1/agents/example%2Fsloppenheimer%2334',
    now,
    status: 'running',
    stallTimeoutMs: 60_000,
    workerHost: 'local',
    handoffEnabled: true,
    branch: 'sloppenheimer/issue-34',
    retry: null,
  })

describe('field-level redaction', (): void => {
  it('removes credentials by shape wherever they appear', (): void => {
    const samples = [
      'cloning with github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz012345',
      'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.012345',
      'git remote add origin https://octocat:hunter2secret@github.com/example/sloppenheimer.git',
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
      'git remote add origin https://[REDACTED]@github.com/example/sloppenheimer.git',
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

  it('applies the session redactor to a command program name', (): void => {
    const redactor = makeRedactor(['s3cret-token-value'])

    // A configured secret has no distinguishing shape, so only the session's own redactor can
    // remove it — including from the one command word that is retained.
    expect(commandSummary('s3cret-token-value --flag', redactor)).toEqual({
      program: '[REDACTED]',
      argumentCount: 1,
    })
    expect(
      normalizePayload(
        'item/started',
        { item: { type: 'commandExecution', command: 's3cret-token-value run' } },
        redactor,
      ),
    ).toMatchObject({ kind: 'command', program: '[REDACTED]' })
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
      state: 'completed',
      files: [{ path: 'work/src/telemetry.ts', change: 'update', addedLines: 12, deletedLines: 3 }],
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

  it('reads the same item under either casing the protocol reports it in', (): void => {
    // The App Server reports these fields as `item_type`/`exit_code` on one build and
    // `itemType`/`exitCode` on another. The schema layer answers that once, so both spellings
    // produce the identical payload.
    expect(
      normalizePayload('item/completed', {
        item: {
          item_type: 'commandExecution',
          command: ['pnpm', 'test'],
          status: 'completed',
          exit_code: 0,
          duration_ms: 1_200,
        },
      }),
    ).toEqual({
      kind: 'command',
      program: 'pnpm',
      argumentCount: 1,
      quality: 'test',
      state: 'completed',
      exitCode: 0,
      durationMs: 1_200,
    })
    expect(
      normalizePayload('item/completed', {
        item: {
          type: 'fileChange',
          changes: [
            { file_path: '/home/agent/work/src/telemetry.ts', kind: 'added', added_lines: 4 },
          ],
        },
      }),
    ).toEqual({
      kind: 'file',
      state: 'completed',
      files: [{ path: 'work/src/telemetry.ts', change: 'add', addedLines: 4, deletedLines: null }],
    })
  })

  it('reads every file a patch item changed and counts its lines from the diff', (): void => {
    // The App Server's `fileChange` item is `{id, changes, status}`, where `changes` lists every
    // file the patch touched as `{path, kind, diff}` and no entry carries a line count at all.
    // Reading only the first entry lost the rest of a multi-file patch, and waiting for a count
    // the protocol never sends left the workspace summary reporting no lines however much the
    // agent wrote.
    const payload = normalizePayload('item/completed', {
      item: {
        id: 'item_3',
        type: 'fileChange',
        status: 'completed',
        changes: [
          {
            path: '/home/agent/work/src/telemetry.ts',
            kind: 'update',
            diff: [
              '--- a/src/telemetry.ts',
              '+++ b/src/telemetry.ts',
              '@@ -1,4 +1,5 @@',
              ' const kept = 1',
              '-const removed = 2',
              '+const added = 2',
              '+const alsoAdded = 3',
            ].join('\n'),
          },
          {
            path: '/home/agent/work/src/server.ts',
            kind: 'add',
            diff: [
              '--- /dev/null',
              '+++ b/src/server.ts',
              '@@ -0,0 +1 @@',
              '+export const serve = (): null => null',
            ].join('\n'),
          },
          { path: '/home/agent/work/docs/README.md', kind: 'delete' },
        ],
      },
    })

    expect(payload).toEqual({
      kind: 'file',
      state: 'completed',
      files: [
        { path: 'work/src/telemetry.ts', change: 'update', addedLines: 2, deletedLines: 1 },
        { path: 'work/src/server.ts', change: 'add', addedLines: 1, deletedLines: 0 },
        // A change carrying no diff reports no counts, which is a different reading from a change
        // that touched no lines.
        { path: 'work/docs/README.md', change: 'delete', addedLines: null, deletedLines: null },
      ],
    })
    // A diff is file content: it is counted and dropped, never retained.
    expect(JSON.stringify(payload)).not.toContain('alsoAdded')
  })

  it('counts a content line that begins with the characters a file header does', (): void => {
    // `+++counter` is an added line whose own text begins with `++`, not a header. Skipping every
    // line with those three characters undercounts the patch by exactly the lines most likely to
    // be diff-like themselves.
    expect(
      normalizePayload('item/completed', {
        item: {
          type: 'fileChange',
          status: 'completed',
          changes: [
            {
              path: '/home/agent/work/src/counter.ts',
              kind: 'update',
              diff: [
                'diff --git a/src/counter.ts b/src/counter.ts',
                '--- a/src/counter.ts',
                '+++ b/src/counter.ts',
                '@@ -1,2 +1,2 @@',
                '---counter',
                '+++counter',
                ' const kept = 1',
              ].join('\n'),
            },
          ],
        },
      }),
    ).toEqual({
      kind: 'file',
      state: 'completed',
      files: [{ path: 'work/src/counter.ts', change: 'update', addedLines: 1, deletedLines: 1 }],
    })
  })

  it('counts a headerless fragment as the content it is', (): void => {
    // A fragment carrying no hunk marker is all content, and content wears both the characters and
    // the separator a header does: `++ heading` arrives as `+++ heading`. Only a `---` line with a
    // `+++` line right after it is a header, which a fragment like this one never has.
    expect(
      normalizePayload('item/completed', {
        item: {
          type: 'fileChange',
          status: 'completed',
          changes: [
            {
              path: '/home/agent/work/docs/notes.md',
              kind: 'update',
              diff: ['+++ heading', '+++more', '-- removed', '---gone'].join('\n'),
            },
          ],
        },
      }),
    ).toEqual({
      kind: 'file',
      state: 'completed',
      files: [{ path: 'work/docs/notes.md', change: 'update', addedLines: 2, deletedLines: 2 }],
    })
  })

  it('reads a change list reported as a map keyed by the path it changed', (): void => {
    expect(
      normalizePayload('item/completed', {
        item: {
          type: 'patchApply',
          status: 'completed',
          changes: {
            '/home/agent/work/src/server.ts': { kind: 'update', added_lines: 6, deleted_lines: 2 },
          },
        },
      }),
    ).toEqual({
      kind: 'file',
      state: 'completed',
      files: [{ path: 'work/src/server.ts', change: 'update', addedLines: 6, deletedLines: 2 }],
    })
  })

  it('keeps an item whose fields are reported in shapes it does not recognize', (): void => {
    // Tolerance is the point: an unusable field is absent, never a failed turn.
    expect(
      normalizePayload('item/completed', {
        item: { type: 'commandExecution', command: 42, exitCode: 'zero', status: [] },
      }),
    ).toEqual({
      kind: 'command',
      program: 'unknown',
      argumentCount: 0,
      quality: null,
      state: 'completed',
      exitCode: null,
      durationMs: null,
    })
    // An unrecognized item type still reaches the timeline by method name.
    expect(normalizePayload('item/completed', { item: { type: 'vendorSpecific' } })).toEqual({
      kind: 'none',
    })
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
    let record = makeRecord()
    for (let index = 0; index < timelineEventLimit + 25; index += 1) {
      record = recordAgentEvent(
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
    let record = makeRecord()
    record = recordAgentEvent(record, event({ kind: 'session' }))
    record = recordRetryScheduled(
      record,
      new Date('2026-08-30T10:00:10.000Z'),
      1,
      new Date('2026-08-30T10:00:20.000Z'),
      'agent stalled',
    )
    record = recordAttemptStarted(record, new Date('2026-08-30T10:00:20.000Z'), 1)
    record = recordAgentEvent(
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
    let record = makeRecord()
    record = recordAgentEvent(
      record,
      event({
        kind: 'file',
        state: 'completed',
        files: [{ path: 'src/telemetry.ts', change: 'update', addedLines: 10, deletedLines: 2 }],
      }),
    )
    record = recordAgentEvent(
      record,
      event(
        {
          kind: 'file',
          state: 'completed',
          files: [{ path: 'src/server.ts', change: 'add', addedLines: 5, deletedLines: 0 }],
        },
        { timestamp: new Date('2026-08-30T10:00:07.000Z') },
      ),
    )
    record = recordAgentEvent(
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
      pathKey: 'example_sloppenheimer_34',
      branch: 'sloppenheimer/issue-34',
      dirtyFileCount: 2,
      addedLines: 15,
      deletedLines: 2,
      lastFileActivityAt: '2026-08-30T10:00:07.000Z',
      qualityPhase: 'check',
      qualityCommandState: 'completed',
      pathsTruncated: false,
    })
  })

  it('counts a patch when it is applied, not when it is proposed or refused', (): void => {
    // One file item is reported twice: once as the patch it proposes and once as the patch it
    // applied. Counting both would double every line the agent wrote, and counting a declined or
    // failed patch would credit the worktree with an edit it never received.
    const changes = [
      {
        path: '/home/agent/work/src/telemetry.ts',
        kind: 'update',
        diff: '+one\n+two\n-three\n',
      },
    ]
    const item = (status: string, listed: typeof changes): AgentEventPayload =>
      normalizePayload(status === 'inProgress' ? 'item/started' : 'item/completed', {
        item: { id: 'item_7', type: 'fileChange', status, changes: listed },
      })
    let record = makeRecord()
    record = recordAgentEvent(record, event(item('inProgress', changes), { event: 'item/started' }))
    const proposed = snapshotOf(record)
    record = recordAgentEvent(record, event(item('completed', changes)))
    const applied = snapshotOf(record)
    record = recordAgentEvent(
      record,
      event(
        item('declined', [
          { path: '/home/agent/work/src/server.ts', kind: 'add', diff: '+refused\n' },
        ]),
      ),
    )
    const refused = snapshotOf(record)

    expect(proposed.workspace).toMatchObject({
      dirtyFileCount: 0,
      addedLines: 0,
      deletedLines: 0,
    })
    expect(applied.workspace).toMatchObject({
      dirtyFileCount: 1,
      addedLines: 2,
      deletedLines: 1,
    })
    expect(refused.workspace).toMatchObject({
      dirtyFileCount: 1,
      addedLines: 2,
      deletedLines: 1,
    })
    // Every report still reaches the timeline; what the ledger counts is what reached the
    // worktree, and the state on each entry is what says which is which.
    expect(refused.timeline.events.map((entry) => [entry.category, entry.event])).toEqual([
      ['file', 'item/started'],
      ['file', 'item/completed'],
      ['file', 'item/completed'],
    ])
  })

  it('records one patch as one timeline event covering every file it touched', (): void => {
    let record = makeRecord()
    record = recordAgentEvent(
      record,
      event({
        kind: 'file',
        state: 'completed',
        files: [
          { path: 'src/telemetry.ts', change: 'update', addedLines: 10, deletedLines: 2 },
          { path: 'src/server.ts', change: 'add', addedLines: 5, deletedLines: 0 },
          { path: 'docs/README.md', change: 'delete', addedLines: null, deletedLines: null },
        ],
      }),
    )
    const snapshot = snapshotOf(record)
    const [entry] = snapshot.timeline.events

    expect(snapshot.timeline.events).toHaveLength(1)
    expect(entry?.category === 'file' ? entry.files.map((file) => file.path) : []).toEqual([
      'src/telemetry.ts',
      'src/server.ts',
      'docs/README.md',
    ])
    expect(snapshot.workspace).toMatchObject({
      dirtyFileCount: 3,
      addedLines: 15,
      deletedLines: 2,
    })
    expect(snapshot.phase.operation).toBe('Editing src/telemetry.ts and 2 more')
  })

  it('counts every file of a patch larger than the retained path list', (): void => {
    // The retained path list is bounded, and the totals are not: a patch touching more files than
    // the record keeps paths for still contributes all of its lines, and says the list was cut.
    const files = Array.from({ length: changedPathLimit + 5 }, (_unused, index) => ({
      path: `src/module-${String(index)}.ts`,
      change: 'update' as const,
      addedLines: 2,
      deletedLines: 1,
    }))
    const record = recordAgentEvent(
      makeRecord(),
      event({ kind: 'file', state: 'completed', files }),
    )
    const snapshot = snapshotOf(record)
    const [entry] = snapshot.timeline.events

    expect(snapshot.workspace).toMatchObject({
      dirtyFileCount: changedPathLimit,
      addedLines: (changedPathLimit + 5) * 2,
      deletedLines: changedPathLimit + 5,
      pathsTruncated: true,
    })
    // The entry names no more paths than the record retains, and reports the patch's true size
    // rather than the size of the sample it kept.
    expect(entry?.category === 'file' ? entry.files.length : 0).toBe(changedPathLimit)
    expect(entry?.category === 'file' ? entry.fileCount : 0).toBe(changedPathLimit + 5)
    expect(entry?.category === 'file' ? entry.addedLines : 0).toBe((changedPathLimit + 5) * 2)
  })

  it('leaves the running phase when a tool or command finishes', (): void => {
    let record = makeRecord()
    record = recordAgentEvent(
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

    record = recordAgentEvent(
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

    record = recordAgentEvent(
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

    record = recordAgentEvent(
      record,
      event(
        { kind: 'tool', name: 'search', state: 'started', inputBytes: 12, outputBytes: null },
        { timestamp: new Date('2026-08-30T10:00:10.000Z') },
      ),
    )
    expect(snapshotOf(record).phase.phase).toBe('running_tool')
  })

  it('counts every retry, including attempts older than the retained summaries', (): void => {
    let record = makeRecord()
    const total = retainedAttemptLimit + 5
    for (let attempt = 1; attempt <= total; attempt += 1) {
      record = recordRetryScheduled(
        record,
        new Date(startedAt.getTime() + attempt * 2_000),
        attempt,
        new Date(startedAt.getTime() + attempt * 2_000 + 1_000),
        'turn failed',
      )
      record = recordAttemptStarted(
        record,
        new Date(startedAt.getTime() + attempt * 2_000 + 1_000),
        attempt,
      )
    }
    const snapshot = snapshotOf(record, new Date(startedAt.getTime() + 120_000))

    expect(snapshot.attempt.current).toBe(total)
    expect(snapshot.attempt.retries).toBe(total)
    // The summaries stay bounded even though the count does not.
    expect(snapshot.attempt.attempts).toHaveLength(retainedAttemptLimit)
  })

  it('reports the stall deadline, countdown, and stalled phase from the last activity', (): void => {
    let record = makeRecord()
    record = recordAgentEvent(record, event({ kind: 'reasoning' }))

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
    let record = makeRecord()
    record = recordAgentEvent(record, event({ kind: 'reasoning' }))
    // The worker finished, but there was no branch to hand off, so the session continues.
    record = recordHandoff(record, new Date('2026-08-30T10:00:10.000Z'), {
      step: 'remote_branch',
      status: 'absent',
      message: 'No remote branch sloppenheimer/issue-34 exists yet; continuing the session',
      remoteBranch: 'sloppenheimer/issue-34',
      outcome: 'no_branch',
    })
    record = recordRetryScheduled(
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
    let cancelled = makeRecord()
    cancelled = recordCancellation(
      cancelled,
      new Date('2026-08-30T10:00:10.000Z'),
      'the agent stalled',
    )
    cancelled = recordRetryScheduled(
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
    let record = makeRecord()
    record = recordHandoff(record, new Date('2026-08-30T10:01:00.000Z'), {
      step: 'remote_branch',
      status: 'observed',
      message: 'Remote branch sloppenheimer/issue-34 is present',
      remoteBranch: 'sloppenheimer/issue-34',
    })
    record = recordHandoff(record, new Date('2026-08-30T10:01:01.000Z'), {
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
    record = recordCancellation(
      record,
      new Date('2026-08-30T10:01:02.000Z'),
      'the operator paused the issue',
    )
    const snapshot = snapshotOf(record, new Date('2026-08-30T10:01:03.000Z'))

    expect(snapshot.handoff).toMatchObject({
      expectedBranch: 'sloppenheimer/issue-34',
      remoteBranch: { status: 'observed', name: 'sloppenheimer/issue-34' },
      pullRequest: { status: 'created', number: 61, url: 'https://example.test/pull/61' },
      dispatchLabels: { labels: ['sloppenheimer'], status: 'not_performed' },
      outcome: 'pull_request_open',
    })
    expect(snapshot.timeline.events.map((entry) => entry.category)).toEqual([
      'handoff',
      'handoff',
      'cancellation',
    ])
    expect(snapshot.phase.phase).toBe('cancelled')
  })

  it('freezes rate-limit windows wherever they are shared', (): void => {
    let record = makeRecord()
    record = recordAgentEvent(
      record,
      event(
        { kind: 'none' },
        {
          event: 'account/rateLimits/updated',
          rateLimits: { primary: { usedPercent: 40, windowMinutes: 300, resetsInSeconds: 60 } },
        },
      ),
    )
    const snapshot = snapshotOf(record)
    const [entry] = snapshot.timeline.events

    expect(snapshot.rateLimits.every((window) => Object.isFrozen(window))).toBe(true)
    // The array a timeline event holds is the same reading; its elements must be frozen too, or a
    // consumer could edit the actor's own record through the event.
    expect(entry?.category).toBe('usage')
    if (entry?.category === 'usage') {
      expect(entry.rateLimits.every((window) => Object.isFrozen(window))).toBe(true)
    }
  })

  it('freezes token totals wherever they are shared', (): void => {
    let record = makeRecord()
    record = recordAgentEvent(
      record,
      event(
        { kind: 'none' },
        {
          event: 'turn/completed',
          usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
        },
      ),
    )
    const snapshot = snapshotOf(record)
    const [entry] = snapshot.timeline.events

    expect(entry?.category).toBe('usage')
    if (entry?.category === 'usage') {
      // A timeline event is frozen shallowly, so the counts nested inside it need freezing of their
      // own: the record holds that same object, and an edit here would be carried forward by it.
      expect(Object.isFrozen(entry.tokens)).toBe(true)
      const tokens = entry.tokens as unknown as { totalTokens: number }
      expect(() => {
        tokens.totalTokens = 9_999
      }).toThrow()
    }
    expect(snapshotOf(record).usage).toEqual({ inputTokens: 11, outputTokens: 5, totalTokens: 16 })
  })

  it('starts a retried attempt with no identity carried over from the last session', (): void => {
    let record = makeRecord()
    record = recordAgentEvent(record, event({ kind: 'session' }))
    record = recordAgentEvent(
      record,
      event({ kind: 'none' }, { event: 'turn/completed', turnCount: 7 }),
    )
    record = recordRetryScheduled(
      record,
      new Date('2026-08-30T10:00:10.000Z'),
      1,
      new Date('2026-08-30T10:00:15.000Z'),
      'the worker exited',
    )
    record = recordAttemptStarted(record, new Date('2026-08-30T10:00:20.000Z'), 1)

    const started = snapshotOf(record)
    // The retry opens a new agent connection, so nothing may still describe the previous one.
    expect(started.identity).toMatchObject({
      threadId: null,
      turnId: null,
      sessionId: null,
      processId: null,
      turnNumber: 0,
    })
    // The session that was replaced is still there in full.
    expect(started.attempt.sessions.at(-1)).toMatchObject({
      threadId: 'thread-1',
      sessionId: 'thread-1:turn-1',
      processId: 4242,
    })

    record = recordAgentEvent(
      record,
      event(
        { kind: 'session' },
        { threadId: 'thread-2', turnId: 'turn-2', sessionId: 'thread-2:turn-2', turnCount: 1 },
      ),
    )

    // The new session counts from its own first turn rather than being held above it by the last.
    expect(snapshotOf(record).identity).toMatchObject({
      threadId: 'thread-2',
      sessionId: 'thread-2:turn-2',
      turnNumber: 1,
    })
  })

  it('publishes frozen snapshots that cannot be edited by a consumer', (): void => {
    let record = makeRecord()
    record = recordAgentEvent(record, event({ kind: 'reasoning' }))
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

  it('folds each observation into a new record, leaving the earlier value untouched', (): void => {
    const started = makeRecord()
    const reasoned = recordAgentEvent(started, event({ kind: 'reasoning' }))
    const edited = recordAgentEvent(
      reasoned,
      event(
        {
          kind: 'file',
          state: 'completed',
          files: [{ path: 'src/telemetry.ts', change: 'update', addedLines: 3, deletedLines: 1 }],
        },
        { timestamp: new Date('2026-08-30T10:00:06.000Z') },
      ),
    )
    // Taken from the second value, before two more observations are folded in. The orchestrator
    // publishes the record it holds without copying it, so this is exactly what a consumer keeps.
    const published = snapshotOf(reasoned)
    const handed = recordHandoff(edited, new Date('2026-08-30T10:00:10.000Z'), {
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
    const cancelled = recordCancellation(handed, new Date('2026-08-30T10:00:11.000Z'), 'stopped')

    expect(started.events).toHaveLength(0)
    expect(started.sequence).toBe(0)
    expect(reasoned.events).toHaveLength(1)
    expect(reasoned.sequence).toBe(1)
    expect(reasoned.phase).toBe('reasoning')
    expect(reasoned.changedPaths.size).toBe(0)
    expect(edited.changedPaths.size).toBe(1)
    expect(edited.handoff.pullRequest.status).toBe('pending')
    expect(handed.phase).toBe('handing_off')
    expect(cancelled.events).toHaveLength(4)

    expect(published.timeline.events).toHaveLength(1)
    expect(published.phase.phase).toBe('reasoning')
    expect(published.workspace.dirtyFileCount).toBe(0)
    expect(published.handoff.pullRequest.status).toBe('pending')
  })
})
