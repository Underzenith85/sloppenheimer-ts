import type { ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { Option } from 'effect'

/** The `/proc/<pid>/stat` state character of a process that has exited but has not been reaped. */
const zombieState = 'Z'
const procRoot = '/proc'
const procEntryPattern = /^\d+$/u

/** The fields of `/proc/<pid>/stat` this module reads. */
type ProcessStatus = {
  /** The single-character run state: `Z` for a zombie, `R`, `S`, `D`, `T` and so on for the rest. */
  readonly state: string
  /** The process group the process belongs to. */
  readonly processGroup: number
}

/**
 * Parses one `/proc/<pid>/stat` line, or `none` when it does not have the expected shape.
 *
 * The second field, `comm`, is the executable name in parentheses and may itself contain spaces and
 * parentheses, so the remaining fields are read from after its final `)` rather than by splitting
 * the whole line.
 */
export const parseProcessStatus = (stat: string): Option.Option<ProcessStatus> => {
  const commEnd = stat.lastIndexOf(')')
  if (commEnd === -1) {
    return Option.none()
  }
  // After `comm`: state, ppid, pgrp, ...
  const fields = stat
    .slice(commEnd + 1)
    .trim()
    .split(' ')
  const state = fields[0]
  const group = fields[2]
  if (state === undefined || state.length === 0 || group === undefined) {
    return Option.none()
  }
  const processGroup = Number.parseInt(group, 10)
  if (!Number.isSafeInteger(processGroup)) {
    return Option.none()
  }
  return Option.some({ state, processGroup })
}

/** What one pass over `/proc` saw of a process group. */
type GroupMembership =
  /** At least one member is not a zombie. */
  | { readonly kind: 'live' }
  /** Every member seen is a zombie; `members` holds their pids, in order. */
  | { readonly kind: 'zombies'; readonly members: readonly number[] }

/**
 * One pass over `/proc`: what it saw of the process group led by `pid`, or `none` when this host
 * cannot answer at all — `/proc` is Linux-only, and a pass that reads no process whatsoever is an
 * unreadable `/proc` rather than an empty host.
 *
 * A listed process that cannot be read has exited since the listing, so it is no member; whether it
 * left a member behind is what the agreement in `procGroupHasLiveMember` decides.
 */
const scanProcessGroup = (pid: number): Option.Option<GroupMembership> => {
  if (process.platform !== 'linux') {
    return Option.none()
  }
  let entries: readonly string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return Option.none()
  }
  const members: number[] = []
  let read = false
  for (const entry of entries) {
    let stat: string
    if (!procEntryPattern.test(entry)) {
      continue
    }
    try {
      stat = readFileSync(`${procRoot}/${entry}/stat`, 'utf8')
    } catch {
      continue
    }
    const status = parseProcessStatus(stat)
    if (Option.isNone(status)) {
      continue
    }
    read = true
    if (status.value.processGroup !== pid) {
      continue
    }
    if (status.value.state !== zombieState) {
      return Option.some({ kind: 'live' })
    }
    members.push(Number.parseInt(entry, 10))
  }
  return read
    ? Option.some({ kind: 'zombies', members: members.sort((left, right) => left - right) })
    : Option.none()
}

const sameMembers = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((member, index) => member === right[index])

/** How many passes a "dead" verdict may take before it is given up as unknown. */
const deadVerdictPasses = 4

/**
 * Whether the process group led by `pid` still holds a member that is not a zombie, or `none` when
 * `/proc` cannot answer.
 *
 * A single pass cannot settle this: a member forked after the listing is not in it, so one pass can
 * see nothing but zombies while a descendant runs. "Dead" therefore requires two consecutive passes
 * that saw the *same* members — every member that appears, disappears or is replaced between the
 * two moves the set and denies the verdict, and a member present before a pass lists has an entry
 * for that pass to find. Zombies cannot fork, so an agreed set of them names a group that is not
 * producing anything new.
 *
 * What that leaves is narrow and cannot be closed from `/proc`, which offers no atomic view of a
 * group: a member that forks and then dies inside the window between one pass's listing and its
 * reads hides its replacement from that pass, and to survive the verdict it must do so in both
 * passes running. A group still handing off work that way keeps moving the set — that is what the
 * comparison is for — and any pass that finds a running member says alive outright. When the passes
 * cannot agree within their bound the answer is unknown, which every caller reads as alive and
 * probes again, so an inconclusive read costs a poll rather than a live descendant.
 */
const procGroupHasLiveMember = (pid: number): Option.Option<boolean> => {
  let previous: readonly number[] | undefined
  for (let pass = 0; pass < deadVerdictPasses; pass += 1) {
    const scan = scanProcessGroup(pid)
    if (Option.isNone(scan)) {
      return Option.none()
    }
    const membership = scan.value
    if (membership.kind === 'live') {
      return Option.some(true)
    }
    if (previous !== undefined && sameMembers(previous, membership.members)) {
      return Option.some(false)
    }
    previous = membership.members
  }
  return Option.none()
}

/**
 * Whether the process group led by `pid` still contains a process that can run.
 *
 * `process.kill(-pid, 0)` alone answers only whether the group still has an *entry*: it succeeds
 * while the group holds nothing but unreaped zombies, which are processes that have already exited
 * and are waiting for a parent that may never call `wait`. On a host whose PID 1 does not reap
 * orphans — a container, the intended deployment target — a tree that was already `SIGKILL`ed would
 * otherwise report alive indefinitely, and every escalation built on this probe would run to its
 * bound instead of settling as soon as the tree died.
 *
 * On Linux the group's membership is therefore read from `/proc`, and a group whose every remaining
 * member is a zombie reports dead. On any other platform, or when `/proc` cannot be scanned, the
 * answer falls back to the signal probe alone: that may over-report liveness on a non-reaping host,
 * never under-report it, so a descendant that is still running is never abandoned and a leader PID
 * that has been recycled is never signalled.
 */
export const processGroupIsAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
  } catch {
    return false
  }
  return Option.getOrElse(procGroupHasLiveMember(pid), () => true)
}

const signalChildGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  const pid = child.pid
  if (pid === undefined) {
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The process may have exited between the status check and signal delivery.
    }
  }
}

const childProcessGroupIsAlive = (child: ChildProcess): boolean => {
  const pid = child.pid
  if (pid === undefined) {
    return false
  }
  return processGroupIsAlive(pid)
}

/** After `SIGKILL`, how often to look for the process group to empty. */
const reapPollMs = 25

export const terminateChildProcess = (
  child: ChildProcess,
  gracePeriodMs = 5_000,
): Promise<void> => {
  if (!childProcessGroupIsAlive(child)) {
    return Promise.resolve()
  }

  return new Promise<void>((resolve) => {
    let settled = false
    let reapPoll: NodeJS.Timeout | undefined
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(forceTimer)
      clearTimeout(boundTimer)
      if (reapPoll !== undefined) {
        clearInterval(reapPoll)
        reapPoll = undefined
      }
      child.removeListener('exit', handleLeaderExit)
      resolve()
    }
    const handleLeaderExit = (): void => {
      if (!childProcessGroupIsAlive(child)) {
        finish()
      }
    }
    const forceTimer = setTimeout(() => {
      if (!childProcessGroupIsAlive(child)) {
        finish()
        return
      }
      signalChildGroup(child, 'SIGKILL')
      // Signal delivery is asynchronous, and the leader has usually exited by now — so no event is
      // left to report the group emptying. Poll for it rather than waiting out the bound timer,
      // which would hold every caller for the full extra second after the tree was already gone.
      reapPoll = setInterval(() => {
        if (!childProcessGroupIsAlive(child)) {
          finish()
        }
      }, reapPollMs)
    }, gracePeriodMs)
    const boundTimer = setTimeout(finish, gracePeriodMs + 1_000)
    child.once('exit', handleLeaderExit)
    signalChildGroup(child, 'SIGTERM')
    if (!childProcessGroupIsAlive(child)) {
      finish()
    }
  })
}
