/**
 * The pull-request payloads GitHub returns, and the observation fields read out of them.
 *
 * Every reader here is a pure decode over a value already in hand: no request is made, and nothing
 * decides what to fetch. `pull-requests.ts` owns that, and reads a payload through these.
 */

import { Effect, Schema } from 'effect'

import type { JsonValue } from '@symphony/core/domain/domain.js'
import { TrackerError } from '@symphony/core/domain/errors.js'
import { unknownRecord } from '@symphony/core/support/schema.js'
import type {
  CodexReviewObservation,
  PullRequestObservation,
} from '@symphony/core/domain/handoff.js'
import { decodeTracker, trackerCause } from './client.js'

const checkRun = Schema.Struct({
  name: Schema.String,
  status: Schema.Literal('queued', 'in_progress', 'completed'),
  conclusion: Schema.NullOr(Schema.String),
  details_url: Schema.NullOr(Schema.String),
})
const checkRuns = Schema.Array(checkRun)
const reviewComment = Schema.Struct({
  body: Schema.optional(Schema.Unknown),
  url: Schema.optional(Schema.Unknown),
  commit: Schema.optional(Schema.Unknown),
})
const reviewThread = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  comments: Schema.Struct({ nodes: Schema.Array(Schema.Unknown) }),
})
const reviewThreads = Schema.Array(reviewThread)
const codexComments = Schema.Array(Schema.Unknown)
const codexComment = Schema.Struct({
  author: Schema.optional(Schema.Unknown),
  user: Schema.optional(Schema.Unknown),
  body: Schema.optional(Schema.Unknown),
})

export const decode = <Value, Encoded>(
  schema: Schema.Schema<Value, Encoded>,
  value: unknown,
  message: string,
): Effect.Effect<Value, TrackerError> => decodeTracker(schema, value, trackerCause(message))

const safeValueType = (value: JsonValue | undefined): string => {
  if (value === undefined) {
    return 'missing'
  }
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  return typeof value
}

export const pullRequestFieldError = (
  number: number,
  field: string,
  expected: string,
  value: JsonValue | undefined,
): TrackerError =>
  new TrackerError({
    category: 'tracker_response',
    message: `GitHub pull request #${String(number)} field ${JSON.stringify(field)} is invalid: expected ${expected}, received ${safeValueType(value)}`,
    retryable: false,
  })

/** {@link decode} for one field, reporting the key it was read under rather than the whole record. */
export const field = <Value, Encoded>(
  schema: Schema.Schema<Value, Encoded>,
  number: number,
  name: string,
  expected: string,
  value: JsonValue | undefined,
): Effect.Effect<Value, TrackerError> =>
  decodeTracker(schema, value, () => pullRequestFieldError(number, name, expected, value))

export const decodeChecks = (
  value: unknown,
): Effect.Effect<PullRequestObservation['checks'], TrackerError> =>
  decode(checkRuns, value, 'GitHub check-run list is invalid').pipe(
    Effect.map((checks) =>
      checks.map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        url: check.details_url,
      })),
    ),
  )

export const decodeThreads = (
  value: unknown,
): Effect.Effect<PullRequestObservation['reviewThreads'], TrackerError> =>
  Effect.gen(function* () {
    const threads = yield* decode(reviewThreads, value, 'GitHub review-thread list is invalid')
    return yield* Effect.forEach(threads, (thread) =>
      Effect.gen(function* () {
        const first = thread.comments.nodes[0]
        const comment =
          first === undefined
            ? null
            : yield* decode(reviewComment, first, 'GitHub review comment is invalid')
        const commit =
          comment === null ? null : Schema.decodeUnknownOption(unknownRecord)(comment.commit)
        return {
          id: thread.id,
          resolved: thread.isResolved,
          body: comment !== null && typeof comment.body === 'string' ? comment.body : '',
          url: comment !== null && typeof comment.url === 'string' ? comment.url : null,
          commentHeadSha:
            commit !== null && commit._tag === 'Some' && typeof commit.value['oid'] === 'string'
              ? commit.value['oid']
              : null,
        }
      }),
    )
  })

export const decodeCodexReview = (
  value: unknown,
): Effect.Effect<CodexReviewObservation | null, TrackerError> =>
  Effect.gen(function* () {
    const comments = yield* decode(
      codexComments,
      value,
      'GitHub pull request comment list is missing',
    )
    for (const item of [...comments].reverse()) {
      const comment = yield* decode(codexComment, item, 'GitHub pull request comment is invalid')
      const author = comment.author ?? comment.user
      const body = comment.body
      const authorRecord = Schema.decodeUnknownOption(unknownRecord)(author)
      if (authorRecord._tag === 'None' || typeof body !== 'string') {
        continue
      }
      const login = authorRecord.value['login']
      const isCodexConnector =
        login === 'chatgpt-codex-connector' || login === 'chatgpt-codex-connector[bot]'
      if (!isCodexConnector || !body.includes('<!-- codex-pull-request-review-summary -->')) {
        continue
      }
      const head = /\|\s*`([0-9a-f]{7,40})`\s*\|/u.exec(body)?.[1]
      if (head === undefined) {
        continue
      }
      if (body.includes('✅ **Completed**')) {
        return { headShaPrefix: head, status: 'completed' }
      }
      if (body.includes('🔄 **Running**')) {
        return { headShaPrefix: head, status: 'pending' }
      }
    }
    return null
  })

/** A pull-request payload as GitHub returned it: keys read, values not yet judged. */
type PullRequestRecord = Readonly<Record<string, unknown>>

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const headShaOf = (pull: PullRequestRecord): string | null => {
  const head = Schema.decodeUnknownOption(unknownRecord)(pull['head'])
  return head._tag === 'Some' ? stringOrNull(head.value['sha']) : null
}

/**
 * What a closed pull request reports. Nothing is fetched beyond the pull request itself: a closed
 * one has no checks, review decision, or threads left to act on, and a merged one is terminal.
 *
 * Every field is read leniently, because a pull request that is already closed must still be
 * reportable when GitHub omits a field the open path insists on.
 */
export const closedObservation = (
  number: number,
  merged: boolean,
  pull: PullRequestRecord,
): PullRequestObservation => {
  const closed = {
    number,
    state: 'closed',
    url: stringOrNull(pull['html_url']),
    headSha: headShaOf(pull),
    mergeCommitSha: stringOrNull(pull['merge_commit_sha']),
    mergeable:
      pull['mergeable'] === null || typeof pull['mergeable'] === 'boolean'
        ? pull['mergeable']
        : null,
    mergeState: stringOrNull(pull['mergeable_state']),
    checks: [],
    reviewDecision: null,
    reviewThreads: [],
    codexReview: null,
  } as const
  return merged
    ? {
        ...closed,
        merged: true,
        // GitHub reports when the merge happened; keeping it lets a handoff observed after
        // a restart report the time it actually completed rather than the time we noticed.
        mergedAt: stringOrNull(pull['merged_at']),
      }
    : { ...closed, merged: false }
}

/** The fields an open pull request must carry, each reported under the key it was read from. */
export const openPullRequestFields = (
  number: number,
  pull: PullRequestRecord,
): Effect.Effect<
  Readonly<{
    url: string
    headSha: string
    mergeCommitSha: string | null
    mergeable: boolean | null
    mergeState: string
  }>,
  TrackerError
> =>
  Effect.gen(function* () {
    const head = yield* field(
      unknownRecord,
      number,
      'head',
      'object',
      pull['head'] as JsonValue | undefined,
    )
    return {
      headSha: yield* field(
        Schema.String,
        number,
        'head.sha',
        'string',
        head['sha'] as JsonValue | undefined,
      ),
      url: yield* field(
        Schema.String,
        number,
        'html_url',
        'string',
        pull['html_url'] as JsonValue | undefined,
      ),
      mergeCommitSha: yield* field(
        Schema.NullOr(Schema.String),
        number,
        'merge_commit_sha',
        'string or null',
        (pull['merge_commit_sha'] ?? null) as JsonValue,
      ),
      mergeable: yield* field(
        Schema.NullOr(Schema.Boolean),
        number,
        'mergeable',
        'boolean or null',
        pull['mergeable'] as JsonValue | undefined,
      ),
      mergeState: yield* field(
        Schema.String,
        number,
        'mergeable_state',
        'string',
        pull['mergeable_state'] as JsonValue | undefined,
      ),
    }
  })
