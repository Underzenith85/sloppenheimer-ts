// The token counters every published document carries. Both the baseline state document and the
// per-issue resource report the same three numbers under the same wire names, so the conversion is
// stated once here rather than in each of them.
//
// The schemas beside each type are the runtime half of the same statement: nothing is published
// before it has been encoded through them. They read a count as a plain `Schema.Number` rather
// than as a bounded integer, because a counter arrives from the coding agent's own report and a
// value this API already forwards must not start failing the response that carries it.

import { Schema } from 'effect'

/** Token counters as the wire spells them. The seconds counter is only on the aggregate. */
export type PublishedTokens = Readonly<{
  input_tokens: number
  output_tokens: number
  total_tokens: number
}>

export type PublishedTotals = PublishedTokens & Readonly<{ seconds_running: number }>

const tokenFields = {
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  total_tokens: Schema.Number,
}

export const publishedTokensSchema: Schema.Schema<PublishedTokens> = Schema.Struct(tokenFields)

export const publishedTotalsSchema: Schema.Schema<PublishedTotals> = Schema.Struct({
  ...tokenFields,
  seconds_running: Schema.Number,
})

type TokenCounters = Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }>

export const publishTokens = (tokens: TokenCounters): PublishedTokens => ({
  input_tokens: tokens.inputTokens,
  output_tokens: tokens.outputTokens,
  total_tokens: tokens.totalTokens,
})
