import type { Effect } from 'effect'

import type { Issue } from '../domain/domain.js'
import type { TrackerError } from '../errors.js'

/**
 * The narrow issue surface the operator console drives directly: list what is open, and mark one
 * issue for orchestration. It is separate from `TrackerPort` because the operator needs neither
 * dependency hydration nor provider-native tools, and a tracker must not have to supply the
 * console's vocabulary to be a tracker.
 */
export type IssueControlPort = Readonly<{
  listOpenIssues: () => Effect.Effect<readonly Issue[], TrackerError>
  addLabel: (issueNumber: number, label: string) => Effect.Effect<void, TrackerError>
}>
