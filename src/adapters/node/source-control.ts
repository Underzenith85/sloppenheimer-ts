import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Option, Redacted } from 'effect'

import type { Issue, Workspace } from '../../domain/domain.js'
import { SourceControlError } from '../../errors.js'
import type {
  PreparedRepository,
  PublicationOutcome,
  SourceControlPort,
  SourceControlTarget,
} from '../../ports/source-control.js'

export type GitCredential = Readonly<{
  username: string
  password: Redacted.Redacted<string>
}>

export type GitSourceControlSettings = Readonly<{
  remoteUrl: string
  baseBranch: string
  credential: Option.Option<GitCredential>
}>

type GitFailure = Readonly<{
  args: readonly string[]
  exitCode: number | null
  stdout: string
  stderr: string
  cause?: unknown
}>

const outputLimit = 1024 * 1024
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

const runProcess = (
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', (cause: unknown) => {
      reject({ args, exitCode: null, stdout, stderr, cause } satisfies GitFailure)
    })
    child.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout)
        return
      }
      reject({ args, exitCode, stdout, stderr } satisfies GitFailure)
    })
  })

const runGit = (
  settings: GitSourceControlSettings,
  cwd: string,
  args: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<string> =>
  Option.match(settings.credential, {
    onNone: () =>
      runProcess(cwd, args, {
        ...process.env,
        ...extraEnvironment,
        GIT_TERMINAL_PROMPT: '0',
      }),
    onSome: async (credential) => {
      const directory = await mkdtemp(join(tmpdir(), 'symphony-git-askpass-'))
      const askPass = join(directory, 'askpass.sh')
      try {
        await writeFile(askPass, askPassScript, { mode: 0o700 })
        return await runProcess(cwd, args, {
          ...process.env,
          ...extraEnvironment,
          GIT_ASKPASS: askPass,
          GIT_TERMINAL_PROMPT: '0',
          SYMPHONY_GIT_USERNAME: credential.username,
          SYMPHONY_GIT_PASSWORD: Redacted.value(credential.password),
        })
      } finally {
        await rm(directory, { force: true, recursive: true })
      }
    },
  })

const failureText = (failure: GitFailure): string => `${failure.stderr}\n${failure.stdout}`.trim()

const gitFailure = (cause: unknown, operation: string): GitFailure => {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'args' in cause &&
    Array.isArray(cause.args) &&
    cause.args.every((argument) => typeof argument === 'string') &&
    'stdout' in cause &&
    typeof cause.stdout === 'string' &&
    'stderr' in cause &&
    typeof cause.stderr === 'string' &&
    'exitCode' in cause &&
    (cause.exitCode === null || typeof cause.exitCode === 'number')
  ) {
    return {
      args: cause.args,
      exitCode: cause.exitCode,
      stdout: cause.stdout,
      stderr: cause.stderr,
    }
  }
  return { args: [operation], exitCode: null, stdout: '', stderr: '', cause }
}

const isAuthenticationFailure = (failure: GitFailure): boolean =>
  /authentication failed|could not read username|invalid username or password|permission denied|repository not found|403|401/iu.test(
    failureText(failure),
  )

const sourceControlFailure = (
  failure: GitFailure,
  operation: 'prepare' | 'publish',
): SourceControlError => {
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

const attempt = <Value>(
  operation: 'prepare' | 'publish',
  run: () => Promise<Value>,
): Effect.Effect<Value, SourceControlError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause: unknown) =>
      cause instanceof SourceControlError
        ? cause
        : sourceControlFailure(gitFailure(cause, operation), operation),
  })

const remoteHead = async (
  settings: GitSourceControlSettings,
  workspace: Workspace,
  branchName: string,
): Promise<Option.Option<string>> => {
  const output = await runGit(settings, workspace.path, [
    'ls-remote',
    '--heads',
    'origin',
    `refs/heads/${branchName}`,
  ])
  const sha = output.trim().split(/\s+/u)[0]
  return sha === undefined || sha.length === 0 ? Option.none() : Option.some(sha)
}

const revParse = (
  settings: GitSourceControlSettings,
  workspace: Workspace,
  revision: string,
): Promise<string> =>
  runGit(settings, workspace.path, ['rev-parse', revision]).then((value) => value.trim())

const currentBranch = async (
  settings: GitSourceControlSettings,
  workspace: Workspace,
): Promise<Option.Option<string>> => {
  try {
    const value = await runGit(settings, workspace.path, ['symbolic-ref', '--short', 'HEAD'])
    return Option.some(value.trim())
  } catch {
    return Option.none()
  }
}

const currentHead = async (
  settings: GitSourceControlSettings,
  workspace: Workspace,
): Promise<Option.Option<string>> => {
  try {
    return Option.some(await revParse(settings, workspace, 'HEAD'))
  } catch {
    return Option.none()
  }
}

const status = (settings: GitSourceControlSettings, workspace: Workspace): Promise<string> =>
  runGit(settings, workspace.path, ['status', '--porcelain=v1', '--untracked-files=all'])

const initialize = async (
  settings: GitSourceControlSettings,
  workspace: Workspace,
): Promise<void> => {
  try {
    await runGit(settings, workspace.path, ['rev-parse', '--git-dir'])
    await runGit(settings, workspace.path, ['remote', 'set-url', 'origin', settings.remoteUrl])
  } catch {
    await runGit(settings, workspace.path, ['init'])
    await runGit(settings, workspace.path, ['remote', 'add', 'origin', settings.remoteUrl])
  }
}

const expectedRepairHead = (
  target: SourceControlTarget,
  observed: Option.Option<string>,
): string | null => {
  if (target._tag === 'Normal') {
    return null
  }
  if (Option.contains(observed, target.expectedHeadSha)) {
    return target.expectedHeadSha
  }
  throw new SourceControlError({
    category: 'lease_conflict',
    message: `remote branch ${target.branchName} no longer matches expected head ${target.expectedHeadSha}`,
    retryable: true,
    worktreePreserved: true,
  })
}

const prepareRepository = async (
  settings: GitSourceControlSettings,
  issue: Issue,
  workspace: Workspace,
  target: SourceControlTarget,
): Promise<PreparedRepository> => {
  void issue
  await initialize(settings, workspace)
  await runGit(settings, workspace.path, [
    'fetch',
    '--no-tags',
    'origin',
    `+refs/heads/${settings.baseBranch}:refs/remotes/origin/${settings.baseBranch}`,
  ])
  const baseSha = await revParse(settings, workspace, `refs/remotes/origin/${settings.baseBranch}`)
  const observedRemoteHead = await remoteHead(settings, workspace, target.branchName)
  const repairHead = expectedRepairHead(target, observedRemoteHead)
  if (repairHead !== null) {
    await runGit(settings, workspace.path, [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${target.branchName}:refs/remotes/origin/${target.branchName}`,
    ])
  }

  const branch = await currentBranch(settings, workspace)
  const head = await currentHead(settings, workspace)
  const dirty = (await status(settings, workspace)).length > 0
  const baselineSha = repairHead ?? baseSha
  const unpublishedCommit = Option.exists(head, (sha) => sha !== baselineSha)
  const preserve = Option.contains(branch, target.branchName) && (dirty || unpublishedCommit)
  if (!preserve) {
    await runGit(settings, workspace.path, ['checkout', '-B', target.branchName, baselineSha])
    await runGit(settings, workspace.path, ['reset', '--hard', baselineSha])
  }
  return {
    workspace,
    target,
    baseBranch: settings.baseBranch,
    baseSha,
    baselineSha,
    expectedRemoteHead: observedRemoteHead,
  }
}

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

const publishRepository = async (
  settings: GitSourceControlSettings,
  issue: Issue,
  prepared: PreparedRepository,
): Promise<PublicationOutcome> => {
  const dirty = (await status(settings, prepared.workspace)).length > 0
  if (dirty) {
    await runGit(settings, prepared.workspace.path, ['add', '--all'])
    const commitDate = await runGit(settings, prepared.workspace.path, [
      'show',
      '-s',
      '--format=%aI',
      'HEAD',
    ])
    await runGit(
      settings,
      prepared.workspace.path,
      ['commit', '-m', `symphony: ${issue.identifier} ${issue.title}`],
      {
        ...gitIdentity,
        GIT_AUTHOR_DATE: commitDate.trim(),
        GIT_COMMITTER_DATE: commitDate.trim(),
      },
    )
  }
  let headSha = await revParse(settings, prepared.workspace, 'HEAD')
  if (!dirty && headSha === prepared.baselineSha) {
    return {
      _tag: 'NoChanges',
      branchName: prepared.target.branchName,
      baselineSha: prepared.baselineSha,
    }
  }

  await runGit(settings, prepared.workspace.path, [
    'fetch',
    '--no-tags',
    'origin',
    `+refs/heads/${prepared.baseBranch}:refs/remotes/origin/${prepared.baseBranch}`,
  ])
  try {
    await runGit(
      settings,
      prepared.workspace.path,
      ['rebase', '--committer-date-is-author-date', `refs/remotes/origin/${prepared.baseBranch}`],
      gitIdentity,
    )
  } catch (cause: unknown) {
    try {
      await runGit(settings, prepared.workspace.path, ['rebase', '--abort'])
    } catch {
      // The original failure is the useful one; an absent rebase state needs no cleanup.
    }
    throw new SourceControlError({
      category: 'rebase_conflict',
      message: 'source-control publication could not rebase onto the protected base',
      retryable: true,
      worktreePreserved: true,
      cause,
    })
  }
  headSha = await revParse(settings, prepared.workspace, 'HEAD')
  const actualRemoteHead = await remoteHead(
    settings,
    prepared.workspace,
    prepared.target.branchName,
  )
  if (!sameHead(prepared.expectedRemoteHead, actualRemoteHead)) {
    throw leaseFailure(prepared, actualRemoteHead)
  }
  const expected = Option.getOrElse(prepared.expectedRemoteHead, () => '')
  await runGit(settings, prepared.workspace.path, [
    'push',
    'origin',
    `HEAD:refs/heads/${prepared.target.branchName}`,
    `--force-with-lease=refs/heads/${prepared.target.branchName}:${expected}`,
  ])
  return {
    _tag: 'Published',
    branchName: prepared.target.branchName,
    headSha,
    commitCreated: dirty,
  }
}

export const makeGitSourceControl = (settings: GitSourceControlSettings): SourceControlPort => ({
  prepare: (issue, workspace, target) =>
    attempt('prepare', () => prepareRepository(settings, issue, workspace, target)),
  publish: (issue, prepared) =>
    attempt('publish', () => publishRepository(settings, issue, prepared)),
})
