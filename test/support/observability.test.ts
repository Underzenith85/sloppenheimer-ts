import { it } from '@effect/vitest'
import { Effect, Fiber, Metric, Option, TestClock, Tracer } from 'effect'
import { describe, expect } from 'vitest'

import {
  dispatchOutcomes,
  observeDuration,
  pollDuration,
  protectTracer,
  recordOutcome,
  safelyRecord,
  setRuntimeGauges,
  retryingAgents,
  runningAgents,
  withOperationalSpan,
} from '@sloppenheimer/core/support/observability.js'

describe('operational observability', (): void => {
  it.effect('records bounded outcomes and gauges from Effect services', () =>
    Effect.gen(function* () {
      const startedDispatches = Metric.tagged(dispatchOutcomes, 'outcome', 'started')
      const before = yield* Metric.value(startedDispatches)
      yield* recordOutcome(dispatchOutcomes, 'started')
      yield* setRuntimeGauges(3, 2)

      const dispatch = yield* Metric.value(startedDispatches)
      const running = yield* Metric.value(runningAgents)
      const retrying = yield* Metric.value(retryingAgents)
      const operational = (yield* Metric.snapshot).filter((pair) =>
        pair.metricKey.name.startsWith('sloppenheimer_'),
      )
      expect(dispatch.count).toBe(before.count + 1)
      expect(running.value).toBe(3)
      expect(retrying.value).toBe(2)
      expect(operational.flatMap((pair) => pair.metricKey.tags.map((label) => label.key))).toEqual(
        expect.arrayContaining(['outcome']),
      )
      expect(
        operational
          .flatMap((pair) => pair.metricKey.tags)
          .every((label) => label.key === 'outcome' || label.key === 'time_unit'),
      ).toBe(true)
    }),
  )

  it.effect('measures failures with the deterministic Effect clock', () =>
    Effect.gen(function* () {
      const before = yield* Metric.value(pollDuration)
      const fiber = yield* Effect.fork(
        observeDuration(
          pollDuration,
          Effect.sleep('2 seconds').pipe(Effect.zipRight(Effect.fail('x'))),
        ),
      )
      yield* TestClock.adjust('2 seconds')
      yield* Effect.exit(Fiber.join(fiber))
      const after = yield* Metric.value(pollDuration)

      expect(after.count).toBe(before.count + 1)
      expect(after.sum).toBe(before.sum + 2_000)
    }),
  )

  it.effect('contains metric and tracing sink defects', () => {
    const throwingTracer = Tracer.make({
      span: () => {
        throw new Error('exporter unavailable')
      },
      context: (evaluate) => evaluate(),
    })
    return Effect.gen(function* () {
      yield* safelyRecord(Effect.die('metric exporter unavailable'))
      const value = yield* Effect.succeed(42).pipe(
        withOperationalSpan('test.operation'),
        Effect.withTracer(protectTracer(throwingTracer)),
      )
      expect(value).toBe(42)
    })
  })

  it.effect('preserves native parent-child span relationships', () => {
    const observed: Array<readonly [string, string | null]> = []
    let nextId = 0
    const tracer = Tracer.make({
      span: (name, parent, context, links, startTime, kind) => {
        const spanId = `span-${String(++nextId)}`
        observed.push([
          name,
          Option.match(parent, { onNone: () => null, onSome: (span) => span.spanId }),
        ])
        return {
          _tag: 'Span',
          name,
          spanId,
          traceId: 'trace',
          parent,
          context,
          status: { _tag: 'Started', startTime },
          attributes: new Map(),
          links,
          sampled: true,
          kind,
          end: (): void => undefined,
          attribute: (): void => undefined,
          event: (): void => undefined,
          addLinks: (): void => undefined,
        }
      },
      context: (evaluate) => evaluate(),
    })
    return Effect.void.pipe(
      withOperationalSpan('poll.dispatch'),
      withOperationalSpan('poll'),
      Effect.withTracer(tracer),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(observed).toEqual([
            ['poll', null],
            ['poll.dispatch', 'span-1'],
          ])
        }),
      ),
    )
  })
})
