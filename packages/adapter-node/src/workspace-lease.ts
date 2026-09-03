import { randomUUID } from 'node:crypto'
import { readFileSync, readlinkSync } from 'node:fs'

import {
  leaseIsClaimed,
  type OwnerObservation,
  type WorkspaceLeaseRecord,
  type WorkspaceOwner,
} from '@sloppenheimer/core/domain/workspace-lease.js'

/**
 * The host half of the workspace lease: who this process is, and whether a lease another process
 * wrote still has an owner. What a record means is decided in `domain/workspace-lease.ts`; where
 * the file lives, in `workspace-lease-store.ts`.
 */

/**
 * When a process id's own process started, as the kernel reports it — the field that tells a
 * restarted host apart from the one whose id it inherited.
 *
 * `/proc/<pid>/stat` is Linux's, and the only portable-enough source there is; a host without it
 * reports nothing rather than a value another host could not compare against. The command field can
 * hold spaces and parentheses, so the fields are read after its closing one, where `starttime` is
 * the twentieth.
 */
export const processStartMarker = (processId: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${String(processId)}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] ?? null
  } catch {
    return null
  }
}

/**
 * The process namespace this host's process ids belong to, identified so that another host reading
 * the same workspace root can tell whether its own ids mean the same thing.
 *
 * The namespace inode alone repeats across machines, so it is paired with the kernel's boot
 * identifier: together they name one namespace on one running kernel. Both are Linux's, and a host
 * without them reports nothing rather than a value another host could not compare against.
 */
const processNamespace = (): string | null => {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const namespace = readlinkSync('/proc/self/ns/pid')
    return `${bootId}/${namespace}`
  } catch {
    return null
  }
}

/**
 * This host process, for as long as it runs. A lease naming it is this process's own, whatever the
 * operating system later does with the process id — which is why the identity is generated here
 * rather than taken from the pid alone. It is a module constant, so a workflow reload that rebuilds
 * the workspace manager keeps the same owner and still recognizes the leases it already holds.
 */
export const hostOwner: WorkspaceOwner = {
  hostId: randomUUID(),
  processId: process.pid,
  startMarker: processStartMarker(process.pid),
  namespace: processNamespace(),
}

/**
 * Whether an owner's process ids are this host's to read: the same process namespace, named by both
 * sides and the same.
 *
 * Nothing weaker will do. Two containers can share a kernel and a workspace root while each sees
 * only its own process ids, and the kernel's boot identifier is common to both of them — so a host
 * that fell back to it would probe its own namespace with the other's id and read a stranger's
 * process as the owner, or as gone. A host that cannot name both namespaces reads nobody else's
 * process ids, and leaves those owners to renewal.
 */
const sharesProcessIds = (owner: WorkspaceOwner): boolean =>
  owner.namespace !== null && owner.namespace === hostOwner.namespace

/**
 * What this host can see of a lease's owner now.
 *
 * An owner whose process ids are not this host's to read — another container's namespace, another
 * machine, or a platform that names neither — is unobservable, and is left to the age rule rather
 * than probed against whatever process happens to carry its id here.
 *
 * Otherwise, signal 0 performs the permission and existence checks without delivering anything.
 * `EPERM` means the process exists and belongs to another user, which is still a running owner. Any
 * other refusal is reported as running too: a cleanup that cannot establish an owner is gone must
 * not remove its workspace. A running process is reported with its own start marker, so a process
 * id the kernel handed to a successor is not mistaken for the process that recorded it.
 */
export const observeOwner = (owner: WorkspaceOwner): OwnerObservation => {
  if (!sharesProcessIds(owner)) {
    return { _tag: 'Unobservable' }
  }
  try {
    process.kill(owner.processId, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return { _tag: 'Gone' }
    }
  }
  return { _tag: 'Running', startMarker: processStartMarker(owner.processId) }
}

/**
 * The lease records this process still has, by the path they were published under.
 *
 * A record cannot answer this for itself. Releasing rewrites it, and a release whose write does not
 * land — a full disk, a filesystem that went away — would leave `held` beside this host's own id
 * for a run that ended, which every later reading in this process would take for a live run. What
 * this process holds is something it knows rather than something it reads, so it is kept here: one
 * set per process, not per manager, because a workflow reload builds a second manager while the
 * runs of the first are still going, and their leases are the same process's either way.
 */
const heldHere = new Set<string>()

export const holdLease = (leasePath: string): void => {
  heldHere.add(leasePath)
}

export const dropLease = (leasePath: string): void => {
  heldHere.delete(leasePath)
}

/**
 * Whether a published lease record still belongs to a running owner, as this host sees it now: its
 * own leases are the ones it still has, and another host's are the ones whose process is still
 * there.
 */
export const leaseIsLive = (lease: WorkspaceLeaseRecord, leasePath: string): boolean =>
  leaseIsClaimed(
    lease,
    { hostId: hostOwner.hostId, stillHeld: heldHere.has(leasePath) },
    observeOwner(lease.owner),
  )

/**
 * Whether the host that retained a record is finished with it: this host itself, whose intentions
 * for the workspace are the caller's to state, or a host whose process can be seen to be gone and
 * so holds no intention at all.
 *
 * A retained record is nobody's claim, so this is not the liveness question `leaseIsLive` asks; it
 * is whether anyone could still mean to republish from the directory. A live peer might — a
 * retained delivery is in-memory intent, invisible from here — and so might one this host cannot
 * place, which is left alone the way every workspace of an owner it cannot see is.
 */
export const retainedOwnerIsFinished = (lease: WorkspaceLeaseRecord): boolean =>
  lease.owner.hostId === hostOwner.hostId || observeOwner(lease.owner)._tag === 'Gone'

/**
 * The same question of a record that has been staged but not yet published. One this process wrote
 * is on its way to a name of its own, and is never swept out from under its own writer.
 */
export const stagedLeaseIsLive = (lease: WorkspaceLeaseRecord): boolean =>
  leaseIsClaimed(lease, { hostId: hostOwner.hostId, stillHeld: true }, observeOwner(lease.owner))
