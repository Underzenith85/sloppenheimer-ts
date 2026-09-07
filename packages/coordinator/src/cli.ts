#!/usr/bin/env node
/** Second process boundary: NodeRuntime owns signal interruption and scoped shutdown. */
import { FileSystem } from '@effect/platform'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { fileURLToPath } from 'node:url'
import { ConfigProvider, Effect, Queue } from 'effect'
import { logError, logInfo } from '@sloppenheimer/core/support/logging.js'
import { loadAssets } from './assets.js'
import { configurationError, type RegistryError } from './config.js'
import { makeRegistry, Registry } from './registry.js'
import { startCoordinatorServer } from './server.js'

type Options = Readonly<{ registryPath: string | null; port: number; help: boolean }>
const help = `Usage: sloppenheimer-coordinator [--registry FILE] [--port PORT]

Serve the coordinator UI and GET /api/v1/registry on 127.0.0.1 (default port 4320).
Without --registry, start with an empty registry. FILE is JSON:
{"instances":[{"id":"example","label":"Example","base_url":"http://127.0.0.1:4000","credential":"$INSTANCE_TOKEN"}]}
Credentials must be environment references. SIGHUP atomically reloads FILE and credentials;
an invalid reload retains the previous registry. SIGINT/SIGTERM close all resources.
Only loopback binding is supported. Use a local tunnel; no remote login is provided.
`

const options = (argumentsValue: readonly string[]): Effect.Effect<Options, RegistryError> =>
  Effect.gen(function* () {
    let registryPath: string | null = null
    let port = 4320
    const seen = new Set<string>()
    for (let index = 0; index < argumentsValue.length; index += 1) {
      const argument = argumentsValue[index]
      if (argument === '--help' || argument === '-h') {
        return { registryPath, port, help: true }
      }
      if ((argument !== '--registry' && argument !== '--port') || seen.has(argument)) {
        return yield* configurationError('Unknown or duplicate coordinator option; use --help')
      }
      seen.add(argument)
      const value = argumentsValue[index + 1]
      if (value === undefined || value.startsWith('--')) {
        return yield* configurationError('Coordinator option requires a value')
      }
      index += 1
      if (argument === '--registry') {
        registryPath = value
      } else {
        if (!/^\d+$/u.test(value) || Number(value) > 65_535) {
          return yield* configurationError('Port must be an integer from 0 to 65535')
        }
        port = Number(value)
      }
    }
    return { registryPath, port, help: false }
  })

const readRegistry = (
  path: string | null,
): Effect.Effect<unknown, RegistryError, FileSystem.FileSystem> =>
  path === null
    ? Effect.succeed({ instances: [] })
    : Effect.gen(function* () {
        const filesystem = yield* FileSystem.FileSystem
        const text = yield* filesystem
          .readFileString(path)
          .pipe(
            Effect.mapError((cause) => configurationError('Unable to read registry file', cause)),
          )
        return yield* Effect.try({
          try: (): unknown => JSON.parse(text),
          catch: (cause) => configurationError('Registry file must contain valid JSON', cause),
        })
      })

const program = Effect.scoped(
  Effect.gen(function* () {
    const parsed = yield* options(process.argv.slice(2))
    if (parsed.help) {
      yield* Effect.sync(() => {
        process.stdout.write(help)
      })
      return
    }
    const registry = yield* makeRegistry(yield* readRegistry(parsed.registryPath))
    const assets = yield* loadAssets(fileURLToPath(new URL('./ui', import.meta.url)))
    const server = yield* startCoordinatorServer(parsed.port, assets).pipe(
      Effect.provideService(Registry, registry),
    )
    const reloads = yield* Queue.sliding<void>(1)
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (): void => {
          Queue.unsafeOffer(reloads, undefined)
        }
        process.on('SIGHUP', listener)
        return listener
      }),
      (listener) =>
        Effect.sync(() => {
          process.removeListener('SIGHUP', listener)
        }),
    )
    yield* logInfo('coordinator listening', { url: server.url })
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(reloads)
        yield* readRegistry(parsed.registryPath).pipe(
          Effect.flatMap(registry.reload),
          Effect.matchEffect({
            onFailure: (error) =>
              logError('coordinator reload rejected', { message: error.message }),
            onSuccess: () => logInfo('coordinator registry reloaded', {}),
          }),
        )
      }),
    )
  }),
).pipe(
  Effect.catchAll((error) =>
    Effect.gen(function* () {
      yield* logError('coordinator startup failed', { message: error.message })
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
    }),
  ),
  Effect.provide(NodeContext.layer),
  Effect.withConfigProvider(ConfigProvider.fromEnv()),
)
NodeRuntime.runMain(program)
