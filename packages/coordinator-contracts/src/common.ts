import { Schema } from 'effect'

export const Identifier = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512))
export const Text = Schema.String.pipe(Schema.maxLength(16_384))
/** UTC Unix milliseconds, supplied by the named clock, never inferred from serialization time. */
export const Timestamp = Schema.Number.pipe(Schema.int(), Schema.nonNegative(), Schema.finite())
export const Count = Schema.Number.pipe(Schema.int(), Schema.nonNegative(), Schema.finite())
export const Version = Schema.Literal(1)
export const WorkIdentity = Schema.Struct({ instance_id: Identifier, issue_identifier: Identifier })
export type WorkIdentity = typeof WorkIdentity.Type
export const ProcessIdentity = Schema.Struct({
  process_id: Identifier,
  session_id: Schema.NullOr(Identifier),
  workflow_fingerprint: Identifier,
})
export const Calibration = Schema.Struct({
  sampled_at: Timestamp,
  offset_ms: Schema.Number.pipe(Schema.finite()),
  uncertainty_ms: Count,
})
export const Provenance = Schema.Struct({
  at: Timestamp,
  clock: Schema.Literal('instance', 'coordinator', 'provider'),
  calibration: Schema.NullOr(Calibration),
})
export const Observation = Schema.Struct({
  observed_at: Schema.NullOr(Timestamp),
  source_at: Schema.NullOr(Provenance),
  last_attempt_at: Schema.NullOr(Timestamp),
  condition: Schema.Literal('never-observed', 'current', 'stale', 'unreachable', 'incompatible'),
}).pipe(
  Schema.filter((value) =>
    value.condition === 'never-observed'
      ? value.observed_at === null && value.source_at === null
      : value.condition === 'current' || value.condition === 'stale'
        ? value.observed_at !== null
        : true,
  ),
)
export type Observation = typeof Observation.Type

/** JSON tuple encoding avoids collisions even when identifiers contain route delimiters. */
export const workKey = (identity: WorkIdentity): string =>
  JSON.stringify([identity.instance_id, identity.issue_identifier])

export const detailRoute = (identity: WorkIdentity): string =>
  `/instances/${encodeURIComponent(identity.instance_id)}/issues/${encodeURIComponent(identity.issue_identifier)}`
