/** Registry configuration is private host data. Validation errors retain only redacted causes. */
import { Config, Data, Effect, Redacted, Schema } from 'effect'

export class RegistryError extends Data.TaggedError('RegistryError')<{
  readonly category: 'configuration' | 'resource'
  readonly message: string
  readonly cause?: Redacted.Redacted<unknown>
}> {}

const entrySchema = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u)),
  label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  base_url: Schema.String,
  credential: Schema.optional(Schema.String.pipe(Schema.pattern(/^\$[A-Za-z_][A-Za-z0-9_]*$/u))),
})
const registrySchema = Schema.Struct({ instances: Schema.Array(entrySchema) })

export type RegistryEntry = Readonly<{
  id: string
  label: string
  baseUrl: string
  credential: Redacted.Redacted<string> | null
}>

export const configurationError = (message: string, cause?: unknown): RegistryError =>
  new RegistryError({ category: 'configuration', message, cause: Redacted.make(cause) })

const baseUrl = (value: string): Effect.Effect<string, RegistryError> =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if (
        value !== value.trim() ||
        !/^https?:\/\/[^/?#@\s\\]+\/?$/u.test(value) ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== '' ||
        url.pathname !== '/' ||
        value.includes('\\')
      ) {
        throw configurationError(
          'base_url must be an HTTP(S) origin without credentials, path, query or fragment',
        )
      }
      return url.origin
    },
    catch: (cause) => configurationError('Invalid base_url: expected an HTTP(S) origin', cause),
  })

const resolveEntry = (
  entry: typeof entrySchema.Type,
): Effect.Effect<RegistryEntry, RegistryError> =>
  Effect.gen(function* () {
    const address = yield* baseUrl(entry.base_url)
    const credential =
      entry.credential === undefined
        ? null
        : yield* Config.redacted(entry.credential.slice(1)).pipe(
            Effect.filterOrFail(
              (value) => Redacted.value(value).trim().length > 0,
              () => configurationError('Credential environment variable is empty'),
            ),
            Effect.mapError((cause) =>
              configurationError('Unable to resolve credential environment reference', cause),
            ),
          )
    return Object.freeze({ id: entry.id, label: entry.label, baseUrl: address, credential })
  })

export const decodeRegistry = (
  input: unknown,
): Effect.Effect<readonly RegistryEntry[], RegistryError> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(registrySchema)(input, {
      onExcessProperty: 'error',
    }).pipe(
      Effect.mapError((cause) =>
        configurationError(
          'Invalid registry: expected instances with id, label, base_url and optional $VAR credential',
          cause,
        ),
      ),
    )
    const entries = yield* Effect.forEach(decoded.instances, resolveEntry)
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      return yield* configurationError('Duplicate registry id')
    }
    if (new Set(entries.map((entry) => entry.baseUrl)).size !== entries.length) {
      return yield* configurationError('Duplicate registry base_url')
    }
    return Object.freeze(entries)
  })
