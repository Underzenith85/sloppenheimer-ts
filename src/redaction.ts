/**
 * Central field-level redaction and bounding.
 *
 * Every string that reaches retained agent telemetry passes through here *before* it is stored, not
 * when a response is serialized. Redacting at the serialization boundary would leave the secret
 * resident in memory, visible to any later consumer, and dependent on every response path
 * remembering to apply it; redacting at ingest means the retained value never held the secret at
 * all.
 *
 * This composes the host's structural redactor from `logging.ts` — secret-named keys in any quoting
 * style, `Authorization` and `Cookie` headers, bearer tokens, URL credentials, and PEM blocks —
 * rather than restating it. What is added here is what retained telemetry needs beyond it: values
 * that are credentials by *shape* wherever they appear, the resolved values of the environment
 * variables the host treats as secret, and the bounding every retained string is subject to.
 */

import { redactSecretsInString } from './logging.js'

export const redactionMarker = '[REDACTED]'

/** The longest retained free-text summary. Anything longer is cut and reported as truncated. */
export const summaryLimit = 240

export type BoundedText = Readonly<{
  text: string
  /** Whether the source was longer than the limit. Truncation is never silent. */
  truncated: boolean
}>

/**
 * Shapes whose mere presence identifies a credential, independent of the surrounding text. Ordered
 * from most specific to least so a longer match is consumed before a shorter one inside it.
 */
const credentialPatterns: readonly RegExp[] = [
  /\b(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{16,}/gu,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
]

/** Query-string parameters that carry a credential by convention. */
const queryCredentialPattern =
  /([?&](?:access_token|api_key|apikey|auth|code|key|password|secret|sig|signature|token)=)[^&\s]+/giu

const escapeLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * Literal values worth removing on sight — the resolved contents of the environment variables the
 * host treats as secret. Very short values are ignored: replacing every occurrence of a two-
 * character token would corrupt unrelated text without protecting anything.
 */
const literalMinimumLength = 8

export type Redactor = (value: string) => string

const applyPatterns = (value: string): string => {
  let result = redactSecretsInString(value)
  for (const pattern of credentialPatterns) {
    result = result.replace(pattern, redactionMarker)
  }
  return result.replace(queryCredentialPattern, `$1${redactionMarker}`)
}

/**
 * Builds a redactor that removes the given literal secrets first — a resolved token has no
 * distinguishing shape once it is pasted into arbitrary output — and then the shape-based patterns.
 */
export const makeRedactor = (secretValues: readonly string[] = []): Redactor => {
  const literals = [
    ...new Set(secretValues.filter((value) => value.length >= literalMinimumLength)),
  ]
    // Longest first, so a secret that contains another is replaced whole rather than in pieces.
    .sort((left, right) => right.length - left.length)
    .map((value) => new RegExp(escapeLiteral(value), 'gu'))
  return (value: string): string => {
    let result = value
    for (const literal of literals) {
      result = result.replace(literal, redactionMarker)
    }
    return applyPatterns(result)
  }
}

/** The shape-based redactor, for call sites with no environment secrets to consider. */
export const redact: Redactor = (value) => applyPatterns(value)

/** Cuts a string to a limit, reporting truncation rather than hiding it. */
export const bound = (value: string, limit: number = summaryLimit): BoundedText => {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  return collapsed.length <= limit
    ? { text: collapsed, truncated: false }
    : { text: collapsed.slice(0, limit), truncated: true }
}

/** Redacts and then bounds, in that order: a secret cut in half is still a leak. */
export const boundRedacted = (
  value: string,
  redactor: Redactor = redact,
  limit: number = summaryLimit,
): BoundedText => bound(redactor(value), limit)

/**
 * The retained form of a filesystem path: workspace-relative where possible, never absolute, and
 * bounded. Absolute paths leak the host layout and, with it, account names.
 */
export const pathKey = (value: string, limit = 160): string => {
  const normalized = value.replace(/\\/gu, '/').trim()
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  const relative = normalized.startsWith('/') ? segments.slice(-3).join('/') : segments.join('/')
  return bound(relative, limit).text
}

/**
 * The retained form of a command: the program name and how many arguments it was given. Arguments
 * routinely carry credentials, file contents, and prompts, so none of them is kept.
 */
export const commandSummary = (
  command: string | readonly string[],
  redactor: Redactor = redact,
): Readonly<{ program: string; argumentCount: number }> => {
  const parts = Array.isArray(command)
    ? [...(command as readonly string[])]
    : String(command)
        .trim()
        .split(/\s+/u)
        .filter((part) => part.length > 0)
  const [first, ...rest] = parts
  if (first === undefined) {
    return { program: 'unknown', argumentCount: 0 }
  }
  // A shell wrapper's first argument is the interesting one: `bash -lc "pnpm check"` is a run of
  // `pnpm`, not of `bash`. Only the program word is taken from it, never the rest of the script.
  const wrapped = /^(?:ba|z|k|)sh$/u.test(pathKey(first, 40).split('/').at(-1) ?? '')
  const script = wrapped ? rest.find((part) => !part.startsWith('-')) : undefined
  const program =
    script === undefined
      ? (pathKey(first, 60).split('/').at(-1) ?? 'unknown')
      : (script.trim().split(/\s+/u)[0] ?? 'unknown')
  return {
    // A quoted shell script arrives with its opening quote attached to the program word. The
    // session's own redactor is used, not the shape-based one alone: a configured secret has no
    // distinguishing shape, and nothing rules out its appearing where a program name is expected.
    program: bound(redactor(program.replace(/^["']|["']$/gu, '')), 60).text,
    argumentCount: Math.max(parts.length - 1, 0),
  }
}
