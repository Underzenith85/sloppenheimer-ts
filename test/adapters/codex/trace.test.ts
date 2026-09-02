import { describe, expect, it } from 'vitest'

import type { JsonValue } from '@sloppenheimer/core/domain/domain.js'
import type { TraceCapture } from '@sloppenheimer/core/domain/trace.js'
import { makeRedactor, redactionMarker } from '@sloppenheimer/core/support/redaction.js'
import { clientTraceObservation, traceObservation } from '@sloppenheimer/adapter-codex/trace.js'
import { normalizePayload } from '@sloppenheimer/adapter-codex/payload.js'

/**
 * The Codex protocol read at full fidelity.
 *
 * Two things are being asserted throughout. The first is that the trace keeps what the bounded
 * timeline throws away — the whole command line, its output, tool payloads, patch text — because a
 * trace that summarized would not answer the question it exists for. The second is the privacy
 * rule: a reasoning *summary* is retained and labeled as one, and encrypted reasoning content is
 * never read, never decoded, and never appears in a record.
 */

const capture: TraceCapture = { enabled: true, fieldLimitBytes: 4096, eventLimitBytes: 16_384 }
const tight: TraceCapture = { enabled: true, fieldLimitBytes: 24, eventLimitBytes: 64 }
const off: TraceCapture = { enabled: false, fieldLimitBytes: 0, eventLimitBytes: 0 }

const notification = (item: JsonValue): JsonValue => ({ item })

describe('with capture switched off', (): void => {
  it('builds nothing at all, so retention is what it was before the trace existed', (): void => {
    expect(
      traceObservation('item/completed', notification({ type: 'agentMessage', text: 'hi' }), off),
    ).toBeNull()
    expect(clientTraceObservation('approval_auto_approved', 'exec', off)).toBeNull()
  })
})

describe('reasoning', (): void => {
  it('retains a human-readable summary and labels it as a summary', (): void => {
    const observation = traceObservation(
      'item/completed',
      notification({ type: 'reasoning', summary: 'Checking the failing test first.' }),
      capture,
    )
    expect(observation?.category).toBe('reasoning_summary')
    expect(observation?.body).toEqual({
      kind: 'reasoning_summary',
      text: 'Checking the failing test first.',
    })
  })

  it('records only that reasoning happened when the item carries no readable summary', (): void => {
    const observation = traceObservation(
      'item/completed',
      notification({
        type: 'reasoning',
        encryptedContent: 'gAAAAABmc3JlZWFzb25pbmc',
        encrypted_reasoning: 'more of the same',
      }),
      capture,
    )
    expect(observation?.category).toBe('lifecycle')
    expect(observation?.body).toMatchObject({ kind: 'lifecycle', phase: 'reasoning' })
    // The whole record, serialized: no part of the encrypted content appears anywhere in it.
    expect(JSON.stringify(observation)).not.toContain('gAAAAAB')
  })

  it('never reads encrypted content even when a summary is present beside it', (): void => {
    const observation = traceObservation(
      'item/completed',
      notification({
        type: 'reasoning',
        summary: 'Reading the diff.',
        encryptedContent: 'gAAAAABsecret',
      }),
      capture,
    )
    expect(JSON.stringify(observation)).not.toContain('gAAAAAB')
    expect(observation?.body).toEqual({ kind: 'reasoning_summary', text: 'Reading the diff.' })
  })
})

describe('commands', (): void => {
  const item = {
    type: 'commandExecution',
    command: ['bash', '-lc', 'pnpm check --filter core'],
    stdout: 'line one\nline two\n',
    stderr: 'a warning\n',
    exitCode: 1,
    durationMs: 1234,
    status: 'failed',
  }

  it('keeps the whole command line, its output and its exit code', (): void => {
    const observation = traceObservation('item/completed', notification(item), capture)
    expect(observation?.category).toBe('command')
    expect(observation?.outcome).toBe('failed')
    expect(observation?.body).toEqual({
      kind: 'command',
      commandLine: 'bash -lc pnpm check --filter core',
      stdout: 'line one\nline two\n',
      stderr: 'a warning\n',
      exitCode: 1,
      durationMs: 1234,
    })
  })

  it('keeps strictly more than the bounded timeline does for the same message', (): void => {
    const payload = normalizePayload('item/completed', notification(item))
    // The timeline retains the program word and an argument count, and no output at all.
    expect(payload).toMatchObject({ kind: 'command', program: 'pnpm', argumentCount: 5 })
    expect(JSON.stringify(payload)).not.toContain('line one')
  })

  it('reports the cut when output exceeds the field ceiling', (): void => {
    const observation = traceObservation(
      'item/completed',
      notification({ ...item, stdout: 'x'.repeat(500) }),
      tight,
    )
    expect(observation?.truncations.some((cut) => cut.field === 'stdout')).toBe(true)
    expect(observation?.truncations.find((cut) => cut.field === 'stdout')?.originalBytes).toBe(500)
  })

  it('removes a configured secret the command printed, before it is retained', (): void => {
    const observation = traceObservation(
      'item/completed',
      notification({ ...item, stdout: 'token=glacial-marmoset-77213\n' }),
      capture,
      makeRedactor(['glacial-marmoset-77213']),
    )
    expect(JSON.stringify(observation)).not.toContain('glacial-marmoset')
    expect(observation?.redacted).toBe(true)
  })
})

describe('tools', (): void => {
  it('retains arguments and results rather than their byte counts', (): void => {
    const observation = traceObservation(
      'item/completed',
      notification({
        type: 'toolCall',
        name: 'search',
        arguments: { query: 'orchestrator', limit: 5 },
        result: { hits: ['core/runtime.ts'] },
        status: 'completed',
      }),
      capture,
    )
    expect(observation?.body).toEqual({
      kind: 'tool',
      name: 'search',
      arguments: { query: 'orchestrator', limit: 5 },
      result: { hits: ['core/runtime.ts'] },
      durationMs: null,
    })
  })

  it('replaces a value under a secret-named argument key', (): void => {
    const observation = traceObservation(
      'item/completed',
      notification({
        type: 'toolCall',
        name: 'fetch',
        arguments: { url: 'https://example.test', authorization: 'Bearer abcdefghijklmnop' },
      }),
      capture,
    )
    expect(JSON.stringify(observation)).toContain(redactionMarker)
    expect(JSON.stringify(observation)).not.toContain('abcdefghijklmnop')
  })
})

describe('file changes', (): void => {
  it('retains the patch text the runner supplied, for every file it named', (): void => {
    const observation = traceObservation(
      'item/completed',
      notification({
        type: 'fileChange',
        status: 'completed',
        changes: [
          { path: 'src/a.ts', kind: { type: 'update' }, diff: '@@\n+added\n-removed\n' },
          { path: 'src/b.ts', kind: { type: 'add' }, diff: '@@\n+new\n' },
        ],
      }),
      capture,
    )
    expect(observation?.body).toEqual({
      kind: 'file',
      files: [
        {
          path: 'src/a.ts',
          change: 'update',
          addedLines: 1,
          deletedLines: 1,
          patch: '@@\n+added\n-removed\n',
        },
        { path: 'src/b.ts', change: 'add', addedLines: 1, deletedLines: 0, patch: '@@\n+new\n' },
      ],
    })
  })

  it('reports no patch where the runner supplied none, rather than inventing one', (): void => {
    const observation = traceObservation(
      'item/completed',
      notification({
        type: 'fileChange',
        changes: [{ path: 'src/a.ts', kind: { type: 'delete' } }],
      }),
      capture,
    )
    expect(observation?.body).toMatchObject({
      kind: 'file',
      files: [{ path: 'src/a.ts', change: 'delete', patch: null }],
    })
  })
})

describe('messages and errors', (): void => {
  it('retains a whole message, newlines and all', (): void => {
    const observation = traceObservation(
      'item/completed',
      notification({ type: 'agentMessage', text: 'first\n\nsecond' }),
      capture,
    )
    expect(observation?.body).toEqual({
      kind: 'message',
      role: 'assistant',
      text: 'first\n\nsecond',
    })
  })

  it('reads a user message as one', (): void => {
    const observation = traceObservation(
      'item/completed',
      notification({ type: 'userMessage', text: 'go on' }),
      capture,
    )
    expect(observation?.body).toMatchObject({ kind: 'message', role: 'user' })
  })

  it('reads an error item as an error', (): void => {
    const observation = traceObservation(
      'item/completed',
      notification({ type: 'error', message: 'the sandbox refused', code: 'sandbox' }),
      capture,
    )
    expect(observation?.category).toBe('error')
    expect(observation?.body).toMatchObject({ kind: 'error', code: 'sandbox' })
  })
})

describe('messages nothing recognizes', (): void => {
  it('records the shape rather than the envelope, and never drops the event', (): void => {
    const observation = traceObservation(
      'codex/event/experimental_thing',
      { note: 'hello', count: 3, nested: { deep: true }, list: [1, 2], missing: null },
      capture,
    )
    expect(observation?.category).toBe('unknown')
    expect(observation?.body).toEqual({
      kind: 'unknown',
      fields: [
        { name: 'note', type: 'string', value: 'hello', bytes: 7 },
        { name: 'count', type: 'number', value: '3', bytes: 1 },
        { name: 'nested', type: 'object', value: null, bytes: 13 },
        { name: 'list', type: 'array', value: null, bytes: 5 },
        { name: 'missing', type: 'null', value: null, bytes: 4 },
      ],
    })
  })

  it('redacts a scalar it does render', (): void => {
    const observation = traceObservation(
      'codex/event/experimental_thing',
      { note: 'key ghp_abcdefghijklmnopqrstuvwxyz012345' },
      capture,
    )
    expect(JSON.stringify(observation)).not.toContain('ghp_abcdefghij')
  })

  it('reads a thread or turn notification as a lifecycle record', (): void => {
    const observation = traceObservation('turn/completed', { turn: { id: 'u' } }, capture)
    expect(observation?.body).toEqual({ kind: 'lifecycle', phase: 'turn/completed', detail: null })
  })
})

describe('the client’s own events', (): void => {
  it('records an approval decision as an approval', (): void => {
    const observation = clientTraceObservation('approval_auto_approved', 'exec/approve', capture)
    expect(observation?.category).toBe('approval')
    expect(observation?.outcome).toBe('approved')
    expect(observation?.body).toEqual({
      kind: 'approval',
      subject: 'exec/approve',
      decision: 'acceptForSession',
    })
  })

  it('records a withheld permissions grant as a withheld approval', (): void => {
    const observation = clientTraceObservation('permissions_grant_withheld', 'grant', capture)
    expect(observation?.outcome).toBe('withheld')
  })

  it('records a client-side notice as a warning rather than a session failure', (): void => {
    const observation = clientTraceObservation('malformed', 'Codex emitted malformed JSON', capture)
    expect(observation?.body).toMatchObject({
      kind: 'error',
      severity: 'warning',
      code: 'malformed',
    })
  })

  it('records a session transition as a lifecycle record', (): void => {
    const observation = clientTraceObservation('session_started', null, capture)
    expect(observation?.body).toEqual({ kind: 'lifecycle', phase: 'session_started', detail: null })
  })
})
