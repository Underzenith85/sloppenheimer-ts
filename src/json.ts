import type { JsonObject, JsonValue } from './domain.js'

export class JsonConversionError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`${path} is not JSON-safe`)
    this.name = 'JsonConversionError'
    this.path = path
  }
}

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isJsonArray = (value: JsonValue | undefined): value is readonly JsonValue[] =>
  Array.isArray(value)

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Converts parsed YAML into a deeply frozen, exact JSON value. Anything that cannot round-trip
 * through JSON (dates, functions, non-finite numbers, class instances) is rejected so that
 * adapter-owned configuration is preserved exactly as authored.
 */
export const toJsonValue = (value: unknown, path: string): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new JsonConversionError(path)
    }
    return value
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, index) => toJsonValue(item, `${path}[${String(index)}]`)))
  }
  if (typeof value === 'object' && isPlainObject(value)) {
    const entries = Object.entries(value).map(
      ([key, item]) => [key, toJsonValue(item, `${path}.${key}`)] as const,
    )
    return Object.freeze(Object.fromEntries(entries))
  }
  throw new JsonConversionError(path)
}

export const toJsonObject = (value: unknown, path: string): JsonObject => {
  const converted = toJsonValue(value, path)
  if (!isJsonObject(converted)) {
    throw new JsonConversionError(path)
  }
  return converted
}

export const emptyJsonObject: JsonObject = Object.freeze({})
