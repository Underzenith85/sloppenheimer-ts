import { Chunk, Effect, Stream } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
  diagnosticLines,
  diagnosticRecords,
  protocolLines,
} from '../../../src/adapters/codex/framing.js'
import type { AgentError } from '../../../src/errors.js'

const bytes = (...chunks: readonly string[]): Stream.Stream<Uint8Array> =>
  Stream.fromIterable(chunks.map((chunk) => Buffer.from(chunk)))

const collect = async <E>(stream: Stream.Stream<string, E>): Promise<readonly string[]> =>
  Effect.runPromise(Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray)))

const failure = async (stream: Stream.Stream<string, AgentError>): Promise<AgentError | null> => {
  const exit = await Effect.runPromise(Effect.either(Stream.runDrain(stream)))
  return exit._tag === 'Left' ? exit.left : null
}

describe('App Server line framing', (): void => {
  it('splits lines and strips CR across chunk boundaries', async (): Promise<void> => {
    const lines = await collect(bytes('{"a":1}\r\n{"b', '":2}\n').pipe(protocolLines(16)))

    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('fails with a protocol error once the pending buffer passes the limit', async (): Promise<void> => {
    const error = await failure(bytes('x'.repeat(40)).pipe(protocolLines(16)))

    expect(error?.category).toBe('protocol_error')
    expect(error?.message).toContain('exceeds 16 bytes')
  })

  it('fails on a completed line longer than the limit', async (): Promise<void> => {
    const error = await failure(bytes(`${'x'.repeat(17)}\n`).pipe(protocolLines(16)))

    expect(error?.category).toBe('protocol_error')
  })

  it('accepts a maximum-length line whose CRLF is split across chunks', async (): Promise<void> => {
    const lines = await collect(bytes('12345678\r', '\n').pipe(protocolLines(8)))

    // The CR is stripped once the line completes, so where the chunk boundary fell must not decide
    // whether a valid maximum-length line is accepted.
    expect(lines).toEqual(['12345678'])
  })

  it('assembles a chunked line without recopying the pending prefix', async (): Promise<void> => {
    const part = 'y'.repeat(64 * 1024)
    const concat = vi.spyOn(Buffer, 'concat')

    const lines = await collect(
      bytes(...Array.from({ length: 8 }, () => part), '\n').pipe(protocolLines(1024 * 1024)),
    )

    const copies = concat.mock.calls.length
    concat.mockRestore()

    expect(lines).toEqual([part.repeat(8)])
    // One copy for the whole line rather than one per chunk, so framing stays linear in line size:
    // a permitted 10 MB frame arriving in pipe-sized chunks must not copy hundreds of megabytes.
    expect(copies).toBe(1)
  })

  it('drops an unterminated protocol tail, because half a message is not a message', async (): Promise<void> => {
    const lines = await collect(bytes('{"a":1}\n{"b":', '2}').pipe(protocolLines(64)))

    expect(lines).toEqual(['{"a":1}'])
  })

  it('flushes an unterminated diagnostic tail as a complete record', async (): Promise<void> => {
    const lines = await collect(
      bytes('first\nAuthorization:', ' Bearer x').pipe(diagnosticLines(64)),
    )

    expect(lines).toEqual(['first', 'Authorization: Bearer x'])
  })

  it('flushes nothing when the stream ends on a frame boundary', async (): Promise<void> => {
    const lines = await collect(bytes('first\n').pipe(diagnosticLines(64)))

    expect(lines).toEqual(['first'])
  })

  it('abandons the tail that overran the limit rather than flushing it', async (): Promise<void> => {
    const error = await failure(bytes('secret-secret-secret').pipe(diagnosticLines(8)))

    expect(error?.category).toBe('protocol_error')
  })
})

describe('App Server diagnostic records', (): void => {
  it('trims a record and drops a blank one', async (): Promise<void> => {
    const records = await collect(
      Stream.make('  warning: noisy  ', '   ', '').pipe(diagnosticRecords),
    )

    expect(records).toEqual(['warning: noisy'])
  })

  it('swallows every line of a multiline private key', async (): Promise<void> => {
    const records = await collect(
      Stream.make(
        'PRIVATE_KEY=-----BEGIN PRIVATE KEY-----',
        'c2VjcmV0LXByaXZhdGUta2V5LWJvZHk=',
        '-----END PRIVATE KEY-----',
        'after',
      ).pipe(diagnosticRecords),
    )

    expect(records).toEqual(['PRIVATE_KEY=[REDACTED PEM PRIVATE KEY]', 'after'])
  })

  it('replaces a private key the stream ends in the middle of', async (): Promise<void> => {
    const records = await collect(
      Stream.make('-----BEGIN PGP PRIVATE KEY BLOCK-----', 'c2VjcmV0LXBncC1rZXk=').pipe(
        diagnosticRecords,
      ),
    )

    expect(records).toEqual(['[REDACTED PEM PRIVATE KEY]'])
  })

  it('passes a single-line key block through for shape-based redaction', async (): Promise<void> => {
    const line = '-----BEGIN PRIVATE KEY-----body-----END PRIVATE KEY-----'
    const records = await collect(Stream.make(line, 'after').pipe(diagnosticRecords))

    expect(records).toEqual([line, 'after'])
  })
})
