import { Schema } from 'effect'
import { Identifier, Text, Timestamp, Version, WorkIdentity } from './common.js'

export const Action = Schema.Literal('start', 'queue', 'pause', 'resume')
export const Capability = Schema.Union(
  Schema.Struct({ action: Action, available: Schema.Literal(true) }),
  Schema.Struct({ action: Action, available: Schema.Literal(false), reason: Text }),
)
export const RefreshScope = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('aggregate') }),
  Schema.Struct({
    kind: Schema.Literal('instance-state', 'instance-backlog'),
    instance_id: Identifier,
  }),
  Schema.Struct({ kind: Schema.Literal('issue-detail'), identity: WorkIdentity }),
)
const request = { request_id: Identifier, submitted_at: Timestamp }
export const ActionOutcome = Schema.Union(
  Schema.Struct({ status: Schema.Literal('idle') }),
  Schema.Struct({ status: Schema.Literal('submitting'), ...request }),
  Schema.Struct({
    status: Schema.Literal('accepted-awaiting-observation'),
    ...request,
    accepted_at: Timestamp,
  }),
  Schema.Struct({
    status: Schema.Literal('confirmed'),
    ...request,
    observed_at: Timestamp,
    evidence: Text,
  }),
  Schema.Struct({ status: Schema.Literal('rejected'), ...request, reason: Text }),
  Schema.Struct({ status: Schema.Literal('unknown'), ...request, reason: Text }),
)
export type Capability = typeof Capability.Type
export type RefreshScope = typeof RefreshScope.Type
export type ActionOutcome = typeof ActionOutcome.Type
export const ActionFeedback = Schema.Struct({
  version: Version,
  identity: WorkIdentity,
  action: Action,
  process_id: Identifier,
  workflow_fingerprint: Identifier,
  outcome: ActionOutcome,
})
export type ActionFeedback = typeof ActionFeedback.Type
