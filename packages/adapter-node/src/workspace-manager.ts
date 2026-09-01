import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Cause, Effect, Exit, Option } from 'effect'

import type { HooksConfig } from '@sloppenheimer/core/config/workflow.js'
import type { Workspace } from '@sloppenheimer/core/domain/domain.js'
import {
  containedRunWorkspacePath,
  leaseStagingPath,
  runWorkspaceKey,
  type RunWorkspacePaths,
} from '@sloppenheimer/core/domain/workspace-containment.js'
import {
  heldLease,
  leaseNamesRun,
  leaseRenewalIntervalMs,
  retainedLease,
  type WorkspaceOwner,
  type WorkspaceRelease,
  type WorkspaceRun,
} from '@sloppenheimer/core/domain/workspace-lease.js'
import { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import type { WorkspaceManagerPort } from '@sloppenheimer/core/ports/workspace.js'
import { currentInstant } from '@sloppenheimer/core/support/clock.js'
import { logWarning } from '@sloppenheimer/core/support/logging.js'
import { realDirectoryExists, reportedAs } from './filesystem.js'
import { hostOwner, renewLease } from './workspace-lease.js'
import {
  discardStagedLease,
  publishClaimedLease,
  pruneStagedLeases,
  readLease,
  stagedLeasePath,
  writeLease,
  writeStagedLease,
} from './workspace-lease-store.js'
import {
  issueHoldsWorkspace,
  removeIssueWorkspaces,
  removeRunWorkspace,
} from './workspace-cleanup.js'
import { runHook } from './workspace-hooks.js'

/**
 * The Node implementation of `WorkspaceManagerPort`: the per-run directory lifecycle, with the
 * containment rules taken from `domain/workspace-containment.ts`, the lease rules from
 * `domain/workspace-lease.ts`, and the hooks run by `workspace-hooks.ts`.
 *
 * An issue owns a directory under the configured root, and every dispatched run owns a directory
 * under that, leased to it for as long as it runs. Two runs of one issue therefore share no
 * worktree, no index and no ref store, and a run that ends without publishing leaves its directory
 * behind as a lease record naming the issue, the run and the host that produced it.
 */

/**
 * Everything a claim needs in place before it can be published: the issue directory that will hold
 * the run, and the record itself, written where nothing yet refers to it.
 *
 * All of it is ordinary filesystem work a cancellation may interrupt — the file it leaves behind is
 * named by the caller, which takes it away again.
 */
const prepareRunClaim = (
  fileSystem: FileSystem.FileSystem,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  owner: WorkspaceOwner,
  staged: string,
): Effect.Effect<number, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    // The issue directory is only ever a container for run directories, so an existing one is
    // reused — once it has been confirmed to be a real directory rather than a substituted path.
    if (!(yield* realDirectoryExists(fileSystem, paths.issuePath))) {
      yield* fileSystem.makeDirectory(paths.issuePath, { recursive: true })
    }
    const acquiredAt = yield* currentInstant
    const lease = heldLease(run, paths.runKey, owner, acquiredAt)
    yield* writeStagedLease(fileSystem, staged, lease)
    // How long the claim itself stands for, which is what the renewal carries forward.
    return Date.parse(lease.expiresAt)
  })

/**
 * Publishes the prepared claim: one atomic link, which is what makes the lease exist and what a
 * second dispatch of the same run identity loses to.
 */
const publishRunClaim = (
  fileSystem: FileSystem.FileSystem,
  paths: RunWorkspacePaths,
  staged: string,
): Effect.Effect<void, WorkspaceError | PlatformError> =>
  publishClaimedLease(fileSystem, staged, paths.leasePath).pipe(
    Effect.catchIf(
      (error) => error._tag === 'SystemError' && error.reason === 'AlreadyExists',
      (error) =>
        Effect.fail(
          new WorkspaceError({
            category: 'lease_conflict',
            message: `workspace is already allocated to another run: ${paths.runPath}`,
            cause: error,
          }),
        ),
    ),
  )

/** Reports a failure that a release has no one left to report it to. */
const warnRelease = (path: string, error: WorkspaceError): Effect.Effect<void> =>
  logWarning('workspace lease release failed', {
    action: 'workspace_release',
    outcome: 'failed',
    path,
    error: error.message,
  })

/** A workspace and the run holding its lease, which is what releasing it takes. */
type LeasedWorkspace = Readonly<{
  run: WorkspaceRun
  workspace: Workspace
}>

/** Rewrites a held lease as the retained recovery artifact the reason names. */
const retainLease = (
  fileSystem: FileSystem.FileSystem,
  owner: WorkspaceOwner,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  reason: string,
): Effect.Effect<void, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    const releasedAt = yield* currentInstant
    const existing = yield* readLease(fileSystem, paths.leasePath)
    const ours = Option.filter(existing, (lease) =>
      leaseNamesRun(lease, run, paths.runKey, owner.hostId),
    )
    // A record that is gone or another run's is one cleanup took while this run was ending, and
    // the directory it named may have gone with it. Publishing a lease here would leave a retained
    // record for a workspace that is not there, so the run lets go of what it no longer holds.
    yield* Option.match(ours, {
      onNone: () => Effect.void,
      onSome: (lease) => writeLease(fileSystem, paths, retainedLease(lease, reason, releasedAt)),
    })
  })

/** Why an acquisition that took the lease and then failed is keeping the workspace. */
const provisioningReason = (cause: Cause.Cause<WorkspaceError>): string =>
  Option.match(Cause.failureOption(cause), {
    onNone: () => 'workspace provisioning was interrupted',
    // The category, never the message: a hook's failure carries an excerpt of what it wrote, and
    // the lease record is a file on disk rather than a log the redaction rules pass over.
    onSome: (error) => `workspace provisioning failed: ${error.category}`,
  })

/**
 * The directory the agent works in, and the operator's chance to provision it. Both belong inside
 * the lease rather than beside it: the workspace exists only once its lease does.
 */
const provisionRunWorkspace = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  workspace: Workspace,
): Effect.Effect<void, WorkspaceError> =>
  Effect.gen(function* () {
    yield* fileSystem.makeDirectory(workspace.path)
    // `after_create` is fatal: a workspace whose provisioning hook failed is not usable. It runs
    // for every run, because every run is given a directory that did not exist before it.
    if (hooks.afterCreate !== null) {
      yield* runHook('after_create', hooks.afterCreate, workspace.path, hooks.timeoutMs)
    }
  }).pipe(reportedAs('create_failed', 'failed to create workspace'))

/** Discards a released workspace, or keeps it as the recovery artifact its lease names. */
const disposeOfWorkspace = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  owner: WorkspaceOwner,
  paths: RunWorkspacePaths,
  run: WorkspaceRun,
  reason: string | null,
): Effect.Effect<void, WorkspaceError | PlatformError> =>
  Effect.gen(function* () {
    if (reason === null) {
      yield* removeRunWorkspace(fileSystem, hooks, paths.runPath)
      // The issue directory itself stays. It is an empty container once its last run has gone, and
      // removing it here would race an acquisition that has just created its own run directory
      // inside it; cleanup takes it when the issue is finished with.
      return
    }
    yield* retainLease(fileSystem, owner, paths, run, reason)
  })

/** Releasing reports to nobody: the run it followed has already ended, so a failure is logged. */
const releaseRunWorkspace = (
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  root: string,
  owner: WorkspaceOwner,
  leased: LeasedWorkspace,
  release: WorkspaceRelease,
): Effect.Effect<void> =>
  containedRunWorkspacePath(root, leased.run.identifier, leased.workspace.key).pipe(
    Effect.flatMap((paths) =>
      disposeOfWorkspace(
        fileSystem,
        hooks,
        owner,
        paths,
        leased.run,
        release._tag === 'Completed' ? null : release.reason,
      ).pipe(reportedAs('remove_failed', 'failed to release workspace')),
    ),
    Effect.catchAll((error) => warnRelease(leased.workspace.path, error)),
  )

/**
 * One run's whole hold on a workspace: the claim, the directory it names, and the release that
 * hands it back however the run ended.
 *
 * Only the claim is uninterruptible. It is one link into place, and taking it under a mask is what
 * keeps a published lease from ever existing without the finalizer that hands it back. Everything
 * after it — provisioning, the `after_create` hook, and the caller's own use — runs restored, so a
 * cancellation reaches a hook's process tree instead of waiting out its timeout, and each of the
 * two is bracketed in turn with no interruptible gap between them. The renewal that keeps the lease
 * standing spans both, because neither is bounded from above.
 */
const leaseRunWorkspace = <Value, Failure, Requirements>(
  fileSystem: FileSystem.FileSystem,
  hooks: HooksConfig,
  root: string,
  owner: WorkspaceOwner,
  renewal: LeaseRenewal,
  run: WorkspaceRun,
  use: (workspace: Workspace) => Effect.Effect<Value, Failure, Requirements>,
  disposition: (exit: Exit.Exit<Value, Failure | WorkspaceError>) => WorkspaceRelease,
): Effect.Effect<Value, Failure | WorkspaceError, Requirements> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const paths = yield* containedRunWorkspacePath(
        root,
        run.identifier,
        runWorkspaceKey(run.runId, owner.hostId),
      )
      // Preparing the claim is ordinary filesystem work and stays interruptible; what is masked
      // is the link that publishes it, which is one step and cannot be left half done.
      const staged = stagedLeasePath(paths.stagingPath)
      const standingUntil = yield* restore(
        prepareRunClaim(fileSystem, paths, run, owner, staged),
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : discardStagedLease(fileSystem, staged),
        ),
        reportedAs('create_failed', 'failed to create workspace'),
      )
      yield* publishRunClaim(fileSystem, paths, staged).pipe(
        reportedAs('create_failed', 'failed to create workspace'),
      )
      const workspace: Workspace = { path: paths.runPath, key: paths.runKey }
      // Both of the steps that follow run against the renewal rather than after it: provisioning is
      // no more bounded than the run is — an `after_create` hook is the caller's own command — and
      // neither may go on under a lease this run has stopped holding. Racing is what orders them:
      // the work ends and the renewal is interrupted, or the renewal fails and the work is
      // interrupted, and either way both have finished before the record is rewritten below.
      const keepingLease = renewLease(
        fileSystem,
        paths,
        run,
        owner,
        renewal.intervalMs,
        standingUntil,
      )
      // From here the lease is this run's own. Provisioning that does not finish keeps the
      // workspace under the reason it failed for, rather than leaving a lease nobody holds.
      yield* restore(
        Effect.raceFirst(provisionRunWorkspace(fileSystem, hooks, workspace), keepingLease),
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.ignore(
                retainLease(fileSystem, owner, paths, run, provisioningReason(exit.cause)),
              ),
        ),
      )
      return yield* restore(Effect.raceFirst(use(workspace), keepingLease)).pipe(
        Effect.onExit((exit) =>
          releaseRunWorkspace(
            fileSystem,
            hooks,
            root,
            owner,
            { run, workspace },
            disposition(exit),
          ),
        ),
      )
    }),
  )

/**
 * How long a staged lease record can be in flight before it can only be an abandoned one. Staging
 * is a single write, so an hour is far past any writer and far short of leaving orphans on disk for
 * the life of the root.
 */
const stagedLeaseLifetimeMs = 60 * 60 * 1_000

/** How often a run says its lease still stands. Tests shorten it; the host runs at the default. */
export type LeaseRenewal = Readonly<{ intervalMs: number }>

export const makeWorkspaceManager = (
  root: string,
  hooks: HooksConfig,
  owner: WorkspaceOwner = hostOwner,
  renewal: LeaseRenewal = { intervalMs: leaseRenewalIntervalMs },
): Effect.Effect<WorkspaceManagerPort, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    // A host killed between staging a record and publishing it leaves the staged file behind, and
    // nothing else ever reads that directory. Sweeping it here takes those away once per manager —
    // at startup, and again whenever a reload rebuilds one — and can never reach a record a live
    // writer is still holding, because such a record is seconds old.
    const now = yield* currentInstant
    yield* pruneStagedLeases(fileSystem, leaseStagingPath(root), now, stagedLeaseLifetimeMs)
    return {
      withLeasedWorkspace: (run, use, disposition) =>
        leaseRunWorkspace(fileSystem, hooks, root, owner, renewal, run, use, disposition),
      exists: (identifier) => issueHoldsWorkspace(fileSystem, root, identifier),
      // `before_run` is fatal: the orchestrator retries the issue instead of launching an agent.
      beforeRun: (workspace) =>
        hooks.beforeRun === null
          ? Effect.void
          : runHook('before_run', hooks.beforeRun, workspace.path, hooks.timeoutMs),
      // `after_run` is best effort: the turn already happened.
      afterRun: (workspace) =>
        hooks.afterRun === null
          ? Effect.void
          : runHook('after_run', hooks.afterRun, workspace.path, hooks.timeoutMs).pipe(
              Effect.catchAll(() => Effect.void),
            ),
      remove: (identifier) => removeIssueWorkspaces(fileSystem, hooks, root, identifier),
    }
  })
