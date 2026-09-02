import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const git = (cwd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd }, (cause, stdout, stderr) => {
      if (cause !== null) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr}`, { cause }))
        return
      }
      resolve(stdout.trim())
    })
  })

export type GitRepositoryFixture = Readonly<{
  root: string
  remote: string
  seed: string
  workspace: string
}>

export const makeGitRepository = async (): Promise<GitRepositoryFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'sloppenheimer-source-control-'))
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const workspace = join(root, 'workspace')
  await mkdir(seed)
  await mkdir(workspace)
  await git(root, ['init', '--bare', remote])
  await git(seed, ['init'])
  await git(seed, ['checkout', '-b', 'main'])
  await git(seed, ['config', 'user.name', 'Test Author'])
  await git(seed, ['config', 'user.email', 'test@example.test'])
  await writeFile(join(seed, 'README.md'), 'base\n')
  await git(seed, ['add', 'README.md'])
  await git(seed, ['commit', '-m', 'base'])
  await git(seed, ['remote', 'add', 'origin', remote])
  await git(seed, ['push', '-u', 'origin', 'main'])
  return { root, remote, seed, workspace }
}

/**
 * Commits one file in any of the fixture's repositories.
 *
 * The identity is passed per invocation rather than relying on the repository's own configuration:
 * only the seed clone is configured, the workspace is initialized by the host's own preparation,
 * and a machine with no global git identity — CI — would otherwise fail the commit rather than the
 * assertion the test is about.
 */
export const commitFile = async (
  repository: string,
  path: string,
  contents: string,
  message: string,
): Promise<string> => {
  await writeFile(join(repository, path), contents)
  await git(repository, ['add', path])
  await git(repository, [
    '-c',
    'user.name=Test Author',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-m',
    message,
  ])
  return git(repository, ['rev-parse', 'HEAD'])
}
