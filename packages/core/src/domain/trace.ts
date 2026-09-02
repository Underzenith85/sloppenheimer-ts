/**
 * The runner-neutral vocabulary of a durable agent trace.
 *
 * The operator timeline in `telemetry/` is deliberately a compressed activity summary: reasoning is
 * a bare fact, messages are collapsed, a command is its program word and an argument count, a tool
 * call is a name and two byte counts, and only the last two hundred events of an issue are kept in
 * memory. That is the right shape for "is this host healthy", and it is the wrong shape for "what
 * did this agent actually do" — which is the question this vocabulary exists to answer.
 *
 * Three rules define it, and each is a rule rather than a default:
 *
 * - **Observable only.** A trace carries what the host can legitimately see on the runner's
 *   protocol. A human-readable reasoning *summary* a runner chooses to emit is retained and is
 *   labeled as a summary ({@link TraceBody} `reasoning_summary`), so nothing downstream can present
 *   it as the model's reasoning. Encrypted or otherwise private reasoning content is never decoded,
 *   never requested as a way of obtaining a disclosure, and has no representation here at all.
 * - **Bounded, never summarized.** Whitespace, command arguments, stdout, stderr and tool payloads
 *   are retained as they arrived. What bounds them is an explicit byte ceiling per field and per
 *   event, and every cut is reported as a {@link FieldTruncation} on the event that carries it.
 * - **Runner-neutral.** Nothing here names a backend. An adapter decodes its own protocol into a
 *   {@link TraceObservation}; `packages/core` never reads a backend's wire shapes, exactly as
 *   `AgentEvent` already requires.
 *
 * The events themselves are persisted outside the actor's bounded runtime state — see
 * `core/trace-store.ts` — so an operator can page a whole session without the scheduler holding it.
 */

import type { FieldTruncation } from '../support/high-fidelity.js'
import type { JsonValue } from '../support/json.js'

export type { FieldTruncation } from '../support/high-fidelity.js'

/** What kind of thing happened, and the first axis the console filters on. */
export type TraceCategory =
  | 'lifecycle'
  | 'message'
  | 'reasoning_summary'
  | 'command'
  | 'tool'
  | 'file'
  | 'approval'
  | 'usage'
  | 'retry'
  | 'cancellation'
  | 'handoff'
  | 'error'
  | 'unknown'

export const traceCategories: readonly TraceCategory[] = [
  'lifecycle',
  'message',
  'reasoning_summary',
  'command',
  'tool',
  'file',
  'approval',
  'usage',
  'retry',
  'cancellation',
  'handoff',
  'error',
  'unknown',
]

/**
 * How the thing turned out. Every event carries one, including the ones for which it is only ever
 * `informational`, so that filtering by outcome is a single comparison rather than a walk into each
 * body's own vocabulary.
 */
export type TraceOutcome =
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'approved'
  | 'withheld'
  | 'informational'

export const traceOutcomes: readonly TraceOutcome[] = [
  'started',
  'succeeded',
  'failed',
  'cancelled',
  'approved',
  'withheld',
  'informational',
]

export type TraceFileChangeKind = 'add' | 'update' | 'delete' | 'unknown'

/**
 * One file a change item reported touching. `patch` is the runner's own diff text where it supplied
 * one, and `null` where it did not: the host never reads the worktree to manufacture one, because a
 * patch reconstructed after the fact is not what the agent did.
 */
export type TraceFileChange = Readonly<{
  path: string
  change: TraceFileChangeKind
  addedLines: number | null
  deletedLines: number | null
  patch: string | null
}>

/**
 * One top-level field of a protocol message nothing recognized: its name, its JSON type, its size,
 * and — for a scalar — its redacted value.
 *
 * An unrecognized message is neither dropped nor stored as a raw envelope. Dropping it would leave
 * a hole in the reconstruction, and storing the envelope would retain, by default, a shape no
 * redactor was written against. Naming the fields and rendering only the scalars is what sits
 * between the two.
 */
export type TraceField = Readonly<{
  name: string
  type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'
  /** The redacted, bounded scalar rendering, or `null` where the field held a container. */
  value: string | null
  bytes: number
}>

export type TraceBody =
  /** A transition on the session itself: a run, a session, or a turn starting or settling. */
  | Readonly<{ kind: 'lifecycle'; phase: string; detail: string | null }>
  | Readonly<{ kind: 'message'; role: 'assistant' | 'user'; text: string }>
  /**
   * A human-readable reasoning *summary* a runner emitted, labeled as one. Never private
   * chain-of-thought, which the host does not decode and does not hold.
   */
  | Readonly<{ kind: 'reasoning_summary'; text: string }>
  | Readonly<{
      kind: 'command'
      commandLine: string
      stdout: string | null
      stderr: string | null
      exitCode: number | null
      durationMs: number | null
    }>
  | Readonly<{
      kind: 'tool'
      name: string
      arguments: JsonValue | null
      result: JsonValue | null
      durationMs: number | null
    }>
  | Readonly<{ kind: 'file'; files: readonly TraceFileChange[] }>
  | Readonly<{ kind: 'approval'; subject: string; decision: string }>
  | Readonly<{
      kind: 'usage'
      inputTokens: number
      outputTokens: number
      totalTokens: number
      rateLimits: JsonValue | null
    }>
  | Readonly<{ kind: 'retry'; attempt: number; dueAt: string | null; reason: string | null }>
  | Readonly<{ kind: 'cancellation'; reason: string }>
  | Readonly<{ kind: 'handoff'; step: string; status: string; message: string | null }>
  | Readonly<{ kind: 'error'; severity: 'warning' | 'error'; code: string | null; message: string }>
  | Readonly<{ kind: 'unknown'; fields: readonly TraceField[] }>

/**
 * What an adapter produces for one protocol message: the reading, and what the redactor and the
 * ceilings did to it on the way. The identity and the ordering are the recorder's to add, because
 * only the host knows which run and which attempt the message belongs to.
 */
export type TraceObservation = Readonly<{
  category: TraceCategory
  outcome: TraceOutcome
  body: TraceBody
  /** Whether anything in this observation was removed by the redactor. Never inferred later. */
  redacted: boolean
  truncations: readonly FieldTruncation[]
}>

/**
 * One persisted record. Identity is carried on every event rather than in a header, because the
 * file is append-only and a reader may start anywhere in it — and because these are the identifiers
 * host operational observability correlates against.
 */
export type TraceEvent = Readonly<{
  version: 1
  /** Monotonic per issue, across runs and across restarts. */
  sequence: number
  recordedAt: string
  issueId: string
  identifier: string
  runId: number
  attempt: number
  threadId: string | null
  turnId: string | null
  sessionId: string | null
  turnCount: number
  /** The runner's own name for the message, kept verbatim so a trace can be read beside a log. */
  event: string
  category: TraceCategory
  outcome: TraceOutcome
  body: TraceBody
  redacted: boolean
  truncations: readonly FieldTruncation[]
}>

/**
 * The ceilings a runner applies while it builds observations. It travels on the launch rather than
 * being read from configuration by the adapter, so a runner cannot capture at a fidelity the
 * operator did not ask for, and a runner with capture off does no redaction work at all.
 */
export type TraceCapture = Readonly<{
  enabled: boolean
  fieldLimitBytes: number
  eventLimitBytes: number
}>

/** What a host with high-fidelity capture switched off hands a runner. */
export const traceCaptureDisabled: TraceCapture = Object.freeze({
  enabled: false,
  fieldLimitBytes: 0,
  eventLimitBytes: 0,
})

/**
 * Every bound the trace is subject to, in one value the operator API publishes verbatim: an
 * operator reading a truncated field is entitled to see the number that truncated it.
 */
export type TraceLimits = Readonly<{
  fieldLimitBytes: number
  eventLimitBytes: number
  /** The most one run's segment may hold. A run that reaches it stops appending and says so. */
  sessionLimitBytes: number
  /** The most every retained trace may hold together. Oldest segments are evicted first. */
  totalLimitBytes: number
  /** How long a segment is retained. `0` retains until the size ceiling evicts it. */
  retentionMs: number
}>

/**
 * The record of one segment this host deleted, and why. Evictions are published beside the limits
 * for the same reason: retention that removed an operator's evidence has to be visible as an
 * answer rather than as an absence.
 */
export type TraceEviction = Readonly<{
  identifier: string
  runId: number
  startedAt: string
  bytes: number
  reason: 'age' | 'total_size'
  evictedAt: string
}>

/** How much of an event's own budget the observation has already spent. */
export const observationBytes = (observation: TraceObservation): number =>
  Buffer.byteLength(JSON.stringify(observation.body) ?? '', 'utf8')
