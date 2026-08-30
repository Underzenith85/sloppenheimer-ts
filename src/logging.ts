import { Effect } from 'effect'

type LogFields = Readonly<Record<string, unknown>>

const exactSecretKeys = new Set([
  'authorization',
  'credential',
  'credentials',
  'cookie',
  'password',
  'sessionid',
  'set-cookie',
  'setcookie',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'accesstoken',
  'privatekey',
  'refreshtoken',
  'secretaccesskey',
  'authtoken',
])

const isSecretKey = (key: string): boolean => {
  const lowerKey = key.toLowerCase()
  if (exactSecretKeys.has(lowerKey)) {
    return true
  }
  if (
    /(?:^|[_.-])(?:api[_.-]?key|access[_.-]?key|private[_.-]?key|secret[_.-]?access[_.-]?key|access[_.-]?token|refresh[_.-]?token|auth[_.-]?token|session[_.-]?id|set[_.-]?cookie|cookie|authorization|credentials?|password|secret|token)$/u.test(
      lowerKey,
    )
  ) {
    return true
  }
  return /(?:ApiKey|AccessKey|PrivateKey|SecretAccessKey|AccessToken|RefreshToken|AuthToken|SetCookie|Cookie|Authorization|Credentials?|Password|Secret|Token)$/u.test(
    key,
  )
}

const redactQuotedField = (match: string, key: string, quote: string): string =>
  isSecretKey(key) ? `${quote}${key}${quote}:${quote}[REDACTED]${quote}` : match

const redactEscapedQuotedField = (match: string, key: string): string =>
  isSecretKey(key) ? String.raw`\"${key}\":\"[REDACTED]\"` : match

const redactAssignment = (match: string, key: string): string =>
  isSecretKey(key) ? `${key}=[REDACTED]` : match

const redactUnquotedAssignments = (value: string): string => {
  const assignment = /\b([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*/gu
  let result = ''
  let copiedThrough = 0
  let match: RegExpExecArray | null
  while ((match = assignment.exec(value)) !== null) {
    const key = match[1]
    if (key === undefined || !isSecretKey(key)) {
      continue
    }
    const valueStart = assignment.lastIndex
    const first = value[valueStart]
    if (first === '"' || first === "'") {
      continue
    }
    const carriageReturn = value.indexOf('\r', valueStart)
    const newline = value.indexOf('\n', valueStart)
    const candidates = [carriageReturn, newline].filter((index) => index >= 0)
    const lineEnd = candidates.length === 0 ? value.length : Math.min(...candidates)
    const nextAssignment = /\s+[A-Za-z_][A-Za-z0-9_.-]*\s*[:=]/u.exec(
      value.slice(valueStart, lineEnd),
    )
    const redactionEnd = nextAssignment === null ? lineEnd : valueStart + nextAssignment.index
    result += `${value.slice(copiedThrough, match.index)}${key}=[REDACTED]`
    copiedThrough = redactionEnd
    assignment.lastIndex = redactionEnd
  }
  return `${result}${value.slice(copiedThrough)}`
}

const redactPemPrivateKeys = (value: string): string =>
  value.replace(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu,
    '[REDACTED PEM PRIVATE KEY]',
  )

export const redactSecretsInString = (value: string): string =>
  redactUnquotedAssignments(redactPemPrivateKeys(value))
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]+@/gu, '$1[REDACTED]@')
    .replace(/\b((?:Proxy-)?Authorization|Set-Cookie|Cookie)\s*[:=][^\r\n]*/giu, '$1=[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]')
    .replace(
      /\\"([A-Za-z_][A-Za-z0-9_.-]*)\\"\s*:\s*\\"(?:[^"\\]|\\{2,}"|\\(?!"))*\\"/gu,
      (match: string, key: string): string => redactEscapedQuotedField(match, key),
    )
    .replace(
      /"([A-Za-z_][A-Za-z0-9_.-]*)"\s*:\s*"(?:\\.|[^"\\])*"/gu,
      (match: string, key: string): string => redactQuotedField(match, key, '"'),
    )
    .replace(
      /'([A-Za-z_][A-Za-z0-9_.-]*)'\s*:\s*'(?:\\.|[^'\\])*'/gu,
      (match: string, key: string): string => redactQuotedField(match, key, "'"),
    )
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*"(?:\\.|[^"\\])*"/gu,
      (match: string, key: string): string => redactAssignment(match, key),
    )
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*'(?:\\.|[^'\\])*'/gu,
      (match: string, key: string): string => redactAssignment(match, key),
    )

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

const sanitizeFields = (fields: LogFields): LogFields =>
  Object.fromEntries(
    Object.entries({ action: 'unspecified', outcome: 'unknown', error: null, ...fields }).map(
      ([key, value]) => [key, isSecretKey(key) ? '[REDACTED]' : sanitize(value)],
    ),
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
