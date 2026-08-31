/**
 * Schema tooling for the wire formats Symphony reads but does not define.
 *
 * A protocol payload is not configuration. It arrives from another program, at a version Symphony
 * does not pin, and a field reported in an unexpected shape must degrade to absence rather than
 * fail the turn that carried it. These combinators keep that tolerance in the schema layer, stated
 * once, rather than repeated as a defensive test at every field read.
 *
 * The tolerance is deliberately asymmetric: a *record* that is not a record fails, because there is
 * nothing to read; a *field* that is missing or malformed reads as `null`, because the rest of the
 * record is still worth having.
 */

import { Either, Schema } from 'effect'

/** Rejects arrays and `null`, which `typeof value === 'object'` accepts and no record ever is. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A protocol record read as-is: key spellings untouched, values still unknown. */
export const protocolRecord = Schema.declare(isRecord)

/**
 * The camelCase spelling of a protocol key. A leading underscore is left alone: it is part of the
 * name rather than a word separator, and renaming it would invent a field the payload never sent.
 */
const camelCased = (key: string): string =>
  key.replace(/(?<!^)_+([a-z0-9])/gu, (_match, character: string) => character.toUpperCase())

/**
 * The single expression of the App Server's dual casing. The protocol reports the same field as
 * `used_percent` and as `usedPercent` depending on which notification carries it, so every record
 * is normalized to the camelCase spelling on the way in and each schema below names its fields
 * once.
 *
 * A spelling the payload states outright wins over one derived from another key, so a record
 * carrying both keeps the camelCase value.
 */
const withCamelCasedKeys = (record: Record<string, unknown>): Record<string, unknown> => {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    const camel = camelCased(key)
    if (key === camel || !(camel in record)) {
      normalized[camel] = value
    }
  }
  return normalized
}

/** Any value at all, read as `null`. Last in a union, it makes the union total. */
const unrecognized = Schema.transform(Schema.Unknown, Schema.Null, {
  strict: false,
  decode: () => null,
  encode: () => null,
})

/**
 * A field that reads as `null` when it is absent, or present in a shape this schema does not
 * recognize, instead of failing the record it appears in. An unrecognized item type or a missing
 * usage field is a gap in what an operator is shown, never a failed turn.
 */
export const tolerant = <A, I>(
  schema: Schema.Schema<A, I>,
): Schema.PropertySignature<':', A | null, never, '?:', unknown, true, never> =>
  Schema.optionalWith(Schema.Union(schema, unrecognized), { default: (): A | null => null })

/**
 * One record of a protocol payload: casing normalized once, then read as a struct whose fields are
 * each individually tolerant. Unknown keys are ignored, so a field the protocol adds later cannot
 * fail a message Symphony already understands.
 */
export const protocolStruct = <Fields extends Schema.Struct.Fields>(
  fields: Fields,
): Schema.Schema<
  Schema.Simplify<Schema.Struct.Type<Fields>>,
  Record<string, unknown>,
  Schema.Schema.Context<Fields[keyof Fields]>
> =>
  Schema.transform(protocolRecord, Schema.Struct(fields), {
    strict: false,
    decode: withCamelCasedKeys,
    encode: (value: unknown) => value,
  })

/** Decodes, degrading to `null` rather than failing. */
export const decodeOrNull = <A, I>(schema: Schema.Schema<A, I>): ((value: unknown) => A | null) => {
  const decode = Schema.decodeUnknownEither(schema)
  return (value: unknown): A | null => Either.getOrNull(decode(value))
}

/** A string carrying something. The protocol reports an absent value as `""` as readily as null. */
export const nonEmptyString = Schema.String.pipe(Schema.filter((value) => value.length > 0))

/** Excludes `NaN` and the infinities, which no reading an operator should see ever is. */
export const finiteNumber = Schema.Number.pipe(Schema.filter(Number.isFinite))

/** A count: token totals and byte sizes are never negative and never fractional. */
export const nonNegativeInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isSafeInteger(value) && value >= 0),
)
