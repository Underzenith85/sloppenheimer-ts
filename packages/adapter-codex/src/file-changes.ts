/**
 * The files one App Server item reports changing.
 *
 * The protocol's `fileChange` item is `{id, changes, status}`, where `changes` *lists* every file
 * the patch touches as `{path, kind, diff}`, and no entry carries a line count of its own. Both
 * facts are load-bearing. Reading only the first entry loses every other file of a multi-file
 * patch, and waiting for an `addedLines` field the protocol never sends leaves the workspace
 * summary reporting no line changes at all, however much the agent wrote.
 *
 * The counts are therefore derived here, from the diff the change carries, and the diff itself is
 * discarded in the same expression: a diff is file content, so only the two numbers it produces
 * are ever retained. Fields a backend does report directly are still preferred over counting.
 *
 * The item stream is the only source the workspace ledger reads. The App Server also publishes a
 * turn-level aggregate as `turn/diff/updated`, but that restates the same edits cumulatively after
 * every patch, so folding it in as well would count each line again on every notification that
 * carried it.
 */

import { Schema } from 'effect'

import { pathKey, type Redactor } from '@sloppenheimer/core/support/redaction.js'
import {
  decodeOrNull,
  finiteNumber,
  nonEmptyString,
  protocolStruct,
  tolerant,
  unknownRecord,
} from '@sloppenheimer/core/support/schema.js'
import type { FileChange, FileChangeKind } from '@sloppenheimer/core/telemetry.js'

/**
 * What the change did to the file, as the word itself or as the tagged record the App Server sends
 * it in: `PatchChangeKind` is an enum serialized as `{"type": "add"}` or `{"type": "update",
 * "movePath": null}`, never as a bare word. Reading only the word left every real change decoding
 * as `null` and publishing as `unknown`, so the timeline named no additions, updates or deletions
 * at all.
 */
const changeKindSource = Schema.Union(
  nonEmptyString,
  Schema.transform(protocolStruct({ type: tolerant(nonEmptyString) }), Schema.String, {
    strict: false,
    decode: (tagged: Readonly<{ type: string | null }>) => tagged.type ?? '',
    encode: (word: string) => ({ type: word }),
  }).pipe(Schema.filter((word) => word.length > 0)),
)

/**
 * One entry of a change list. `path`, `kind`, and `diff` are what the App Server sends; the rest
 * are the spellings a backend reporting the same change under other names would use, read here so
 * a count that was stated outright is never recomputed from a diff.
 */
const changeSource = protocolStruct({
  path: tolerant(nonEmptyString),
  file: tolerant(nonEmptyString),
  filePath: tolerant(nonEmptyString),
  kind: tolerant(changeKindSource),
  type: tolerant(changeKindSource),
  change: tolerant(changeKindSource),
  changeKind: tolerant(changeKindSource),
  addedLines: tolerant(finiteNumber),
  additions: tolerant(finiteNumber),
  deletedLines: tolerant(finiteNumber),
  deletions: tolerant(finiteNumber),
  diff: tolerant(nonEmptyString),
  unifiedDiff: tolerant(nonEmptyString),
  patch: tolerant(nonEmptyString),
})

/**
 * The change list itself: the protocol's list, or a record keyed by the path each entry changed.
 * The keyed form is not what the App Server sends, but it is what the same information looks like
 * whenever a patch is reported as a map, and reading it costs one branch.
 */
const changeListSource = Schema.Union(Schema.Array(Schema.Unknown), unknownRecord)

export const decodeChange = decodeOrNull(changeSource)
const decodeChangeList = decodeOrNull(changeListSource)

export type ChangeSource = Schema.Schema.Type<typeof changeSource>

const fileChangeKinds = new Map<string, FileChangeKind>([
  ['add', 'add'],
  ['added', 'add'],
  ['create', 'add'],
  ['created', 'add'],
  ['delete', 'delete'],
  ['deleted', 'delete'],
  ['remove', 'delete'],
  ['removed', 'delete'],
  ['update', 'update'],
  ['updated', 'update'],
  ['modify', 'update'],
  ['modified', 'update'],
])

export const changeKind = (value: string | null): FileChangeKind =>
  fileChangeKinds.get(value?.toLowerCase() ?? '') ?? 'unknown'

/** The two halves of a file header, each the three characters and the separator that follows. */
const oldFileHeader = /^---(?:[ \t]|$)/u
const newFileHeader = /^\+\+\+(?:[ \t]|$)/u

/**
 * The lines one diff adds and removes.
 *
 * Nothing about a single line makes it a header. Neither the three characters nor the separator
 * after them does, because content wears both: an added line reading `++counter` arrives as
 * `+++counter`, and one reading `++ heading` arrives as `+++ heading`. What a header has is a
 * position — the header section, before any content — and a shape: a `---` line with the `+++`
 * line right after it, consumed together. Everything else is content, and a `+` or `-` line inside
 * a hunk or after content has begun is content whatever it looks like, which is what keeps a
 * removed `-- x` above an added `++ y` from reading as a header wherever it appears.
 *
 * The header section reopens at each `diff --git`, so a diff carrying several files is read file by
 * file. A concatenation that separates its files by header alone is not: after the first file's
 * content, the second file's header counts as the two lines it resembles. One change carries one
 * file's diff, so that shape does not arise from this protocol.
 *
 * Nothing else about the diff is read, and no part of it is returned.
 */
const diffCounts = (diff: string): Readonly<{ addedLines: number; deletedLines: number }> => {
  const lines = diff.split('\n')
  let addedLines = 0
  let deletedLines = 0
  let inHeaderSection = true
  let paired = false
  for (const [index, line] of lines.entries()) {
    if (paired) {
      // The `+++` half, consumed with the `---` half that named it.
      paired = false
      continue
    }
    if (line.startsWith('@@')) {
      inHeaderSection = false
      continue
    }
    // A diff carrying more than one file opens a header section for each of them.
    if (line.startsWith('diff --git ')) {
      inHeaderSection = true
      continue
    }
    if (inHeaderSection && oldFileHeader.test(line) && newFileHeader.test(lines[index + 1] ?? '')) {
      paired = true
      continue
    }
    if (line.startsWith('+')) {
      addedLines += 1
      inHeaderSection = false
    } else if (line.startsWith('-')) {
      deletedLines += 1
      inHeaderSection = false
    }
  }
  return { addedLines, deletedLines }
}

/**
 * What one change did, in lines. A change that reports neither a count nor a diff reads as `null`
 * rather than as zero: a patch whose size is unknown is not a patch that changed nothing.
 */
export const countsOf = (
  change: ChangeSource,
): Readonly<{ addedLines: number | null; deletedLines: number | null }> => {
  const addedLines = change.addedLines ?? change.additions
  const deletedLines = change.deletedLines ?? change.deletions
  if (addedLines !== null || deletedLines !== null) {
    return { addedLines, deletedLines }
  }
  const diff = change.diff ?? change.unifiedDiff ?? change.patch
  return diff === null ? { addedLines: null, deletedLines: null } : diffCounts(diff)
}

/**
 * One change, read from its own record and — for a list keyed by path — from the key that named
 * it. A change that names no file at all is dropped rather than retained as a nameless edit.
 */
const fileChangeOf = (
  source: unknown,
  key: string | null,
  redactor: Redactor,
): FileChange | null => {
  const change = decodeChange(source)
  const path = (change === null ? null : (change.path ?? change.file ?? change.filePath)) ?? key
  if (path === null) {
    return null
  }
  return Object.freeze({
    path: pathKey(redactor(path)),
    change: changeKind(
      change === null ? null : (change.kind ?? change.type ?? change.change ?? change.changeKind),
    ),
    ...(change === null ? { addedLines: null, deletedLines: null } : countsOf(change)),
  })
}

/**
 * The change list as entries, carrying the key that named each change where there was one.
 *
 * Exported for `trace-file-changes.ts`, which reads the same list for the durable trace and differs
 * only in what it keeps of each entry: the trace retains the patch text this module discards.
 */
export const changeEntries = (changes: unknown): readonly (readonly [string | null, unknown])[] => {
  const decoded = decodeChangeList(changes)
  if (decoded === null) {
    return []
  }
  return Array.isArray(decoded)
    ? decoded.map((change): readonly [string | null, unknown] => [null, change])
    : Object.entries(decoded).map(([key, change]): readonly [string | null, unknown] => [
        key,
        change,
      ])
}

/** The one change reported for an item that carries no list, so nothing is lost to shape alone. */
const unnamedChange: FileChange = Object.freeze({
  path: 'unknown',
  change: 'unknown',
  addedLines: null,
  deletedLines: null,
})

/**
 * Every file an item reported changing, in the order it listed them. An item that names its file on
 * the item itself rather than in a list is read as the single change it is, and one that names no
 * file at all still reports a change, so a patch is never dropped from the timeline for want of a
 * name.
 *
 * The list is not bounded here. A payload is built per message and dropped once folded; the bound
 * belongs to the fold that retains, which counts every file into the totals while keeping only as
 * many paths as the record holds — and knows, from the count it was handed, that it kept fewer.
 */
export const fileChangesOf = (
  changes: unknown,
  item: unknown,
  redactor: Redactor,
): readonly FileChange[] => {
  const listed = changeEntries(changes)
    .map(([key, change]) => fileChangeOf(change, key, redactor))
    .filter((change): change is FileChange => change !== null)
  if (listed.length > 0) {
    return Object.freeze(listed)
  }
  return Object.freeze([fileChangeOf(item, null, redactor) ?? unnamedChange])
}
