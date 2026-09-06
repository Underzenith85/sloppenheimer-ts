import type { ActionFeedback } from './actions.js'
import type { Observation } from './common.js'
import type { Aggregate, AggregateItem, Detail, InstanceHealth } from './envelopes.js'

export const fixtureInstant = 1_788_732_000_000
export const observationFixture = (overrides: Partial<Observation> = {}): Observation => ({
  observed_at: fixtureInstant,
  source_at: {
    at: fixtureInstant - 100,
    clock: 'instance',
    calibration: { sampled_at: fixtureInstant, offset_ms: 100, uncertainty_ms: 50 },
  },
  last_attempt_at: fixtureInstant,
  condition: 'current',
  ...overrides,
})
export const itemFixture = (overrides: Partial<AggregateItem> = {}): AggregateItem => ({
  version: 1,
  identity: { instance_id: 'payments', issue_identifier: 'PAY-42' },
  execution: { process_id: 'boot-2', session_id: 'session-42', workflow_fingerprint: 'workflow-a' },
  issue_number: 42,
  title: 'Preserve pending settlements when a provider reconnects',
  bucket: 'ready',
  phase: 'dispatchable',
  attention: null,
  eligibility: 'eligible',
  priority: 1,
  unlocks: 3,
  reason: null,
  state_observation: observationFixture(),
  backlog_observation: observationFixture(),
  attention_onset: null,
  attention_first_observed_at: null,
  finished_at: null,
  blockers: [],
  capabilities: [{ action: 'start', available: true }],
  detail_available: true,
  retained_recovery: false,
  ...overrides,
})
export const healthFixture = (overrides: Partial<InstanceHealth> = {}): InstanceHealth => ({
  version: 1,
  instance_id: 'payments',
  display_name: 'Payments production',
  execution: { process_id: 'boot-2', session_id: null, workflow_fingerprint: 'workflow-a' },
  state: observationFixture(),
  backlog: observationFixture(),
  ...overrides,
})
export const aggregateFixture = (overrides: Partial<Aggregate> = {}): Aggregate => ({
  version: 1,
  generated_at: fixtureInstant,
  revision: 'aggregate-12',
  instances: [healthFixture()],
  items: [itemFixture()],
  alerts: [],
  ...overrides,
})
export const detailFixture = (overrides: Partial<Detail> = {}): Detail => ({
  version: 1,
  identity: itemFixture().identity,
  execution: itemFixture().execution,
  observed_at: fixtureInstant,
  result: {
    status: 'available',
    summary: 'Delivery retained after restart',
    events: [
      {
        at: { at: fixtureInstant - 5_000, clock: 'coordinator', calibration: null },
        message: 'Publication awaits recovery',
      },
    ],
  },
  ...overrides,
})
export const unknownActionFixture = (): ActionFeedback => ({
  version: 1,
  identity: itemFixture().identity,
  action: 'start',
  process_id: 'boot-2',
  workflow_fingerprint: 'workflow-a',
  outcome: {
    status: 'unknown',
    request_id: 'request-7',
    submitted_at: fixtureInstant,
    reason: 'Connection closed before the response arrived',
  },
})
export const allBucketsFixture = (): Aggregate =>
  aggregateFixture({
    items: [
      itemFixture(),
      itemFixture({
        identity: { instance_id: 'payments', issue_identifier: 'PAY-43' },
        issue_number: 43,
        bucket: 'blocked',
        phase: 'blocked',
        blockers: [itemFixture().identity],
        capabilities: [],
      }),
      itemFixture({
        identity: { instance_id: 'payments', issue_identifier: 'PAY-44' },
        issue_number: 44,
        bucket: 'progress',
        phase: 'running',
        capabilities: [{ action: 'pause', available: true }],
      }),
      itemFixture({
        identity: { instance_id: 'payments', issue_identifier: 'PAY-45' },
        issue_number: 45,
        bucket: 'attention',
        phase: 'running',
        attention: 'stalled',
        attention_first_observed_at: fixtureInstant,
        capabilities: [],
      }),
      itemFixture({
        identity: { instance_id: 'payments', issue_identifier: 'PAY-46' },
        issue_number: 46,
        bucket: 'finished',
        phase: 'merged',
        finished_at: { at: fixtureInstant - 60_000, clock: 'provider', calibration: null },
        capabilities: [],
      }),
    ],
  })

export const scenarioFixtures = (): Readonly<Record<string, Aggregate>> => {
  const stale = observationFixture({ condition: 'stale', observed_at: fixtureInstant - 45_000 })
  const incompatible = observationFixture({
    condition: 'incompatible',
    observed_at: null,
    source_at: null,
  })
  return {
    allBuckets: allBucketsFixture(),
    duplicateNumbers: aggregateFixture({
      instances: [
        healthFixture(),
        healthFixture({ instance_id: 'search', display_name: 'Search' }),
      ],
      items: [
        itemFixture(),
        itemFixture({
          identity: { instance_id: 'search', issue_identifier: 'SEARCH-42' },
          title:
            'Restore search indexing across regions after the upstream document stream reconnects without losing retained recovery work or duplicating completed batches',
        }),
      ],
    }),
    mixedFreshness: aggregateFixture({
      instances: [healthFixture({ backlog: stale })],
      items: [
        itemFixture({
          backlog_observation: stale,
          capabilities: [
            { action: 'start', available: false, reason: 'Backlog observation is stale' },
          ],
        }),
      ],
    }),
    incompatibleInstance: aggregateFixture({
      instances: [
        healthFixture(),
        healthFixture({
          instance_id: 'legacy',
          state: incompatible,
          backlog: incompatible,
          execution: null,
        }),
      ],
    }),
    noInstances: aggregateFixture({ instances: [], items: [] }),
    noMatchingRows: aggregateFixture({
      items: [
        itemFixture({
          bucket: 'finished',
          phase: 'merged',
          finished_at: { at: fixtureInstant - 60_000, clock: 'provider', calibration: null },
        }),
      ],
    }),
    retainedRecovery: aggregateFixture({
      items: [
        itemFixture({
          bucket: 'attention',
          phase: 'delivering',
          attention: 'recovery_failed',
          retained_recovery: true,
          execution: null,
          detail_available: false,
          attention_first_observed_at: fixtureInstant,
          reason: 'Worktree retained; publication recovery exhausted',
          capabilities: [{ action: 'resume', available: true }],
        }),
      ],
    }),
  }
}
