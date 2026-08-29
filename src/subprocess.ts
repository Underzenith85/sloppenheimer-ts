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

export const terminateChildProcess = (
  child: ChildProcess,
  gracePeriodMs = 5_000,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
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
      child.removeListener('exit', finish)
      resolve()
    }
    const forceTimer = setTimeout(() => {
      signalChildGroup(child, 'SIGKILL')
    }, gracePeriodMs)
    const boundTimer = setTimeout(finish, gracePeriodMs + 1_000)
    child.once('exit', finish)
    signalChildGroup(child, 'SIGTERM')
    if (child.exitCode !== null || child.signalCode !== null) {
      finish()
    }
  })
}
