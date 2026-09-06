import { Effect, Schema } from 'effect'
import type { ParseResult } from 'effect'
import { ActionFeedback } from './actions.js'
import { Identifier, Version } from './common.js'
import { Aggregate, AggregateItem, Alert, Detail, InstanceHealth } from './envelopes.js'

// Additive fields are discarded recursively. Required known fields are always strict.
export const decodeAggregate = Schema.decodeUnknown(Aggregate)
export const decodeItem = Schema.decodeUnknown(AggregateItem)
export const decodeHealth = Schema.decodeUnknown(InstanceHealth)
export const decodeAlert = Schema.decodeUnknown(Alert)
export const decodeDetail = Schema.decodeUnknown(Detail)
export const decodeActionFeedback = Schema.decodeUnknown(ActionFeedback)

const InstancePayload = Schema.Struct({ version: Version, items: Schema.Array(AggregateItem) })
export type InstanceResult =
  | Readonly<{
      instance_id: string
      status: 'compatible'
      items: readonly AggregateItem[]
    }>
  | Readonly<{
      instance_id: string
      status: 'incompatible'
      reason: 'unsupported-or-malformed-payload'
    }>

/** Registry identity is trusted only after decoding; a bad remote cannot poison other instances. */
export const decodeInstancePayload = (
  instanceId: unknown,
  payload: unknown,
): Effect.Effect<InstanceResult, ParseResult.ParseError> =>
  Effect.gen(function* () {
    const identity = yield* Schema.decodeUnknown(Identifier)(instanceId)
    return yield* Schema.decodeUnknown(InstancePayload)(payload).pipe(
      Effect.filterOrFail(
        (value) => value.items.every((item) => item.identity.instance_id === identity),
        () => 'identity-mismatch',
      ),
      Effect.match({
        onFailure: (): InstanceResult => ({
          instance_id: identity,
          status: 'incompatible',
          reason: 'unsupported-or-malformed-payload',
        }),
        onSuccess: (value): InstanceResult => ({
          instance_id: identity,
          status: 'compatible',
          items: value.items,
        }),
      }),
    )
  })
