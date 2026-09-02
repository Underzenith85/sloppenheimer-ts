/**
 * The files one App Server patch item reports changing, as the durable trace retains them.
 *
 * `file-changes.ts` beside this reads the same list for the bounded timeline and deliberately
 * discards the diff in the same expression that counts it: a diff is file content, and the timeline
 * is a health summary. The trace answers a different question — what change did this agent make —
 * and that question cannot be answered by two integers, so the patch text is retained here.
 *
 * The decoding itself is shared rather than repeated: the entry walk, the change-kind vocabulary
 * and the line counting all come from `file-changes.ts`, so the two readings can never disagree
 * about which files an item named or what it did to them.
 *
 * A patch is agent-authored text, so it is redacted and bounded like every other retained field.
 * The deliberate limit, which `README.md` states: heuristic redaction cannot guarantee removal of a
 * secret that was sitting in the source the patch edits.
 */

import type { TraceCapture, TraceFileChange } from '@sloppenheimer/core/domain/trace.js'
import { retainText } from '@sloppenheimer/core/support/high-fidelity.js'
import { pathKey, type Redactor } from '@sloppenheimer/core/support/redaction.js'

import { changeEntries, changeKind, countsOf, decodeChange } from './file-changes.js'
import type { TraceBuild } from './trace.js'

/** How many files one item's change list may contribute, so one patch cannot fill a segment. */
export const tracedFileLimit = 200

const traceFileChange = (
  source: unknown,
  key: string | null,
  build: TraceBuild,
  capture: TraceCapture,
  redactor: Redactor,
): TraceFileChange | null => {
  const change = decodeChange(source)
  const path = (change === null ? null : (change.path ?? change.file ?? change.filePath)) ?? key
  if (path === null) {
    return null
  }
  const diff = change === null ? null : (change.diff ?? change.unifiedDiff ?? change.patch)
  const patch =
    diff === null ? null : retainText(`patch:${path}`, diff, capture.fieldLimitBytes, redactor)
  if (patch !== null && patch.truncation !== null) {
    build.truncations.push(patch.truncation)
  }
  build.redacted = build.redacted || (patch?.redacted ?? false)
  return {
    path: pathKey(redactor(path)),
    change: changeKind(
      change === null ? null : (change.kind ?? change.type ?? change.change ?? change.changeKind),
    ),
    ...(change === null ? { addedLines: null, deletedLines: null } : countsOf(change)),
    patch: patch?.text ?? null,
  }
}

/**
 * Every file the item named, with the patch each carried. An item that names no file at all still
 * reports one change, so a patch is never dropped from the trace for want of a name — the same rule
 * the timeline follows.
 */
export const traceFileChanges = (
  changes: unknown,
  build: TraceBuild,
  capture: TraceCapture,
  redactor: Redactor,
): readonly TraceFileChange[] => {
  const entries = changeEntries(changes)
  const listed = entries
    .slice(0, tracedFileLimit)
    .map(([key, change]) => traceFileChange(change, key, build, capture, redactor))
    .filter((change): change is TraceFileChange => change !== null)
  if (entries.length > tracedFileLimit) {
    build.truncations.push({
      field: 'files',
      reason: 'count_limit',
      retainedBytes: listed.length,
      originalBytes: entries.length,
    })
  }
  if (listed.length > 0) {
    return listed
  }
  return [
    {
      path: 'unknown',
      change: 'unknown',
      addedLines: null,
      deletedLines: null,
      patch: null,
    },
  ]
}
