/** Read only built files at startup; requests never become filesystem paths. */
import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { configurationError, type RegistryError } from './config.js'

export type Asset = Readonly<{ body: Uint8Array; contentType: string }>
const contentTypes: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  png: 'image/png',
}
export const loadAssets = (
  directory: string,
): Effect.Effect<ReadonlyMap<string, Asset>, RegistryError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const filesystem = yield* FileSystem.FileSystem
    const index = yield* filesystem.readFile(`${directory}/index.html`)
    const names = yield* filesystem.readDirectory(`${directory}/assets`)
    const assets = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const contentType = contentTypes[name.split('.').at(-1) ?? '']
        if (contentType === undefined || !/^[A-Za-z0-9_.-]+$/u.test(name)) {
          return yield* configurationError('Unsupported built UI asset')
        }
        const body = yield* filesystem.readFile(`${directory}/assets/${name}`)
        return [`/assets/${name}`, { body, contentType }] as const
      }),
    )
    return new Map<string, Asset>([
      ['/', { body: index, contentType: 'text/html; charset=utf-8' }],
      ...assets,
    ])
  }).pipe(
    Effect.mapError((cause) =>
      configurationError('Unable to load built coordinator UI; run pnpm build', cause),
    ),
  )
