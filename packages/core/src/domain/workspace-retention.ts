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

/** One workspace no live run holds, as the pruning rule reads it. */
export type RetainedWorkspace = Readonly<{
  key: string
  /**
   * When the run let it go — its release, or its acquisition for a record that never said. `null`
   * for a run directory with no lease beside it at all, which is what a host killed between taking
   * a record aside and putting it back leaves: nothing dates it, and nothing owns it.
   */
  retainedAt: number | null
  /** The run the lease named, for ordering two a host let go of in the same instant. */
  runId: number | null
  /**
   * Whether the host that retained it is finished with it: this host, whose intentions are the
   * `protectedKeys`, or a host whose process can be seen to be gone and so holds no intention at
   * all. A live peer's retained workspace may be its own retained delivery, which nothing here can
   * see, and is left alone the way every workspace of a live peer is.
   */
  ownerFinished: boolean
}>

/**
 * Newest first. Release time is the order an operator means by "the newest", and the run number
 * breaks a tie between two a host let go of in the same instant; the key breaks any tie left, so
 * the order is total and the same on every pass. A workspace nothing dates sorts oldest: no record
 * stands over it, so it is the first thing an issue should be rid of.
 */
export const newestFirst = (retained: readonly RetainedWorkspace[]): readonly RetainedWorkspace[] =>
  [...retained].sort(
    (left, right) =>
      (right.retainedAt ?? -Infinity) - (left.retainedAt ?? -Infinity) ||
      (right.runId ?? -Infinity) - (left.runId ?? -Infinity) ||
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
