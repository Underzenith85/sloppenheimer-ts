import type { ChildProcess } from 'node:child_process'

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
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

export const terminateChildProcess = (
  child: ChildProcess,
  gracePeriodMs = 5_000,
): Promise<void> => {
  if (!childProcessGroupIsAlive(child)) {
    return Promise.resolve()
  }

  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(forceTimer)
      clearTimeout(boundTimer)
      child.removeListener('exit', handleLeaderExit)
      resolve()
    }
    const handleLeaderExit = (): void => {
      if (!childProcessGroupIsAlive(child)) {
        finish()
      }
    }
    const forceTimer = setTimeout(() => {
      if (childProcessGroupIsAlive(child)) {
        signalChildGroup(child, 'SIGKILL')
      } else {
        finish()
      }
    }, gracePeriodMs)
    const boundTimer = setTimeout(finish, gracePeriodMs + 1_000)
    child.once('exit', handleLeaderExit)
    signalChildGroup(child, 'SIGTERM')
    if (!childProcessGroupIsAlive(child)) {
      finish()
    }
  })
}
