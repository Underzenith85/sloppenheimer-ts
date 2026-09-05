import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Option, Redacted, type Scope } from 'effect'

import { SourceControlError } from '@sloppenheimer/core/domain/errors.js'
import { runCommand } from './command.js'

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
  /** Hard deadline per Git invocation, independent of agent protocol silence. */
  timeoutMs?: number
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
const gitTerminationGraceMs = 1_000
const gitTimeoutMs = 15 * 60 * 1000
export const gitIdentity: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Sloppenheimer',
  GIT_AUTHOR_EMAIL: 'sloppenheimer@localhost',
  GIT_COMMITTER_NAME: 'Sloppenheimer',
  GIT_COMMITTER_EMAIL: 'sloppenheimer@localhost',
}
const askPassScript = `#!/bin/sh
case "$1" in
  *sername*) printf '%s\\n' "$SLOPPENHEIMER_GIT_USERNAME" ;;
  *) printf '%s\\n' "$SLOPPENHEIMER_GIT_PASSWORD" ;;
esac
`

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

/**
 * Whether a failed `rebase` is a content conflict, as opposed to git refusing to start or finish
 * the rebase at all -- a stale `rebase-merge` directory, a lock it could not take, a process that
 * could not be spawned. Only the first is a conflict: the second keeps the category every other
 * git failure gets, so a caller that treats a conflict as final does not treat a transient failure
 * as final with it. A rebase's stdout is diagnostics rather than data, so both streams are read.
 */
const isRebaseConflict = (failure: GitFailure): boolean =>
  failure.args[0] === 'rebase' &&
  /could not apply|resolve all conflicts|CONFLICT \(/iu.test(failureText(failure))

const sourceControlFailure = (failure: GitFailure, operation: GitOperation): SourceControlError => {
  const authentication = isAuthenticationFailure(failure)
  const leaseConflict = /stale info|fetch first|non-fast-forward|rejected.*stale/iu.test(
    diagnosticText(failure),
  )
  const rebaseConflict = isRebaseConflict(failure)
  return new SourceControlError({
    category: authentication
      ? 'authentication_failed'
      : leaseConflict
        ? 'lease_conflict'
        : rebaseConflict
          ? 'rebase_conflict'
          : operation === 'prepare'
            ? 'prepare_failed'
            : 'publication_failed',
    message: authentication
      ? 'source-control authentication failed'
      : rebaseConflict
        ? `source-control publication could not rebase onto the protected base: ${failureText(failure)}`
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
  timeoutMs: number,
): Effect.Effect<string, SourceControlError> =>
  runCommand({
    command: 'git',
    args,
    cwd,
    environment,
    timeoutMs,
    captureLimit: outputLimit,
    terminationGraceMs: gitTerminationGraceMs,
  }).pipe(
    Effect.mapError((cause) =>
      sourceControlFailure(
        {
          args,
          exitCode: null,
          stdout: '',
          stderr: cause.message,
          cause,
        },
        operation,
      ),
    ),
    Effect.flatMap((result) => {
      // Git stdout is data: incomplete capture cannot be accepted as a revision or status.
      if (result.code === 0 && !result.outputInterrupted && !result.stdoutTruncated) {
        return Effect.succeed(result.stdout)
      }
      return Effect.fail(
        sourceControlFailure(
          {
            args,
            exitCode: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            cause: result.outputInterrupted ? 'output pipe failed' : result,
          },
          operation,
        ),
      )
    }),
  )

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
      try: () => mkdtemp(join(tmpdir(), 'sloppenheimer-git-askpass-')),
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
      runProcess(
        operation,
        cwd,
        args,
        {
          ...process.env,
          ...extraEnvironment,
          GIT_TERMINAL_PROMPT: '0',
        },
        settings.timeoutMs ?? gitTimeoutMs,
      ),
    onSome: (credential) =>
      Effect.scoped(
        Effect.flatMap(askPassScriptPath(operation), (askPass) =>
          runProcess(
            operation,
            cwd,
            args,
            {
              ...process.env,
              ...extraEnvironment,
              GIT_ASKPASS: askPass,
              GIT_TERMINAL_PROMPT: '0',
              SLOPPENHEIMER_GIT_USERNAME: credential.username,
              SLOPPENHEIMER_GIT_PASSWORD: Redacted.value(credential.password),
            },
            settings.timeoutMs ?? gitTimeoutMs,
          ),
        ),
      ),
  })
