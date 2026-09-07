/** Run after pnpm build. This exercises the packaged executable from an unrelated working directory. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { Schema } from 'effect'
import { setTimeout } from 'node:timers/promises'

const executable = resolve('packages/coordinator/dist/cli.js')
const snapshotSchema = Schema.Struct({
  status: Schema.String,
  generation: Schema.Number,
  instances: Schema.Array(
    Schema.Struct({ id: Schema.String, label: Schema.String, status: Schema.String }),
  ),
})
const secret = 'coordinator-smoke-private-credential'

const launch = (
  cwd: string,
  argumentsValue: readonly string[],
): Readonly<{
  child: ChildProcess
  closed: Promise<unknown[]>
  output: () => string
}> => {
  const child = spawn(process.execPath, [executable, ...argumentsValue], {
    cwd,
    env: { ...process.env, INSTANCE_TOKEN: secret },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    output += String(chunk)
  })
  return { child, closed: once(child, 'close'), output: (): string => output }
}
const until = async <T>(predicate: () => T | Promise<T>): Promise<NonNullable<T>> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await predicate()
    if (value) {
      return value
    }
    await setTimeout(25)
  }
  throw new Error('Timed out waiting for coordinator')
}

await test(
  'built executable help, invalid startup, packaged UI, reload and shutdown',
  { timeout: 20_000 },
  async (): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'coordinator-smoke-'))
    const children: ChildProcess[] = []
    try {
      const help = launch(directory, ['--help'])
      children.push(help.child)
      assert.equal((await help.closed)[0], 0)
      assert.match(help.output(), /SIGHUP/u)
      const path = join(directory, 'registry.json')
      await writeFile(path, JSON.stringify({ instances: [{ credential: secret }] }))
      const invalid = launch(directory, ['--registry', path])
      children.push(invalid.child)
      assert.equal((await invalid.closed)[0], 1)
      assert.match(invalid.output(), /Invalid registry/u)
      assert.ok(!invalid.output().includes(secret))
      await writeFile(path, '{"instances":[]}')
      const running = launch(directory, ['--registry', path, '--port', '0'])
      children.push(running.child)
      const url = await until(() => /http:\/\/127\.0\.0\.1:\d+/u.exec(running.output())?.[0])
      const snapshot = async (): Promise<typeof snapshotSchema.Type> => {
        const value: unknown = await (await fetch(`${url}/api/v1/registry`)).json()
        return Schema.decodeUnknownSync(snapshotSchema)(value)
      }
      assert.equal((await snapshot()).status, 'empty_registry')
      const page = await (await fetch(url)).text()
      assert.match(page, /<div id="root">/u)
      const assets = [...page.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/gu)]
      assert.ok(assets.length >= 2)
      for (const [, asset] of assets) {
        const response = await fetch(`${url}${asset}`)
        assert.equal(response.status, 200)
        assert.ok(!(await response.text()).includes(secret))
      }
      const entry = {
        id: 'one',
        label: 'First',
        base_url: 'http://localhost:4000',
        credential: '$INSTANCE_TOKEN',
      }
      await writeFile(path, JSON.stringify({ instances: [entry] }))
      running.child.kill('SIGHUP')
      await until(async () => (await snapshot()).generation === 2)
      assert.deepEqual((await snapshot()).instances, [
        { id: 'one', label: 'First', status: 'not_connected' },
      ])
      await writeFile(path, '{invalid-json')
      running.child.kill('SIGHUP')
      await until(() => running.output().includes('reload rejected'))
      assert.equal((await snapshot()).generation, 2)
      await writeFile(path, '{"instances":[]}')
      running.child.kill('SIGHUP')
      await until(async () => (await snapshot()).generation === 3)
      assert.equal((await snapshot()).status, 'empty_registry')
      running.child.kill('SIGTERM')
      assert.equal((await running.closed)[0], 0)
      assert.ok(!running.output().includes(secret))
      await assert.rejects(fetch(url))
      const built = resolve('packages/coordinator/dist/ui')
      for (const name of await readdir(built, { recursive: true, withFileTypes: true })) {
        if (name.isFile()) {
          assert.ok(!(await readFile(join(name.parentPath, name.name), 'utf8')).includes(secret))
        }
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  },
)
