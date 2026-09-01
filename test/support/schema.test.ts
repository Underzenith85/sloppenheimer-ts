import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  decodeOrNull,
  finiteNumber,
  nonEmptyString,
  nonNegativeInteger,
  protocolRecord,
  protocolStruct,
  tolerant,
} from '@sloppenheimer/core/support/schema.js'

const window = protocolStruct({
  usedPercent: tolerant(finiteNumber),
  windowMinutes: tolerant(finiteNumber),
  label: tolerant(nonEmptyString),
})
const decodeWindow = decodeOrNull(window)

describe('protocol schemas', (): void => {
  it('reads a field under either casing, once', (): void => {
    expect(decodeWindow({ used_percent: 42, window_minutes: 300 })).toEqual({
      usedPercent: 42,
      windowMinutes: 300,
      label: null,
    })
    expect(decodeWindow({ usedPercent: 42, windowMinutes: 300 })).toEqual({
      usedPercent: 42,
      windowMinutes: 300,
      label: null,
    })
  })

  it('prefers the spelling the payload states outright', (): void => {
    // A record carrying both keeps the camelCase value rather than the one derived from the other
    // key, matching the order the hand-written key lists used before.
    expect(decodeWindow({ usedPercent: 1, used_percent: 2 })?.usedPercent).toBe(1)
  })

  it('degrades an unrecognized field to absence rather than failing the record', (): void => {
    expect(decodeWindow({ usedPercent: 'plenty', windowMinutes: 300 })).toEqual({
      usedPercent: null,
      windowMinutes: 300,
      label: null,
    })
    // An empty string is the protocol's other way of saying nothing.
    expect(decodeWindow({ label: '' })?.label).toBeNull()
    expect(decodeWindow({ usedPercent: Number.NaN })?.usedPercent).toBeNull()
    // A field the protocol adds later cannot fail a message Sloppenheimer already understands.
    expect(decodeWindow({ usedPercent: 7, somethingNewer: { nested: true } })?.usedPercent).toBe(7)
  })

  it('fails a value that is not a record at all', (): void => {
    expect(decodeWindow([{ usedPercent: 1 }])).toBeNull()
    expect(decodeWindow(null)).toBeNull()
    expect(decodeWindow('primary')).toBeNull()
    expect(decodeWindow(undefined)).toBeNull()
    expect(decodeWindow({})).toEqual({ usedPercent: null, windowMinutes: null, label: null })
  })

  it('leaves a leading underscore alone', (): void => {
    // `_meta` is a name, not a snake_cased `meta`, and renaming it would invent a field.
    const decoded = decodeOrNull(protocolStruct({ Meta: tolerant(Schema.String) }))({ _meta: 'x' })

    expect(decoded).toEqual({ Meta: null })
  })

  it('keeps the keys of a record read as-is', (): void => {
    // Rate-limit windows are named by their own keys, so nothing about them is normalized.
    expect(decodeOrNull(protocolRecord)({ weekly_limit: { usedPercent: 3 } })).toEqual({
      weekly_limit: { usedPercent: 3 },
    })
    expect(decodeOrNull(protocolRecord)([])).toBeNull()
  })

  it('fails a required field, so a partial reading is no reading', (): void => {
    const totals = decodeOrNull(
      protocolStruct({ inputTokens: nonNegativeInteger, totalTokens: nonNegativeInteger }),
    )

    expect(totals({ input_tokens: 90, total_tokens: 100 })).toEqual({
      inputTokens: 90,
      totalTokens: 100,
    })
    expect(totals({ inputTokens: 90 })).toBeNull()
    expect(totals({ inputTokens: -1, totalTokens: 100 })).toBeNull()
    expect(totals({ inputTokens: 1.5, totalTokens: 100 })).toBeNull()
  })
})
