import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { Effect, Option, Redacted, type Scope } from 'effect'

import { SourceControlError } from '@symphony/core/domain/errors.js'
import {
  detachChildProcess,
  resumeOnce,
  terminateChildProcess,
} from '@symphony/core/support/subprocess.js'

/**
 * How one git invocation runs, and how the way it failed is read.
 *
 * Everything here is about the process: its environment, the credential-serving askpass script it
 * is given, the bounded capture of both its pipes, and the classification of a non-zero exit into
 * a typed `SourceControlError`. Nothing here knows what the repository is being prepared for —
 * `source-control.ts` owns that, and reaches git only through {@link runGit}.
 */

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
export type GitOperation = 'prepare' | 'publish'

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
export const gitIdentity: NodeJS.ProcessEnv = {
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

/** What a failure reads like to a human: both streams, so no diagnostic is lost from the message. */
const failureText = (failure: GitFailure): string => `${failure.stderr}\n${failure.stdout}`.trim()

/**
 * The text a failure is classified from: git's diagnostics, never its data.
 *
 * `stdout` is what the command was asked for — `rev-parse` writes a commit SHA there, `ls-remote` a
 * ref listing — and a failure carries whatever of it had been read. Classifying on that text made a
 * SHA containing `403` read as an HTTP status, which is a real reading for roughly one commit in
 * fifty-four.
 */
const diagnosticText = (failure: GitFailure): string => failure.stderr.trim()

const isAuthenticationFailure = (failure: GitFailure): boolean =>
  /authentication failed|could not read username|invalid username or password|permission denied|repository not found|returned error: 40[13]/iu.test(
    diagnosticText(failure),
  )

const sourceControlFailure = (failure: GitFailure, operation: GitOperation): SourceControlError => {
  const authentication = isAuthenticationFailure(failure)
  const leaseConflict = /stale info|fetch first|non-fast-forward|rejected.*stale/iu.test(
    diagnosticText(failure),
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
    let streamFailure: unknown

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

    // Node delivers a spawn failure asynchronously, so one can still arrive after this effect has
    // settled or been cancelled, and the child outlives an interrupted fiber until the terminator
    // below reaps it. `resumeOnce` is what keeps both from reaching a resume that has already
    // fired, and takes the listeners off as it settles.
    const { settle, claim } = resumeOnce(resume, () => {
      detachChildProcess(child)
    })

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

    // Interruption: a git invocation nobody is waiting on any more must not keep running against
    // the workspace, but one that already settled has nothing left to terminate.
    return Effect.suspend(() =>
      claim()
        ? Effect.promise(() => terminateChildProcess(child, gitTerminationGraceMs))
        : Effect.void,
    )
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

export const runGit = (
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
