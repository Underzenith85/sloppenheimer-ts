import { Effect } from 'effect'

type LogFields = Readonly<Record<string, unknown>>

const secretKey =
  /^(?:authorization|credential|credentials|password|secret|token|apiKey|accessToken|refreshToken)$|(?:^|_)(?:api_key|access_token|refresh_token|auth_token|credential|password|secret)$/iu

export const redactSecretsInString = (value: string): string =>
  value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]')
    .replace(
      /"((?:[a-z0-9]+[_-])*(?:api[_-]?key|authorization|credentials?|password|secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token))"\s*:\s*"(?:\\.|[^"\\])*"/giu,
      '"$1":"[REDACTED]"',
    )
    .replace(
      /'((?:[a-z0-9]+[_-])*(?:api[_-]?key|authorization|credentials?|password|secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token))'\s*:\s*'(?:\\.|[^'\\])*'/giu,
      "'$1':'[REDACTED]'",
    )
    .replace(
      /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|authorization|credentials?|password|secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token))\s*[:=]\s*\S+/giu,
      '$1=[REDACTED]',
    )

const boundedString = (value: string): string => {
  const redacted = redactSecretsInString(value)
  return redacted.length <= 1_024 ? redacted : `${redacted.slice(0, 1_021)}...`
}

const sanitize = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') {
    return boundedString(value)
  }
  if (value === null || typeof value !== 'object' || depth >= 4) {
    return value
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitize(entry, depth + 1))
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([key, entry]) => [
        key,
        secretKey.test(key) ? '[REDACTED]' : sanitize(entry, depth + 1),
      ]),
  )
}

const sanitizeFields = (fields: LogFields): LogFields =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      secretKey.test(key) ? '[REDACTED]' : sanitize(value),
    ]),
  )

const fallbackWarning = (level: string, message: string): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.stderr.write(
        `[symphony] logging_sink_failed=true level=${level} message=${JSON.stringify(boundedString(message))}\n`,
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
  safe('info', message, Effect.logInfo(message, sanitizeFields(fields)))

export const logWarning = (message: string, fields: LogFields = {}): Effect.Effect<void> =>
  safe('warning', message, Effect.logWarning(message, sanitizeFields(fields)))

export const logError = (message: string, fields: LogFields = {}): Effect.Effect<void> =>
  safe('error', message, Effect.logError(message, sanitizeFields(fields)))
