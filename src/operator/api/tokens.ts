// The token counters every published document carries. Both the baseline state document and the
// per-issue resource report the same three numbers under the same wire names, so the conversion is
// stated once here rather than in each of them.

/** Token counters as the wire spells them. The seconds counter is only on the aggregate. */
export type PublishedTokens = Readonly<{
  input_tokens: number
  output_tokens: number
  total_tokens: number
}>

export type PublishedTotals = PublishedTokens & Readonly<{ seconds_running: number }>

type TokenCounters = Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }>

export const publishTokens = (tokens: TokenCounters): PublishedTokens => ({
  input_tokens: tokens.inputTokens,
  output_tokens: tokens.outputTokens,
  total_tokens: tokens.totalTokens,
})
