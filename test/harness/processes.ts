import { readFileSync } from 'node:fs'

import { parseProcessStatus } from '../../src/support/subprocess.js'

/** Whether this host exposes the Linux `/proc` entries the zombie check reads. */
const procIsReadable = ((): boolean => {
  if (process.platform !== 'linux') {
    return false
  }
  try {
    readFileSync('/proc/self/stat', 'utf8')
    return true
  } catch {
    return false
  }
})()

/**
 * Whether `pid` names a process that can still run.
 *
 * A process that has exited but has not been reaped stays visible to `process.kill(pid, 0)` as a
 * zombie, and on a host whose PID 1 does not reap orphans it can stay visible long after the tree
 * that owned it was killed. A termination assertion that counted such an entry as alive would fail
 * on that host while the code under test behaved correctly, so a zombie counts as dead here. Where
 * `/proc` is unavailable the signal probe is all there is, which is the previous behaviour.
 */
export const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (!procIsReadable) {
    return true
  }
  let stat: string
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
  } catch {
    // The process left between the signal probe and the read.
    return false
  }
  const status = parseProcessStatus(stat)
  return status === null || status.state !== 'Z'
}
