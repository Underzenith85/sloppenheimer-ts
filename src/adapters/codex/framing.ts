/**
 * Framing for the two byte streams a Codex App Server child produces, as stream operations.
 *
 * stdout carries JSON-RPC framed by newlines; stderr carries diagnostics that may span several
 * lines. Both are read the same way — accumulate bytes until a frame boundary, never past the
 * framing limit — and both are consumed by exactly one reader, so the state each carries between
 * chunks belongs to the pipeline rather than to the connection that runs it.
 */

import { Effect, Ref, Stream } from 'effect'

import { AgentError } from '../../errors.js'

const lineFeed = 0x0a
const carriageReturn = 0x0d

/**
 * A stateful stream operation. Each input advances the state and emits whatever it completed, and
 * the state left over when the source ends is flushed by `finish`. A failure abandons that state
 * instead of flushing it, so the fragment that overran the framing limit is never emitted.
 */
const stateful =
  <S, A, B, E2 = never>(
    initial: S,
    step: (state: S, value: A) => Effect.Effect<Readonly<{ state: S; emit: readonly B[] }>, E2>,
    finish: (state: S) => readonly B[],
  ) =>
  <E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<B, E | E2, R> =>
    Stream.unwrap(
      Effect.map(Ref.make(initial), (state) =>
        Stream.concat(
          Stream.flattenIterables(
            Stream.mapEffect(self, (value) =>
              Ref.get(state).pipe(
                Effect.flatMap((current) => step(current, value)),
                Effect.tap((next) => Ref.set(state, next.state)),
                Effect.map((next) => next.emit),
              ),
            ),
          ),
          Stream.unwrap(
            Ref.getAndSet(state, initial).pipe(
              Effect.map((left) => Stream.fromIterable(finish(left))),
            ),
          ),
        ),
      ),
    )

/**
 * Bytes held back for a line that has no terminator yet, kept as the chunks they arrived in.
 * Concatenating on every chunk would make framing quadratic in line size: a permitted 10 MB frame
 * arriving in pipe-sized chunks would copy hundreds of megabytes before its terminator showed up.
 */
type PendingLine = Readonly<{ chunks: readonly Uint8Array[]; bytes: number }>

const nothingPending: PendingLine = { chunks: [], bytes: 0 }

const bufferOf = (chunk: Uint8Array): Buffer =>
  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)

const joined = (pending: PendingLine): Buffer => {
  const [only] = pending.chunks
  return pending.chunks.length === 1 && only !== undefined
    ? bufferOf(only)
    : Buffer.concat(pending.chunks, pending.bytes)
}

/** Drops the CR of a CRLF, now that the line it terminates is known to be whole. */
const stripped = (raw: Buffer): Buffer =>
  raw.at(-1) === carriageReturn ? raw.subarray(0, raw.byteLength - 1) : raw

type Framed = Readonly<{ state: PendingLine; emit: readonly string[] }>

/** The framing limit is a protocol error however the stream that hit it is used. */
const lineOverflow = (limitBytes: number): AgentError =>
  new AgentError({
    category: 'protocol_error',
    message: `Codex protocol line exceeds ${String(limitBytes)} bytes`,
  })

/**
 * Splits one chunk into complete lines, or fails because the pending buffer has overrun the limit.
 *
 * The limit is enforced on the *pending* buffer as well as on each completed line, so an
 * unterminated line can never grow without bound before it is rejected. A pending buffer may hold
 * a full-length payload plus the CR of a CRLF whose LF has not arrived yet, so the pending limit
 * allows that one byte; otherwise a valid maximum-length line would be rejected purely for where a
 * chunk boundary fell.
 */
const frame = (
  limitBytes: number,
  pending: PendingLine,
  chunk: Uint8Array,
): Effect.Effect<Framed, AgentError> => {
  const pendingLimitBytes = limitBytes + 1
  // Constructed only where it is returned: an error carries a stack, and one per chunk of a 10 MB
  // line would cost more than the framing itself.
  const overflow = (): Effect.Effect<never, AgentError> => Effect.fail(lineOverflow(limitBytes))
  const arrived = bufferOf(chunk)
  const bytes = pending.bytes + chunk.byteLength
  const held: PendingLine = { chunks: [...pending.chunks, arrived], bytes }
  if (arrived.indexOf(lineFeed) < 0) {
    // No frame boundary here, so hold the chunk whole.
    return bytes > pendingLimitBytes ? overflow() : Effect.succeed({ state: held, emit: [] })
  }
  let buffer = joined(held)
  const emit: string[] = []
  for (;;) {
    const index = buffer.indexOf(lineFeed)
    if (index < 0) {
      break
    }
    const line = stripped(buffer.subarray(0, index))
    buffer = buffer.subarray(index + 1)
    if (line.byteLength > limitBytes) {
      return overflow()
    }
    emit.push(line.toString('utf8'))
  }
  if (buffer.byteLength > pendingLimitBytes) {
    return overflow()
  }
  return Effect.succeed({
    state:
      buffer.byteLength === 0 ? nothingPending : { chunks: [buffer], bytes: buffer.byteLength },
    emit,
  })
}

const framedLines = (
  limitBytes: number,
  options: Readonly<{ flushIncompleteTail: boolean }>,
): (<E, R>(self: Stream.Stream<Uint8Array, E, R>) => Stream.Stream<string, E | AgentError, R>) =>
  stateful<PendingLine, Uint8Array, string, AgentError>(
    nothingPending,
    (pending, chunk) => frame(limitBytes, pending, chunk),
    (pending) =>
      options.flushIncompleteTail && pending.bytes > 0
        ? [stripped(joined(pending)).toString('utf8')]
        : [],
  )

/**
 * The protocol reader: newline-framed lines, with the framing limit failing the stream. An
 * unterminated tail is dropped, because half a JSON-RPC message is not a message.
 */
export const protocolLines = (
  limitBytes: number,
): (<E, R>(self: Stream.Stream<Uint8Array, E, R>) => Stream.Stream<string, E | AgentError, R>) =>
  framedLines(limitBytes, { flushIncompleteTail: false })

/**
 * The diagnostic reader: the same framing, except that a tail left unterminated when the child's
 * stderr closes is a complete record. Diagnostics are written without a trailing newline often
 * enough — a dying process, a partial log line — that dropping one would silently lose the last
 * thing a failing session said.
 */
export const diagnosticLines = (
  limitBytes: number,
): (<E, R>(self: Stream.Stream<Uint8Array, E, R>) => Stream.Stream<string, E | AgentError, R>) =>
  framedLines(limitBytes, { flushIncompleteTail: true })

/** A PEM block being swallowed: what ends it, and whatever preceded it on its opening line. */
type PemCapture = Readonly<{ endMarker: string; prefix: string }>

const pemStart = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----/u

const redactedPem = (prefix: string): string => `${prefix}[REDACTED PEM PRIVATE KEY]`

const record = (
  capture: PemCapture | null,
  line: string,
): Readonly<{ state: PemCapture | null; emit: readonly string[] }> => {
  if (capture !== null) {
    return line.includes(capture.endMarker)
      ? { state: null, emit: [redactedPem(capture.prefix)] }
      : { state: capture, emit: [] }
  }
  const started = pemStart.exec(line)
  const label = started?.[1]
  if (started !== null && label !== undefined) {
    const endMarker = `-----END ${label}-----`
    if (line.slice(started.index + started[0].length).includes(endMarker)) {
      return { state: null, emit: [line.trim()] }
    }
    return { state: { endMarker, prefix: line.slice(0, started.index) }, emit: [] }
  }
  const message = line.trim()
  return { state: null, emit: message.length > 0 ? [message] : [] }
}

/**
 * Assembles complete diagnostic records out of framed lines, so redaction sees a whole one.
 *
 * A multiline PEM private key is only recognisable by its opening marker, and every line after it
 * is key material that no shape-based redactor can identify on its own. The block is therefore
 * swallowed until its end marker arrives and replaced by one redacted record; a block still open
 * when the stream ends is replaced too, rather than released for want of a terminator.
 */
export const diagnosticRecords = <E, R>(
  self: Stream.Stream<string, E, R>,
): Stream.Stream<string, E, R> =>
  self.pipe(
    stateful<PemCapture | null, string, string>(
      null,
      (capture, line) => Effect.succeed(record(capture, line)),
      (capture) => (capture === null ? [] : [redactedPem(capture.prefix)]),
    ),
  )
