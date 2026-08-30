import type { ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

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
 * Parses one `/proc/<pid>/stat` line, or returns null when it does not have the expected shape.
 *
 * The second field, `comm`, is the executable name in parentheses and may itself contain spaces and
 * parentheses, so the remaining fields are read from after its final `)` rather than by splitting
 * the whole line.
 */
export const parseProcessStatus = (stat: string): ProcessStatus | null => {
  const commEnd = stat.lastIndexOf(')')
  if (commEnd === -1) {
    return null
  }
  // After `comm`: state, ppid, pgrp, ...
  const fields = stat
    .slice(commEnd + 1)
    .trim()
    .split(' ')
  const state = fields[0]
  const group = fields[2]
  if (state === undefined || state.length === 0 || group === undefined) {
    return null
  }
  const processGroup = Number.parseInt(group, 10)
  if (!Number.isSafeInteger(processGroup)) {
    return null
  }
  return { state, processGroup }
}

/**
 * Whether the process group led by `pid` still holds a member that is not a zombie, or null when
 * the host does not let the question be answered — `/proc` is Linux-only, and an entry may vanish
 * mid-scan. A scan that reads no process at all is reported as unknown rather than as an empty
 * group, so an unreadable `/proc` never turns into a claim that the group is dead.
 */
const procGroupHasLiveMember = (pid: number): boolean | null => {
  if (process.platform !== 'linux') {
    return null
  }
  let entries: readonly string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return null
  }
  let read = false
  for (const entry of entries) {
    if (!procEntryPattern.test(entry)) {
      continue
    }
    let stat: string
    try {
      stat = readFileSync(`${procRoot}/${entry}/stat`, 'utf8')
    } catch {
      // The process exited between the listing and the read; it is not a live member either way.
      continue
    }
    const status = parseProcessStatus(stat)
    if (status === null) {
      continue
    }
    read = true
    if (status.processGroup === pid && status.state !== zombieState) {
      return true
    }
  }
  return read ? false : null
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
  return procGroupHasLiveMember(pid) ?? true
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
