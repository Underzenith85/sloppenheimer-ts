import { Schema } from 'effect'

/** Historical completion is a fact even when an older host did not retain the merged head. */
export const Completion = Schema.Struct({
  issueId: Schema.NonEmptyString,
  identifier: Schema.NonEmptyString,
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  outcome: Schema.Literal('merged'),
  finishedAt: Schema.String.pipe(Schema.filter((value) => !Number.isNaN(Date.parse(value)))),
  pullRequestUrl: Schema.NullOr(Schema.String),
})
export type Completion = typeof Completion.Type
