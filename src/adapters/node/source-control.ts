import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { Effect, Option, Redacted, type Scope } from 'effect'

import type { Issue, Workspace } from '../../domain/domain.js'
import { SourceControlError } from '../../errors.js'
import type {
  PreparedRepository,
  PublicationOutcome,
  SourceControlPort,
  SourceControlTarget,
} from '../../ports/source-control.js'
import { terminateChildProcess } from '../../support/subprocess.js'

export type GitCredential = Readonly<{
  username: string
  password: Redacted.Redacted<string>
}>

export type GitSourceControlSettings = Readonly<{
  remoteUrl: string
  baseBranch: string
  credential: Option.Option<GitCredential>
}>

/** Which port operation a git invocation serves. It decides how a failure is categorised. */
type GitOperation = 'prepare' | 'publish'

/** What one git invocation reports when it does not exit zero, or could not be started at all. */
type GitFailure = Readonly<{
  args: readonly string[]
  exitCode: number | null
  stdout: string
  stderr: string
  cause?: unknown
}>

const outputLimit = 1024 * 1024
/** How long a git process group has to exit politely before it is killed. */
const gitTerminationGraceMs = 5_000
const gitIdentity: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Symphony',
  GIT_AUTHOR_EMAIL: 'symphony@localhost',
  GIT_COMMITTER_NAME: 'Symphony',
  GIT_COMMITTER_EMAIL: 'symphony@localhost',
}
const askPassScript = `#!/bin/sh
case "$1" in
  *sername*) printf '%s\\n' "$SYMPHONY_GIT_USERNAME" ;;
  *) printf '%s\\n' "$SYMPHONY_GIT_PASSWORD" ;;
esac
`

const append = (current: string, chunk: Buffer): string => {
  if (current.length >= outputLimit) {
    return current
  }
  return `${current}${chunk.toString('utf8')}`.slice(0, outputLimit)
}

const failureText = (failure: GitFailure): string => `${failure.stderr}\n${failure.stdout}`.trim()

const isAuthenticationFailure = (failure: GitFailure): boolean =>
  /authentication failed|could not read username|invalid username or password|permission denied|repository not found|403|401/iu.test(
    failureText(failure),
  )

const sourceControlFailure = (failure: GitFailure, operation: GitOperation): SourceControlError => {
  const authentication = isAuthenticationFailure(failure)
  const leaseConflict = /stale info|fetch first|non-fast-forward|rejected.*stale/iu.test(
    failureText(failure),
  )
  return new SourceControlError({
    category: authentication
      ? 'authentication_failed'
      : leaseConflict
        ? 'lease_conflict'
        : operation === 'prepare'
          ? 'prepare_failed'
          : 'publication_failed',
    message: authentication
      ? 'source-control authentication failed'
      : `git ${failure.args[0] ?? operation} failed: ${failureText(failure) || 'no diagnostic'}`,
    retryable: true,
    worktreePreserved: operation === 'publish',
    cause: failure,
  })
}

/** A failure of the askpass staging itself, which has no git invocation to report. */
const askPassFailure = (operation: GitOperation, cause: unknown): SourceControlError =>
  sourceControlFailure(
    { args: [operation], exitCode: null, stdout: '', stderr: '', cause },
    operation,
  )

/**
 * Runs one git invocation as its own process group.
 *
 * The effect settles exactly once, and a failure is built here — at the point of failure — with the
 * captured diagnostics still in hand, so no rejection value has to be re-sniffed further up.
 * Interrupting the fiber terminates the whole git process group rather than letting a clone, fetch
 * or push run on against a workspace nobody is waiting for any more.
 */
const runProcess = (
  operation: GitOperation,
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Effect.Effect<string, SourceControlError> =>
  Effect.async<string, SourceControlError>((resume) => {
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn('git', [...args], {
        cwd,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (cause: unknown) {
      // `spawn` rejects an invalid argument — a NUL byte in a branch name or remote URL — by
      // throwing here rather than emitting `error`. A throw out of this registration would be a
      // defect, bypassing the failure channel this effect declares, so it is reported like any
      // other way of failing to start git.
      resume(
        Effect.fail(
          sourceControlFailure({ args, exitCode: null, stdout: '', stderr: '', cause }, operation),
        ),
      )
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let streamFailure: unknown

    const detach = (): void => {
      child.stdout.removeAllListeners()
      child.stderr.removeAllListeners()
      child.removeAllListeners('error')
      child.removeAllListeners('close')
      // Node delivers a spawn failure asynchronously, so one can still arrive after this effect has
      // settled or been cancelled — and an `error` event with no listener is rethrown as an uncaught
      // exception, which would take the whole host down rather than fail the operation. The
      // replacement listener keeps that from outliving the effect that could report it.
      child.on('error', () => {})
      // The two output pipes are the same hazard with a different trigger: they are streams, so an
      // `error` on either with no listener is likewise uncaught, and the child can still be running
      // after this effect has settled or been cancelled.
      child.stdout.on('error', () => {})
      child.stderr.on('error', () => {})
    }

    /**
     * Reads one output pipe, remembering the first error it raises.
     *
     * A pipe that fails mid-read leaves `stdout` holding a prefix of git's output rather than the
     * whole of it, and callers here read that output for revisions and status. Reporting the
     * invocation as a failure is therefore the safe reading: a truncated answer must never be
     * mistaken for a complete one, whatever exit code git goes on to report.
     */
    const capture = (stream: Readable, append: (chunk: Buffer) => void): void => {
      stream.on('data', append)
      stream.on('error', (cause: unknown) => {
        streamFailure ??= cause
      })
    }

    const settle = (effect: Effect.Effect<string, SourceControlError>): void => {
      if (settled) {
        return
      }
      settled = true
      detach()
      resume(effect)
    }

    capture(child.stdout, (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    capture(child.stderr, (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', (cause: unknown) => {
      settle(
        Effect.fail(
          sourceControlFailure({ args, exitCode: null, stdout, stderr, cause }, operation),
        ),
      )
    })
    // `close` rather than `exit`: both pipes are fully drained by then — which is also what makes
    // this the point at which a pipe failure is known, so it is reported here rather than settling
    // early and leaving the git process running with nobody waiting on it.
    child.once('close', (exitCode: number | null) => {
      if (streamFailure !== undefined) {
        settle(
          Effect.fail(
            sourceControlFailure(
              { args, exitCode, stdout, stderr, cause: streamFailure },
              operation,
            ),
          ),
        )
        return
      }
      if (exitCode === 0) {
        settle(Effect.succeed(stdout))
        return
      }
      settle(Effect.fail(sourceControlFailure({ args, exitCode, stdout, stderr }, operation)))
    })

    return Effect.suspend(() => {
      if (settled) {
        return Effect.void
      }
      settled = true
      detach()
      return Effect.promise(() => terminateChildProcess(child, gitTerminationGraceMs))
    })
  })

/**
 * The path of a `GIT_ASKPASS` script staged in a temporary directory that the surrounding scope
 * removes.
 *
 * `Effect.acquireRelease` rather than a `finally`: a finalizer is visible to the runtime, so an
 * interruption that unwinds the fiber still removes the directory holding a credential-serving
 * script, which a `finally` on a promise chain does not.
 */
const askPassScriptPath = (
  operation: GitOperation,
): Effect.Effect<string, SourceControlError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), 'symphony-git-askpass-')),
      catch: (cause: unknown) => askPassFailure(operation, cause),
    }),
    (directory) =>
      Effect.ignore(Effect.tryPromise(() => rm(directory, { force: true, recursive: true }))),
  ).pipe(
    Effect.flatMap((directory) => {
      const askPass = join(directory, 'askpass.sh')
      return Effect.as(
        Effect.tryPromise({
          try: () => writeFile(askPass, askPassScript, { mode: 0o700 }),
          catch: (cause: unknown) => askPassFailure(operation, cause),
        }),
        askPass,
      )
    }),
  )

const runGit = (
  settings: GitSourceControlSettings,
  operation: GitOperation,
  cwd: string,
  args: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
): Effect.Effect<string, SourceControlError> =>
  Option.match(settings.credential, {
    onNone: () =>
      runProcess(operation, cwd, args, {
        ...process.env,
        ...extraEnvironment,
        GIT_TERMINAL_PROMPT: '0',
      }),
    onSome: (credential) =>
      Effect.scoped(
        Effect.flatMap(askPassScriptPath(operation), (askPass) =>
          runProcess(operation, cwd, args, {
            ...process.env,
            ...extraEnvironment,
            GIT_ASKPASS: askPass,
            GIT_TERMINAL_PROMPT: '0',
            SYMPHONY_GIT_USERNAME: credential.username,
            SYMPHONY_GIT_PASSWORD: Redacted.value(credential.password),
          }),
        ),
      ),
  })

const remoteHead = (
  settings: GitSourceControlSettings,
  operation: GitOperation,
  workspace: Workspace,
  branchName: string,
): Effect.Effect<Option.Option<string>, SourceControlError> =>
  Effect.map(
    runGit(settings, operation, workspace.path, [
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${branchName}`,
    ]),
    (output) => {
      const sha = output.trim().split(/\s+/u)[0]
      return sha === undefined || sha.length === 0 ? Option.none() : Option.some(sha)
    },
  )

const revParse = (
  settings: GitSourceControlSettings,
  operation: GitOperation,
  workspace: Workspace,
  revision: string,
): Effect.Effect<string, SourceControlError> =>
  Effect.map(runGit(settings, operation, workspace.path, ['rev-parse', revision]), (value) =>
    value.trim(),
  )

const currentBranch = (
  settings: GitSourceControlSettings,
  operation: GitOperation,
  workspace: Workspace,
): Effect.Effect<Option.Option<string>> =>
  Effect.option(
    Effect.map(
      runGit(settings, operation, workspace.path, ['symbolic-ref', '--short', 'HEAD']),
      (value) => value.trim(),
    ),
  )

const currentHead = (
  settings: GitSourceControlSettings,
  operation: GitOperation,
  workspace: Workspace,
): Effect.Effect<Option.Option<string>> =>
  Effect.option(revParse(settings, operation, workspace, 'HEAD'))

const status = (
  settings: GitSourceControlSettings,
  operation: GitOperation,
  workspace: Workspace,
): Effect.Effect<string, SourceControlError> =>
  runGit(settings, operation, workspace.path, ['status', '--porcelain=v1', '--untracked-files=all'])

const initialize = (
  settings: GitSourceControlSettings,
  workspace: Workspace,
): Effect.Effect<void, SourceControlError> =>
  runGit(settings, 'prepare', workspace.path, ['rev-parse', '--git-dir']).pipe(
    Effect.zipRight(
      runGit(settings, 'prepare', workspace.path, [
        'remote',
        'set-url',
        'origin',
        settings.remoteUrl,
      ]),
    ),
    Effect.catchAll(() =>
      runGit(settings, 'prepare', workspace.path, ['init']).pipe(
        Effect.zipRight(
          runGit(settings, 'prepare', workspace.path, [
            'remote',
            'add',
            'origin',
            settings.remoteUrl,
          ]),
        ),
      ),
    ),
    Effect.asVoid,
  )

/**
 * The head a repair must start from, or `none` for normal work, which starts from the protected
 * base instead. Absence here chooses the next branch rather than crossing a data boundary, so it is
 * an `Option` and never leaves this module.
 */
const expectedRepairHead = (
  target: SourceControlTarget,
  observed: Option.Option<string>,
): Effect.Effect<Option.Option<string>, SourceControlError> => {
  if (target._tag === 'Normal') {
    return Effect.succeed(Option.none())
  }
  if (Option.contains(observed, target.expectedHeadSha)) {
    return Effect.succeed(Option.some(target.expectedHeadSha))
  }
  return Effect.fail(
    new SourceControlError({
      category: 'lease_conflict',
      message: `remote branch ${target.branchName} no longer matches expected head ${target.expectedHeadSha}`,
      retryable: true,
      worktreePreserved: true,
    }),
  )
}

/**
 * Puts the target branch at the baseline with nothing carried over.
 *
 * Uninterruptible as a pair. `checkout -B` carries a tracked edit across when the file is identical
 * in both commits, so an interruption between the two would leave the target branch checked out and
 * still dirty — and the next preparation reads exactly that as unfinished agent work to preserve,
 * publishing an edit no agent made. The two commands are local and bounded, so an interruption
 * waits them out rather than settling halfway through.
 */
const resetToBaseline = (
  settings: GitSourceControlSettings,
  workspace: Workspace,
  branchName: string,
  baselineSha: string,
): Effect.Effect<void, SourceControlError> =>
  Effect.uninterruptible(
    runGit(settings, 'prepare', workspace.path, ['checkout', '-B', branchName, baselineSha]).pipe(
      Effect.zipRight(
        runGit(settings, 'prepare', workspace.path, ['reset', '--hard', baselineSha]),
      ),
      Effect.asVoid,
    ),
  )

const prepareRepository = (
  settings: GitSourceControlSettings,
  issue: Issue,
  workspace: Workspace,
  target: SourceControlTarget,
): Effect.Effect<PreparedRepository, SourceControlError> =>
  Effect.gen(function* () {
    void issue
    yield* initialize(settings, workspace)
    yield* runGit(settings, 'prepare', workspace.path, [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${settings.baseBranch}:refs/remotes/origin/${settings.baseBranch}`,
    ])
    const baseSha = yield* revParse(
      settings,
      'prepare',
      workspace,
      `refs/remotes/origin/${settings.baseBranch}`,
    )
    const observedRemoteHead = yield* remoteHead(settings, 'prepare', workspace, target.branchName)
    const repairHead = yield* expectedRepairHead(target, observedRemoteHead)
    if (Option.isSome(repairHead)) {
      yield* runGit(settings, 'prepare', workspace.path, [
        'fetch',
        '--no-tags',
        'origin',
        `+refs/heads/${target.branchName}:refs/remotes/origin/${target.branchName}`,
      ])
    }

    const branch = yield* currentBranch(settings, 'prepare', workspace)
    const head = yield* currentHead(settings, 'prepare', workspace)
    const dirty = (yield* status(settings, 'prepare', workspace)).length > 0
    const baselineSha = Option.getOrElse(repairHead, () => baseSha)
    const unpublishedCommit = Option.exists(head, (sha) => sha !== baselineSha)
    const preserve = Option.contains(branch, target.branchName) && (dirty || unpublishedCommit)
    if (!preserve) {
      yield* resetToBaseline(settings, workspace, target.branchName, baselineSha)
    }
    const prepared: PreparedRepository = {
      workspace,
      target,
      baseBranch: settings.baseBranch,
      baseSha,
      baselineSha,
      expectedRemoteHead: observedRemoteHead,
    }
    return prepared
  })

const sameHead = (left: Option.Option<string>, right: Option.Option<string>): boolean =>
  Option.match(left, {
    onNone: () => Option.isNone(right),
    onSome: (sha) => Option.contains(right, sha),
  })

const leaseFailure = (
  prepared: PreparedRepository,
  actual: Option.Option<string>,
): SourceControlError =>
  new SourceControlError({
    category: 'lease_conflict',
    message: `remote branch ${prepared.target.branchName} changed after preparation (expected ${Option.getOrElse(prepared.expectedRemoteHead, () => 'absent')}, found ${Option.getOrElse(actual, () => 'absent')})`,
    retryable: true,
    worktreePreserved: true,
  })

/**
 * Returns the worktree to the head the rebase started from.
 *
 * Uninterruptible, so the guarantee belongs to the cleanup itself rather than to the path that
 * reaches it: an abort that were cancelled halfway would leave exactly the half-written rebase
 * state it exists to clear, and the failure path runs it as an ordinary effect rather than as a
 * finalizer. An interruption therefore waits out one bounded local git invocation.
 *
 * The abort's own outcome is discarded: after a failure the original one is the useful diagnostic,
 * and a rebase that left no state behind needs no cleanup and says so by exiting non-zero.
 */
const abortRebase = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.ignore(runGit(settings, 'publish', prepared.workspace.path, ['rebase', '--abort'])),
  )

const rebaseOntoBase = (
  settings: GitSourceControlSettings,
  prepared: PreparedRepository,
): Effect.Effect<void, SourceControlError> =>
  Effect.catchAll(
    // An interruption terminates the git process group mid-rebase, which leaves `.git/rebase-merge`
    // and a detached head behind. `Effect.catchAll` does not see an interruption, and the next
    // publication's rebase refuses to start on the state this one left, so the abort is also
    // attached as a finalizer.
    Effect.onInterrupt(
      Effect.asVoid(
        runGit(
          settings,
          'publish',
          prepared.workspace.path,
          [
            'rebase',
            '--committer-date-is-author-date',
            `refs/remotes/origin/${prepared.baseBranch}`,
          ],
          gitIdentity,
        ),
      ),
      () => abortRebase(settings, prepared),
    ),
    (cause) =>
      Effect.zipRight(
        abortRebase(settings, prepared),
        Effect.fail(
          new SourceControlError({
            category: 'rebase_conflict',
            message: 'source-control publication could not rebase onto the protected base',
            retryable: true,
            worktreePreserved: true,
            cause,
          }),
        ),
      ),
  )

const publishRepository = (
  settings: GitSourceControlSettings,
  issue: Issue,
  prepared: PreparedRepository,
): Effect.Effect<PublicationOutcome, SourceControlError> =>
  Effect.gen(function* () {
    const dirty = (yield* status(settings, 'publish', prepared.workspace)).length > 0
    if (dirty) {
      yield* runGit(settings, 'publish', prepared.workspace.path, ['add', '--all'])
      const commitDate = yield* runGit(settings, 'publish', prepared.workspace.path, [
        'show',
        '-s',
        '--format=%aI',
        'HEAD',
      ])
      yield* runGit(
        settings,
        'publish',
        prepared.workspace.path,
        ['commit', '-m', `symphony: ${issue.identifier} ${issue.title}`],
        {
          ...gitIdentity,
          GIT_AUTHOR_DATE: commitDate.trim(),
          GIT_COMMITTER_DATE: commitDate.trim(),
        },
      )
    }
    const committedHead = yield* revParse(settings, 'publish', prepared.workspace, 'HEAD')
    if (!dirty && committedHead === prepared.baselineSha) {
      const unchanged: PublicationOutcome = {
        _tag: 'NoChanges',
        branchName: prepared.target.branchName,
        baselineSha: prepared.baselineSha,
      }
      return unchanged
    }

    yield* runGit(settings, 'publish', prepared.workspace.path, [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${prepared.baseBranch}:refs/remotes/origin/${prepared.baseBranch}`,
    ])
    yield* rebaseOntoBase(settings, prepared)
    const headSha = yield* revParse(settings, 'publish', prepared.workspace, 'HEAD')
    const actualRemoteHead = yield* remoteHead(
      settings,
      'publish',
      prepared.workspace,
      prepared.target.branchName,
    )
    if (!sameHead(prepared.expectedRemoteHead, actualRemoteHead)) {
      return yield* Effect.fail(leaseFailure(prepared, actualRemoteHead))
    }
    const expected = Option.getOrElse(prepared.expectedRemoteHead, () => '')
    yield* runGit(settings, 'publish', prepared.workspace.path, [
      'push',
      'origin',
      `HEAD:refs/heads/${prepared.target.branchName}`,
      `--force-with-lease=refs/heads/${prepared.target.branchName}:${expected}`,
    ])
    const published: PublicationOutcome = {
      _tag: 'Published',
      branchName: prepared.target.branchName,
      headSha,
      commitCreated: dirty,
    }
    return published
  })

export const makeGitSourceControl = (settings: GitSourceControlSettings): SourceControlPort => ({
  prepare: (issue, workspace, target) => prepareRepository(settings, issue, workspace, target),
  publish: (issue, prepared) => publishRepository(settings, issue, prepared),
})
