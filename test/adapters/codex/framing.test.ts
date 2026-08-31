import { it } from '@effect/vitest'
import { Chunk, Effect, Stream } from 'effect'
import { describe, expect, vi } from 'vitest'

import {
  diagnosticLines,
  diagnosticRecords,
  protocolLines,
} from '../../../src/adapters/codex/framing.js'
import type { AgentError } from '../../../src/errors.js'

const bytes = (...chunks: readonly string[]): Stream.Stream<Uint8Array> =>
  Stream.fromIterable(chunks.map((chunk) => Buffer.from(chunk)))

const collect = <E>(stream: Stream.Stream<string, E>): Effect.Effect<readonly string[], E> =>
  Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray))

/** The framing failure a stream ends in, read off the error channel rather than a thrown cause. */
const failure = (stream: Stream.Stream<string, AgentError>): Effect.Effect<AgentError | null> =>
  Effect.either(Stream.runDrain(stream)).pipe(
    Effect.map((either) => (either._tag === 'Left' ? either.left : null)),
  )

describe('App Server line framing', (): void => {
  it.effect('splits lines and strips CR across chunk boundaries', () =>
    Effect.gen(function* () {
      const lines = yield* collect(bytes('{"a":1}\r\n{"b', '":2}\n').pipe(protocolLines(16)))

      expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    }),
  )

  it.effect('fails with a protocol error once the pending buffer passes the limit', () =>
    Effect.gen(function* () {
      const error = yield* failure(bytes('x'.repeat(40)).pipe(protocolLines(16)))

      expect(error?.category).toBe('protocol_error')
      expect(error?.message).toContain('exceeds 16 bytes')
    }),
  )

  it.effect('fails on a completed line longer than the limit', () =>
    Effect.gen(function* () {
      const error = yield* failure(bytes(`${'x'.repeat(17)}\n`).pipe(protocolLines(16)))

      expect(error?.category).toBe('protocol_error')
    }),
  )

  it.effect('accepts a maximum-length line whose CRLF is split across chunks', () =>
    Effect.gen(function* () {
      const lines = yield* collect(bytes('12345678\r', '\n').pipe(protocolLines(8)))

      // The CR is stripped once the line completes, so where the chunk boundary fell must not decide
      // whether a valid maximum-length line is accepted.
      expect(lines).toEqual(['12345678'])
    }),
  )

  it.effect('assembles a chunked line without recopying the pending prefix', () =>
    Effect.gen(function* () {
      const part = 'y'.repeat(64 * 1024)
      const concat = vi.spyOn(Buffer, 'concat')

      const lines = yield* collect(
        bytes(...Array.from({ length: 8 }, () => part), '\n').pipe(protocolLines(1024 * 1024)),
      )

      const copies = concat.mock.calls.length
      concat.mockRestore()

      expect(lines).toEqual([part.repeat(8)])
      // One copy for the whole line rather than one per chunk, so framing stays linear in line size:
      // a permitted 10 MB frame arriving in pipe-sized chunks must not copy hundreds of megabytes.
      expect(copies).toBe(1)
    }),
  )

  it.effect('drops an unterminated protocol tail, because half a message is not a message', () =>
    Effect.gen(function* () {
      const lines = yield* collect(bytes('{"a":1}\n{"b":', '2}').pipe(protocolLines(64)))

      expect(lines).toEqual(['{"a":1}'])
    }),
  )

  it.effect('flushes an unterminated diagnostic tail as a complete record', () =>
    Effect.gen(function* () {
      const lines = yield* collect(
        bytes('first\nAuthorization:', ' Bearer x').pipe(diagnosticLines(64)),
      )

      expect(lines).toEqual(['first', 'Authorization: Bearer x'])
    }),
  )

  it.effect('flushes nothing when the stream ends on a frame boundary', () =>
    Effect.gen(function* () {
      const lines = yield* collect(bytes('first\n').pipe(diagnosticLines(64)))

      expect(lines).toEqual(['first'])
    }),
  )

  it.effect('abandons the tail that overran the limit rather than flushing it', () =>
    Effect.gen(function* () {
      const error = yield* failure(bytes('secret-secret-secret').pipe(diagnosticLines(8)))

      expect(error?.category).toBe('protocol_error')
    }),
  )

  it.effect('rejects a tail that only the pending allowance let through', () =>
    Effect.gen(function* () {
      // The pending buffer may hold one byte over the limit, for the CR of a CRLF whose LF has not
      // arrived. A tail that never terminates has no such LF, so that allowance must not let an
      // over-long record out at the end of the stream.
      const error = yield* failure(bytes('123456789').pipe(diagnosticLines(8)))

      expect(error?.category).toBe('protocol_error')
    }),
  )

  it.effect('flushes a maximum-length tail whose last byte really is a CR', () =>
    Effect.gen(function* () {
      const lines = yield* collect(bytes('12345678\r').pipe(diagnosticLines(8)))

      expect(lines).toEqual(['12345678'])
    }),
  )

  it.effect(
    'holds a finely chunked line without recopying the chunks it is holding',
    () =>
      Effect.gen(function* () {
        // Framing is linear in the number of chunks, not quadratic: a child that writes a long line
        // a byte at a time must not cost the host the accumulated prefix on every write.
        const written = Array.from({ length: 100_000 }, () => 'a')
        const lines = yield* collect(bytes(...written, '\n').pipe(protocolLines(1024 * 1024)))

        expect(lines).toEqual(['a'.repeat(100_000)])
      }),
    10_000,
  )
})

describe('App Server diagnostic records', (): void => {
  it.effect('trims a record and drops a blank one', () =>
    Effect.gen(function* () {
      const records = yield* collect(
        Stream.make('  warning: noisy  ', '   ', '').pipe(diagnosticRecords),
      )

      expect(records).toEqual(['warning: noisy'])
    }),
  )

  it.effect('swallows every line of a multiline private key', () =>
    Effect.gen(function* () {
      const records = yield* collect(
        Stream.make(
          'PRIVATE_KEY=-----BEGIN PRIVATE KEY-----',
          'c2VjcmV0LXByaXZhdGUta2V5LWJvZHk=',
          '-----END PRIVATE KEY-----',
          'after',
        ).pipe(diagnosticRecords),
      )

      expect(records).toEqual(['PRIVATE_KEY=[REDACTED PEM PRIVATE KEY]', 'after'])
    }),
  )

  it.effect('replaces a private key the stream ends in the middle of', () =>
    Effect.gen(function* () {
      const records = yield* collect(
        Stream.make('-----BEGIN PGP PRIVATE KEY BLOCK-----', 'c2VjcmV0LXBncC1rZXk=').pipe(
          diagnosticRecords,
        ),
      )

      expect(records).toEqual(['[REDACTED PEM PRIVATE KEY]'])
    }),
  )

  it.effect('passes a single-line key block through for shape-based redaction', () =>
    Effect.gen(function* () {
      const line = '-----BEGIN PRIVATE KEY-----body-----END PRIVATE KEY-----'
      const records = yield* collect(Stream.make(line, 'after').pipe(diagnosticRecords))

      expect(records).toEqual([line, 'after'])
    }),
  )
})
