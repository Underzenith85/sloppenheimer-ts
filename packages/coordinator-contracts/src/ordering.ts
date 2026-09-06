import type { AggregateItem } from './envelopes.js'

const attentionOrder = [
  'stalled',
  'intervention_required',
  'repair_needed',
  'recovery_failed',
  'cycle',
  'blocked_priority',
]
const progressOrder = [
  'starting',
  'running',
  'retrying',
  'delivering',
  'handing_off',
  'awaiting_checks',
  'rebasing',
  'ready_to_merge',
  'merging',
]
const buckets = ['attention', 'ready', 'blocked', 'progress', 'finished']
const rank = (order: readonly string[], value: string | null): number => {
  const index = value === null ? -1 : order.indexOf(value)
  return index < 0 ? order.length : index
}
const optional = (left: number | null, right: number | null): number =>
  left === null ? (right === null ? 0 : 1) : right === null ? -1 : left - right
const lexical = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/** Wire ordering only; classification remains the operator model's responsibility. */
export const compareItems = (left: AggregateItem, right: AggregateItem): number => {
  const bucket = rank(buckets, left.bucket) - rank(buckets, right.bucket)
  if (bucket !== 0) {
    return bucket
  }
  const priority = optional(left.priority, right.priority)
  let comparison: number
  switch (left.bucket) {
    case 'attention':
      comparison =
        rank(attentionOrder, left.attention) - rank(attentionOrder, right.attention) || priority
      break
    case 'ready':
      comparison = priority || right.unlocks - left.unlocks
      break
    case 'blocked':
      comparison = priority || right.unlocks - left.unlocks
      break
    case 'progress':
      comparison = rank(progressOrder, left.phase) - rank(progressOrder, right.phase)
      break
    case 'finished':
      comparison = optional(right.finished_at?.at ?? null, left.finished_at?.at ?? null)
      if (left.finished_at === null || right.finished_at === null) {
        comparison = optional(left.finished_at?.at ?? null, right.finished_at?.at ?? null)
      }
      break
  }
  return (
    comparison ||
    optional(left.issue_number, right.issue_number) ||
    lexical(left.identity.instance_id, right.identity.instance_id) ||
    lexical(left.identity.issue_identifier, right.identity.issue_identifier)
  )
}
