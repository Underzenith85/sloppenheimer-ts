import { Schema } from 'effect'
import { Capability } from './actions.js'
import {
  Count,
  Identifier,
  Observation,
  ProcessIdentity,
  Provenance,
  Text,
  Timestamp,
  Version,
  WorkIdentity,
} from './common.js'

export const AggregateItem = Schema.Struct({
  version: Version,
  identity: WorkIdentity,
  execution: Schema.NullOr(ProcessIdentity),
  issue_number: Schema.NullOr(Count),
  title: Text,
  bucket: Schema.Literal('attention', 'ready', 'blocked', 'progress', 'finished'),
  phase: Identifier,
  attention: Schema.NullOr(Identifier),
  eligibility: Schema.Literal('eligible', 'paused', 'not_eligible'),
  priority: Schema.NullOr(Count),
  unlocks: Count,
  reason: Schema.NullOr(Text),
  state_observation: Observation,
  backlog_observation: Observation,
  attention_onset: Schema.NullOr(Provenance),
  attention_first_observed_at: Schema.NullOr(Timestamp),
  finished_at: Schema.NullOr(Provenance),
  blockers: Schema.Array(WorkIdentity),
  capabilities: Schema.Array(Capability),
  detail_available: Schema.Boolean,
  retained_recovery: Schema.Boolean,
})
export type AggregateItem = typeof AggregateItem.Type
export const InstanceHealth = Schema.Struct({
  version: Version,
  instance_id: Identifier,
  display_name: Text,
  execution: Schema.NullOr(ProcessIdentity),
  state: Observation,
  backlog: Observation,
})
export type InstanceHealth = typeof InstanceHealth.Type
export const Alert = Schema.Struct({
  version: Version,
  alert_id: Identifier,
  instance_id: Schema.NullOr(Identifier),
  identity: Schema.NullOr(WorkIdentity),
  severity: Schema.Literal('info', 'warning', 'error'),
  code: Identifier,
  message: Text,
  onset: Schema.NullOr(Provenance),
  first_observed_at: Timestamp,
})
export type Alert = typeof Alert.Type
export const Aggregate = Schema.Struct({
  version: Version,
  generated_at: Timestamp,
  revision: Identifier,
  instances: Schema.Array(InstanceHealth),
  items: Schema.Array(AggregateItem),
  alerts: Schema.Array(Alert),
})
export type Aggregate = typeof Aggregate.Type
export const Detail = Schema.Struct({
  version: Version,
  identity: WorkIdentity,
  execution: Schema.NullOr(ProcessIdentity),
  observed_at: Timestamp,
  result: Schema.Union(
    Schema.Struct({
      status: Schema.Literal('available'),
      summary: Text,
      events: Schema.Array(Schema.Struct({ at: Provenance, message: Text })),
    }),
    Schema.Struct({
      status: Schema.Literal('not-retained', 'unreachable', 'incompatible'),
      reason: Text,
    }),
  ),
})
export type Detail = typeof Detail.Type
