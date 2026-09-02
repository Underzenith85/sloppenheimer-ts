import { Effect } from 'effect'

import { isSecretKey, redactSecretsInString } from './redaction.js'

type LogFields = Readonly<Record<string, unknown>>

const boundedString = (value: string): string => {
  const redacted = redactSecretsInString(value)
  return redacted.length <= 1_024 ? redacted : `${redacted.slice(0, 1_021)}...`
}

const sanitize = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') {
    return boundedString(value)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (depth >= 4) {
    return '[TRUNCATED]'
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitize(entry, depth + 1))
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([key, entry]) => [key, isSecretKey(key) ? '[REDACTED]' : sanitize(entry, depth + 1)]),
  )
}

const sanitizeEntries = (fields: LogFields): LogFields =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      isSecretKey(key) ? '[REDACTED]' : sanitize(value),
    ]),
  )

export const sanitizeLogFields = (fields: LogFields): LogFields =>
  sanitizeEntries({ action: 'unspecified', outcome: 'unknown', error: null, ...fields })

const fallbackWarning = (level: string, message: string): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.stderr.write(
        `[sloppenheimer] logging_sink_failed=true level=${level} message=${JSON.stringify(boundedString(message))}\n`,
      )
    } catch {
      // There is no remaining operator sink. Logging must never take down orchestration.
    }
  })

const safe = (
  level: 'info' | 'warning' | 'error',
  message: string,
  effect: Effect.Effect<void>,
): Effect.Effect<void> => effect.pipe(Effect.catchAllCause(() => fallbackWarning(level, message)))

export const logInfo = (message: string, fields: LogFields = {}): Effect.Effect<void> =>
  safe('info', message, Effect.logInfo(message, sanitizeLogFields(fields)))

export const logWarning = (message: string, fields: LogFields = {}): Effect.Effect<void> =>
  safe('warning', message, Effect.logWarning(message, sanitizeLogFields(fields)))

export const logError = (message: string, fields: LogFields = {}): Effect.Effect<void> =>
  safe('error', message, Effect.logError(message, sanitizeLogFields(fields)))

/** Propagates bounded, redacted context to every log emitted inside an operation. */
export const withLogAnnotations =
  (fields: LogFields) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(Effect.annotateLogs(sanitizeEntries(fields)))
