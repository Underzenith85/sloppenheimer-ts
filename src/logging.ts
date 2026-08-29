import { Effect } from 'effect'

type LogFields = Readonly<Record<string, unknown>>

const exactSecretKeys = new Set([
  'authorization',
  'credential',
  'credentials',
  'password',
  'secret',
  'token',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'authtoken',
])

const isSecretKey = (key: string): boolean => {
  const lowerKey = key.toLowerCase()
  if (exactSecretKeys.has(lowerKey)) {
    return true
  }
  if (
    /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|credentials?|password|secret|token)$/u.test(
      lowerKey,
    )
  ) {
    return true
  }
  return /(?:ApiKey|AccessToken|RefreshToken|AuthToken|Credentials?|Password|Secret|Token)$/u.test(
    key,
  )
}

const redactQuotedField = (match: string, key: string, quote: string): string =>
  isSecretKey(key) ? `${quote}${key}${quote}:${quote}[REDACTED]${quote}` : match

const redactAssignment = (match: string, key: string): string =>
  isSecretKey(key) ? `${key}=[REDACTED]` : match

export const redactSecretsInString = (value: string): string =>
  value
    .replace(/\b(Authorization)\s*[:=]\s*(?:Basic|Bearer)\s+\S+/giu, '$1=[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]')
    .replace(
      /"([A-Za-z_][A-Za-z0-9_-]*)"\s*:\s*"(?:\\.|[^"\\])*"/gu,
      (match: string, key: string): string => redactQuotedField(match, key, '"'),
    )
    .replace(
      /'([A-Za-z_][A-Za-z0-9_-]*)'\s*:\s*'(?:\\.|[^'\\])*'/gu,
      (match: string, key: string): string => redactQuotedField(match, key, "'"),
    )
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*"(?:\\.|[^"\\])*"/gu,
      (match: string, key: string): string => redactAssignment(match, key),
    )
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*'(?:\\.|[^'\\])*'/gu,
      (match: string, key: string): string => redactAssignment(match, key),
    )
    .replace(/\b([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*\S+/gu, (match: string, key: string): string =>
      redactAssignment(match, key),
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
      .map(([key, entry]) => [key, isSecretKey(key) ? '[REDACTED]' : sanitize(entry, depth + 1)]),
  )
}

const sanitizeFields = (fields: LogFields): LogFields =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      isSecretKey(key) ? '[REDACTED]' : sanitize(value),
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
