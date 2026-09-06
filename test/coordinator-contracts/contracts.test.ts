import { Effect, Either, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { ActionFeedback, RefreshScope } from '@sloppenheimer/coordinator-contracts/actions.js'
import { WorkIdentity, detailRoute, workKey } from '@sloppenheimer/coordinator-contracts/common.js'
import {
  decodeAggregate,
  decodeInstancePayload,
} from '@sloppenheimer/coordinator-contracts/decode.js'
import { Aggregate, Detail } from '@sloppenheimer/coordinator-contracts/envelopes.js'
import {
  aggregateFixture,
  detailFixture,
  fixtureInstant,
  itemFixture,
  scenarioFixtures,
  unknownActionFixture,
} from '@sloppenheimer/coordinator-contracts/fixtures.js'
import {
  browserFreshness,
  sourceCondition,
} from '@sloppenheimer/coordinator-contracts/freshness.js'
import { compareItems } from '@sloppenheimer/coordinator-contracts/ordering.js'

describe('coordinator wire boundaries', () => {
  it('decodes every shared realistic scenario and on-demand detail', () => {
    for (const fixture of Object.values(scenarioFixtures())) {
      expect(Schema.decodeUnknownEither(Aggregate)(fixture)._tag).toBe('Right')
    }
    expect(Schema.decodeUnknownEither(Detail)(detailFixture())._tag).toBe('Right')
    expect(Schema.decodeUnknownEither(ActionFeedback)(unknownActionFixture())._tag).toBe('Right')
  })
  it.each([
    { version: 2 },
    { generated_at: 'yesterday' },
    { generated_at: -1 },
    { generated_at: Number.NaN },
    { items: [{}] },
    { instances: [{}] },
    { alerts: [{}] },
    {
      items: [
        itemFixture({
          state_observation: {
            observed_at: null,
            source_at: null,
            last_attempt_at: null,
            condition: 'current',
          },
        }),
      ],
    },
  ])('rejects malformed coordinator-owned payloads: %j', (patch) => {
    expect(Schema.decodeUnknownEither(Aggregate)({ ...aggregateFixture(), ...patch })._tag).toBe(
      'Left',
    )
  })
  it('discards additive fields without weakening known fields', async () => {
    const decoded = await Effect.runPromise(
      decodeAggregate({
        ...aggregateFixture(),
        future: 'ignored',
        items: [{ ...itemFixture(), future: { secret: 'discard' } }],
      }),
    )
    expect(decoded).toEqual(aggregateFixture())
  })
  it.each(['instance', 'coordinator', 'provider', null])(
    'only accepts provider completion timestamps or unknown completion: %s',
    (clock) => {
      const payload = aggregateFixture({
        items: [itemFixture({ bucket: 'finished' })],
      })
      const decoded = Schema.decodeUnknownEither(Aggregate)({
        ...payload,
        items: payload.items.map((item) => ({
          ...item,
          finished_at: clock === null ? null : { at: fixtureInstant, clock, calibration: null },
        })),
      })
      expect(decoded._tag).toBe(clock === 'provider' || clock === null ? 'Right' : 'Left')
    },
  )
  it('isolates version, malformed and identity failures to the offending instance', async () => {
    const values = await Effect.runPromise(
      Effect.all([
        decodeInstancePayload('payments', { version: 1, items: [itemFixture()] }),
        decodeInstancePayload('legacy', { version: 2, items: [] }),
        decodeInstancePayload('broken', { version: 1, items: [{}] }),
        decodeInstancePayload('spoofed', { version: 1, items: [itemFixture()] }),
      ]),
    )
    expect(values.map((value) => value.status)).toEqual([
      'compatible',
      'incompatible',
      'incompatible',
      'incompatible',
    ])
  })
  it('requires evidence for confirmed actions and separate refresh targets', () => {
    const feedback = unknownActionFixture()
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(ActionFeedback)({
          ...feedback,
          outcome: { status: 'confirmed' },
        }),
      ),
    ).toBe(true)
    for (const scope of [
      { kind: 'aggregate' },
      { kind: 'instance-state', instance_id: 'payments' },
      { kind: 'instance-backlog', instance_id: 'payments' },
      { kind: 'issue-detail', identity: feedback.identity },
    ]) {
      expect(Schema.decodeUnknownEither(RefreshScope)(scope)._tag).toBe('Right')
    }
  })
  it.each([undefined, '', 'Observed paused eligibility', 'x'.repeat(16_385)])(
    'requires non-empty bounded confirmation evidence',
    (evidence) => {
      const decoded = Schema.decodeUnknownEither(ActionFeedback)({
        ...unknownActionFixture(),
        outcome: {
          status: 'confirmed',
          request_id: 'pause-request',
          submitted_at: fixtureInstant - 1,
          observed_at: fixtureInstant,
          evidence,
        },
      })
      expect(decoded._tag).toBe(evidence === 'Observed paused eligibility' ? 'Right' : 'Left')
    },
  )
})

describe('identity, freshness and deterministic ordering', () => {
  it('keeps duplicate numbers distinct and escapes routing delimiters', () => {
    const first = { instance_id: 'a/b', issue_identifier: '42?#' }
    const second = { instance_id: 'a', issue_identifier: 'b/42?#' }
    expect(workKey(first)).not.toBe(workKey(second))
    expect(detailRoute(first)).toBe('/instances/%22a%2Fb%22/issues/%2242%3F%23%22')
  })
  it.each(['.', '..', '\ud800', '\udfff', '%2e%2e', 'a/b?#', '"\\', '日本語😀'])(
    'preserves opaque identity through browser URL resolution: %j',
    (identifier) => {
      const identity = { instance_id: identifier, issue_identifier: identifier }
      expect(Schema.decodeUnknownEither(WorkIdentity)(identity)._tag).toBe('Right')
      const route = detailRoute(identity)
      const url = new URL(route, 'https://coordinator.example/')
      expect(url.pathname).toBe(route)
      expect(url.search).toBe('')
      expect(url.hash).toBe('')
      const segments = url.pathname.split('/')
      expect(segments).toHaveLength(5)
      for (const segment of [segments[2], segments[4]]) {
        expect(JSON.parse(decodeURIComponent(segment ?? ''))).toBe(identifier)
      }
    },
  )
  it('transitions exactly at source thresholds and recovers on a compatible observation', () => {
    expect(sourceCondition(0, null, null, false)).toBe('never-observed')
    expect(sourceCondition(29_999, 0, 0, false)).toBe('current')
    expect(sourceCondition(30_000, 0, 0, false)).toBe('stale')
    expect(sourceCondition(120_000, 0, 0, false)).toBe('unreachable')
    expect(sourceCondition(120_000, null, 0, false)).toBe('unreachable')
    expect(sourceCondition(120_000, 120_000, 0, false)).toBe('current')
    expect(sourceCondition(120_000, 120_000, 0, true)).toBe('incompatible')
  })
  it('ages cached aggregates independently from instance health', () => {
    expect(browserFreshness(null, 0)).toBe('never-observed')
    expect(browserFreshness(14_999, 0)).toBe('current')
    expect(browserFreshness(15_000, 0)).toBe('stale')
    expect(browserFreshness(60_000, 0)).toBe('unreachable')
    expect(browserFreshness(0, 60_000)).toBe('unreachable')
    expect(browserFreshness(10_000, 5_000)).toBe('stale')
  })
  it.each(['attention', 'ready', 'blocked', 'progress', 'finished'] as const)(
    'breaks %s ties by full identity without mutating rows',
    (bucket) => {
      const first = itemFixture({ bucket, identity: { instance_id: 'a', issue_identifier: '42' } })
      const second = itemFixture({ bucket, identity: { instance_id: 'b', issue_identifier: '42' } })
      expect(compareItems(first, second)).toBeLessThan(0)
      expect(compareItems(second, first)).toBeGreaterThan(0)
      expect(compareItems(first, first)).toBe(0)
    },
  )
  it('sorts recent completions first and unknown completion dates last', () => {
    const recent = itemFixture({
      bucket: 'finished',
      finished_at: { at: fixtureInstant, clock: 'provider', calibration: null },
    })
    const old = itemFixture({
      bucket: 'finished',
      finished_at: { at: fixtureInstant - 1, clock: 'provider', calibration: null },
    })
    expect(compareItems(recent, old)).toBeLessThan(0)
    expect(compareItems(recent, itemFixture({ bucket: 'finished' }))).toBeLessThan(0)
  })
})
