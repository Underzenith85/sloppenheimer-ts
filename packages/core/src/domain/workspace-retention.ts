import type { WorkspaceLeaseRecord } from './workspace-lease.js'

/**
 * The bound on what an issue keeps on disk.
 *
 * Every run that ends without publishing leaves its whole checkout behind as a retained recovery
 * artifact, and nothing else takes those away until the issue reaches a terminal state. An issue
 * that keeps failing, stalling or being cancelled therefore leaves one complete checkout per
 * attempt — which, on a large repository, is the disk filling at the retry interval. This module
 * is the rule that decides which of those an issue keeps: the newest few, and never one something
 * in this process still means to publish from.
 *
 * Like `workspace-lease.ts`, it asks the host nothing. Whether a record's writer is still there is
 * the adapter's question; what its answer permits is decided here.
 */

/** What an issue's retained workspaces amount to, as the host counted them after a run. */
export type RetainedWorkspaces = Readonly<{
  /** Retained run workspaces still on disk under the issue directory. */
  count: number
  /** The bytes those directories hold, files only. */
  bytes: number
}>

/** What one pruning pass took, and what it left. */
export type WorkspacePruneReport = RetainedWorkspaces & Readonly<{ evicted: number }>

/** How many retained workspaces an issue keeps, and which are never among the evicted. */
export type WorkspaceRetention = Readonly<{
  /** The newest retained workspaces an issue keeps. Always at least one. */
  limit: number
  /**
   * Run workspace keys that hold work something in this process still intends to publish — a
   * retained delivery's, above all — and the workspace of the run that has just ended, which may
   * be about to become one.
   */
  protectedKeys: ReadonlySet<string>
}>

/** A retained lease as the pruning rule reads it. */
export type RetainedWorkspace = Readonly<{
  key: string
  lease: WorkspaceLeaseRecord
  /**
   * Whether the host that retained it is finished with it: this host, whose intentions are the
   * `protectedKeys`, or a host whose process can be seen to be gone and so holds no intention at
   * all. A live peer's retained workspace may be its own retained delivery, which nothing here can
   * see, and is left alone the way every workspace of a live peer is.
   */
  ownerFinished: boolean
}>

/** When a retained lease was released, or, for a record that never said, when it was acquired. */
const retainedAt = (lease: WorkspaceLeaseRecord): number =>
  Date.parse(lease.releasedAt ?? lease.acquiredAt)

/**
 * Newest first. Release time is the order an operator means by "the newest", and the run number
 * breaks a tie between two records one host released in the same instant; the key breaks any tie
 * left, so the order is total and the same on every pass.
 */
export const newestFirst = (retained: readonly RetainedWorkspace[]): readonly RetainedWorkspace[] =>
  [...retained].sort(
    (left, right) =>
      retainedAt(right.lease) - retainedAt(left.lease) ||
      right.lease.runId - left.lease.runId ||
      left.key.localeCompare(right.key),
  )

/**
 * The run workspace keys the cap evicts: everything past the newest `limit`, except what is
 * protected and what a host that may still want it retained.
 *
 * A protected or live-peer workspace past the cap still occupies its place in the order, so an
 * issue never keeps more than `limit` of this host's own evictable ones. The answer is the keys
 * rather than a filtered list, because the caller removes by name and reports what it removed.
 */
export const workspacesToEvict = (
  retained: readonly RetainedWorkspace[],
  retention: WorkspaceRetention,
): readonly string[] =>
  newestFirst(retained)
    .slice(Math.max(retention.limit, 1))
    .filter((workspace) => workspace.ownerFinished && !retention.protectedKeys.has(workspace.key))
    .map((workspace) => workspace.key)
