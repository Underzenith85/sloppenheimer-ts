import type { Observation } from './common.js'

/** Thresholds are contract policy, independent of retry/backoff schedules. */
export const freshnessThresholds = Object.freeze({
  source_stale_ms: 30_000,
  source_unreachable_ms: 120_000,
  browser_stale_ms: 15_000,
  browser_unreachable_ms: 60_000,
})

export const sourceCondition = (
  now: number,
  observedAt: number | null,
  firstAttemptAt: number | null,
  incompatible: boolean,
): Observation['condition'] => {
  if (incompatible) {
    return 'incompatible'
  }
  const baseline = observedAt ?? firstAttemptAt
  if (baseline !== null && now - baseline >= freshnessThresholds.source_unreachable_ms) {
    return 'unreachable'
  }
  if (observedAt === null) {
    return 'never-observed'
  }
  return now - observedAt >= freshnessThresholds.source_stale_ms ? 'stale' : 'current'
}

export type BrowserFreshness = 'never-observed' | 'current' | 'stale' | 'unreachable'
/** ageAtReceipt includes calibrated coordinator snapshot age plus clock uncertainty. */
export const browserFreshness = (
  elapsedSinceReceipt: number | null,
  ageAtReceipt: number,
): BrowserFreshness => {
  if (elapsedSinceReceipt === null) {
    return 'never-observed'
  }
  const age = Math.max(0, elapsedSinceReceipt) + Math.max(0, ageAtReceipt)
  if (age >= freshnessThresholds.browser_unreachable_ms) {
    return 'unreachable'
  }
  return age >= freshnessThresholds.browser_stale_ms ? 'stale' : 'current'
}
