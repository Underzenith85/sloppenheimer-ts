import { Clock, Context, Duration, Effect, Metric, Option, Tracer, type Exit } from 'effect'

/** The fixed outcome vocabulary is deliberately exported so adapters cannot invent labels. */
export type DispatchOutcome = 'started' | 'already_running' | 'preflight_failed' | 'prompt_failed'
export type RetryOutcome = 'scheduled' | 'not_retryable'
export type ValidationOutcome = 'succeeded' | 'credential_failed' | 'reload_failed' | 'ports_failed'
export type HandoffOutcome = 'completed' | 'failed' | 'no_branch' | 'merged' | 'intervention'
export type AgentOutcome = 'normal' | 'failed' | 'cancelled' | 'stalled'
export type OperationalOutcome =
  | DispatchOutcome
  | RetryOutcome
  | ValidationOutcome
  | HandoffOutcome
  | AgentOutcome

export const dispatchOutcomes = Metric.counter('sloppenheimer_dispatch_total', {
  description: 'Dispatch attempts by bounded outcome.',
})
export const retryOutcomes = Metric.counter('sloppenheimer_retry_total', {
  description: 'Retry decisions by bounded outcome.',
})
export const validationOutcomes = Metric.counter('sloppenheimer_workflow_validation_total', {
  description: 'Workflow validation attempts by bounded outcome.',
})
export const handoffOutcomes = Metric.counter('sloppenheimer_handoff_total', {
  description: 'Completed-work handoff transitions by bounded outcome.',
})
export const agentOutcomes = Metric.counter('sloppenheimer_agent_total', {
  description: 'Agent exits by bounded outcome.',
})

export const pollDuration = Metric.timer('sloppenheimer_poll_duration', 'Poll pass latency.')
export const agentDuration = Metric.timer('sloppenheimer_agent_duration', 'Agent run latency.')
export const runningAgents = Metric.gauge('sloppenheimer_running_agents', {
  description: 'Agents present in the runtime running map.',
})
export const retryingAgents = Metric.gauge('sloppenheimer_retrying_agents', {
  description: 'Retries present in the runtime retry map.',
})

/** Metric recording is supplemental: a broken hook must not become an orchestration failure. */
export const safelyRecord = (record: Effect.Effect<void>): Effect.Effect<void> =>
  record.pipe(Effect.catchAllCause(() => Effect.void))

export const recordOutcome = (
  metric: Metric.Metric.Counter<number>,
  outcome: OperationalOutcome,
): Effect.Effect<void> => safelyRecord(Metric.increment(Metric.tagged(metric, 'outcome', outcome)))

export const setRuntimeGauges = (running: number, retrying: number): Effect.Effect<void> =>
  safelyRecord(
    Effect.all([Metric.set(runningAgents, running), Metric.set(retryingAgents, retrying)], {
      discard: true,
    }),
  )

/** Times success and failure with the Effect clock, which makes tests deterministic. */
export const observeDuration = <A, E, R, Type, Out>(
  metric: Metric.Metric<Type, Duration.Duration, Out>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
    effect.pipe(
      Effect.ensuring(
        Effect.flatMap(Clock.currentTimeMillis, (finishedAt) =>
          safelyRecord(Metric.update(metric, Duration.millis(Math.max(0, finishedAt - startedAt)))),
        ),
      ),
    ),
  )

/** Adds one native span without coupling callers to an exporter implementation. */
export const withOperationalSpan =
  (name: string, attributes: Readonly<Record<string, unknown>> = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.withSpan(name, { attributes: { component: 'sloppenheimer', ...attributes } }),
    )

const fallbackSpan = (
  name: string,
  parent: Option.Option<Tracer.AnySpan>,
  context: Context.Context<never>,
  links: ReadonlyArray<Tracer.SpanLink>,
  startTime: bigint,
  kind: Tracer.SpanKind,
): Tracer.Span => {
  let status: Tracer.SpanStatus = { _tag: 'Started', startTime }
  const attributes = new Map<string, unknown>()
  return {
    _tag: 'Span',
    name,
    spanId: 'telemetry-fallback',
    traceId: 'telemetry-fallback',
    parent,
    context,
    get status() {
      return status
    },
    attributes,
    links,
    sampled: false,
    kind,
    end: (endTime: bigint, exit: Exit.Exit<unknown, unknown>) => {
      status = { _tag: 'Ended', startTime, endTime, exit }
    },
    attribute: (key, value) => {
      attributes.set(key, value)
    },
    event: () => undefined,
    addLinks: () => undefined,
  }
}

const protectedSpan = (span: Tracer.Span): Tracer.Span => ({
  ...span,
  end: (...argumentsValue) => {
    try {
      span.end(...argumentsValue)
    } catch {
      // Exporting a completed span is supplemental.
    }
  },
  attribute: (...argumentsValue) => {
    try {
      span.attribute(...argumentsValue)
    } catch {
      // Exporting an annotation is supplemental.
    }
  },
  event: (...argumentsValue) => {
    try {
      span.event(...argumentsValue)
    } catch {
      // Exporting an event is supplemental.
    }
  },
  addLinks: (...argumentsValue) => {
    try {
      span.addLinks(...argumentsValue)
    } catch {
      // Exporting links is supplemental.
    }
  },
})

/** Shields orchestration from a tracer/exporter that throws synchronously. */
export const protectTracer = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span: (name, parent, context, links, startTime, kind, options) => {
      try {
        return protectedSpan(tracer.span(name, parent, context, links, startTime, kind, options))
      } catch {
        return fallbackSpan(name, parent, context, links, startTime, kind)
      }
    },
    context: (evaluate, fiber) => {
      try {
        return tracer.context(evaluate, fiber)
      } catch {
        return evaluate()
      }
    },
  })

/** Composition-root guard for whichever tracer/exporter layer an operator installs. */
export const withProtectedTracer = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.tracerWith((tracer) => effect.pipe(Effect.withTracer(protectTracer(tracer))))
