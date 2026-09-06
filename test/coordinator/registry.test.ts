import { describe, expect, it } from '@effect/vitest'
import {
  Cause,
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Redacted,
  Ref,
  Scope,
} from 'effect'
import { configurationError, decodeRegistry } from '../../packages/coordinator/src/config.js'
import { makeRegistry, type EntryLease } from '../../packages/coordinator/src/registry.js'

const entry = { id: 'one', label: 'First', base_url: 'http://localhost:4000' }
const configured = { instances: [entry] }

describe('coordinator registry', () => {
  it.scoped('reports an honest empty registry', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({ instances: [] })
      expect(yield* registry.snapshot).toEqual({
        status: 'empty_registry',
        generation: 1,
        instances: [],
      })
      expect(Option.isNone(yield* registry.lease('missing'))).toBe(true)
    }),
  )

  it.effect('rejects malformed configuration without disclosing its input', () =>
    Effect.gen(function* () {
      const secret = 'secret-that-must-not-escape'
      const invalid = [
        { instances: [{ ...entry, credential: secret }] },
        { instances: [{ ...entry, base_url: `https://user:${secret}@example.com` }] },
        { instances: [{ ...entry, base_url: 'ftp://example.com' }] },
        { instances: [{ ...entry, base_url: 'https://example.com/path' }] },
        { instances: [{ ...entry, base_url: 'https://example.com/?secret=value' }] },
        { instances: [{ ...entry, base_url: 'https://example.com/#fragment' }] },
        { instances: [{ ...entry, base_url: 'not a URL' }] },
        { instances: [{ ...entry, base_url: 'https://@example.com' }] },
        { instances: [{ ...entry, base_url: 'https://exam\tple.com' }] },
        { instances: [{ ...entry, base_url: 'https://example.com/other/..' }] },
        { instances: [{ ...entry, id: '' }] },
        { instances: [{ ...entry, label: '' }] },
        { instances: [{ ...entry, unexpected: secret }] },
        { instances: [entry, { ...entry, base_url: 'https://example.com' }] },
        { instances: [entry, { ...entry, id: 'two', base_url: 'http://LOCALHOST:4000/' }] },
      ]
      for (const input of invalid) {
        const result = yield* Effect.exit(decodeRegistry(input))
        expect(Exit.isFailure(result)).toBe(true)
        expect(JSON.stringify(result)).not.toContain(secret)
        if (Exit.isFailure(result)) {
          expect(Cause.pretty(result.cause)).not.toContain(secret)
        }
      }
    }),
  )

  it.scoped(
    'retains the last registry on failed reload and fences removed and replaced entries',
    () =>
      Effect.gen(function* () {
        const retired = yield* Ref.make(0)
        const registry = yield* makeRegistry(configured, () =>
          Effect.addFinalizer(() => Ref.update(retired, (count) => count + 1)),
        )
        const first = yield* registry.lease('one').pipe(Effect.map(Option.getOrThrow))
        yield* registry.publish(first, 'unavailable')
        const previous = yield* registry.snapshot
        expect(Exit.isFailure(yield* Effect.exit(registry.reload({ instances: [{}] })))).toBe(true)
        expect(yield* registry.snapshot).toEqual(previous)
        expect(yield* Ref.get(retired)).toBe(0)
        yield* registry.reload({ instances: [{ ...entry, label: 'Replacement' }] })
        expect(yield* Ref.get(retired)).toBe(1)
        expect(yield* registry.publish(first, 'unavailable')).toBe(false)
        expect((yield* registry.snapshot).instances[0]?.status).toBe('not_connected')
        const second = yield* registry.lease('one').pipe(Effect.map(Option.getOrThrow))
        yield* registry.reload({ instances: [] })
        yield* registry.reload(configured)
        expect(yield* registry.publish(second, 'unavailable')).toBe(false)
      }),
  )

  it.scoped(
    'resolves and rotates credentials through Config without exposing them in snapshots',
    () =>
      Effect.gen(function* () {
        const secrets = yield* Ref.make<readonly string[]>([])
        const input = { instances: [{ ...entry, credential: '$INSTANCE_TOKEN' }] }
        const registry = yield* makeRegistry(input, (value) =>
          Ref.update(secrets, (values) => [
            ...values,
            value.credential === null ? '' : Redacted.value(value.credential),
          ]),
        ).pipe(
          Effect.withConfigProvider(
            ConfigProvider.fromMap(new Map([['INSTANCE_TOKEN', 'first-secret']])),
          ),
        )
        const first = yield* registry.lease('one').pipe(Effect.map(Option.getOrThrow))
        const missing = yield* registry
          .reload(input)
          .pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map())), Effect.exit)
        expect(Exit.isFailure(missing)).toBe(true)
        expect(yield* registry.publish(first, 'unavailable')).toBe(true)
        yield* registry
          .reload(input)
          .pipe(
            Effect.withConfigProvider(
              ConfigProvider.fromMap(new Map([['INSTANCE_TOKEN', 'second-secret']])),
            ),
          )
        expect(yield* Ref.get(secrets)).toEqual(['first-secret', 'second-secret'])
        expect(yield* registry.publish(first, 'unavailable')).toBe(false)
        const serialized = JSON.stringify(yield* registry.snapshot)
        expect(serialized).not.toContain('secret')
        expect(serialized).not.toContain('credential')
        expect(serialized).not.toContain('localhost')
      }),
  )

  it.scoped('rolls back and closes staged resources if preparation fails', () =>
    Effect.gen(function* () {
      const retired = yield* Ref.make<readonly string[]>([])
      const registry = yield* makeRegistry(configured, (value) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Ref.update(retired, (values) => [...values, value.id]))
          if (value.id === 'bad') {
            return yield* configurationError('resource preparation failed')
          }
        }),
      )
      const previous = yield* registry.snapshot
      const result = yield* Effect.exit(
        registry.reload({
          instances: [
            { ...entry, id: 'staged', base_url: 'https://staged.example' },
            { ...entry, id: 'bad', base_url: 'https://bad.example' },
          ],
        }),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* registry.snapshot).toEqual(previous)
      expect(yield* Ref.get(retired)).toEqual(['bad', 'staged'])
    }),
  )

  it.scoped('keeps reads coherent and closes interrupted staging resources', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const retired = yield* Ref.make(false)
      const registry = yield* makeRegistry(configured, (value) =>
        value.id === 'slow'
          ? Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Ref.set(retired, true))
              yield* Deferred.succeed(started, undefined)
              yield* Effect.never
            })
          : Effect.void,
      )
      const previous = yield* registry.snapshot
      const pending = yield* registry
        .reload({ instances: [{ ...entry, id: 'slow' }] })
        .pipe(Effect.fork)
      yield* Deferred.await(started)
      expect(yield* registry.snapshot).toEqual(previous)
      yield* Fiber.interrupt(pending)
      expect(yield* Ref.get(retired)).toBe(true)
      expect(yield* registry.snapshot).toEqual(previous)
    }),
  )

  it.scoped('fences old callbacks before retirement has finished', () =>
    Effect.gen(function* () {
      const retirementStarted = yield* Deferred.make<void>()
      const finishRetirement = yield* Deferred.make<void>()
      const registry = yield* makeRegistry(configured, (_entry, lease) =>
        lease.generation === 1
          ? Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(retirementStarted, undefined)
                yield* Deferred.await(finishRetirement)
              }),
            )
          : Effect.void,
      )
      const oldLease = yield* registry.lease('one').pipe(Effect.map(Option.getOrThrow))
      const reload = yield* registry
        .reload({ instances: [{ ...entry, label: 'New' }] })
        .pipe(Effect.fork)
      yield* Deferred.await(retirementStarted)
      expect((yield* registry.snapshot).instances[0]?.label).toBe('New')
      expect(yield* registry.publish(oldLease, 'unavailable')).toBe(false)
      yield* Deferred.succeed(finishRetirement, undefined)
      yield* Fiber.join(reload)
    }),
  )

  it.scoped('never reuses a failed preparation lease for a later replacement', () =>
    Effect.gen(function* () {
      const staged = yield* Ref.make<Option.Option<EntryLease>>(Option.none())
      const registry = yield* makeRegistry(configured, (value, lease) =>
        value.label === 'Fail'
          ? Effect.gen(function* () {
              yield* Ref.set(staged, Option.some(lease))
              return yield* configurationError('preparation failed')
            })
          : Effect.void,
      )
      yield* registry.reload({ instances: [{ ...entry, label: 'Fail' }] }).pipe(Effect.exit)
      yield* registry.reload(configured)
      const retiredLease = yield* Ref.get(staged).pipe(Effect.map(Option.getOrThrow))
      expect(yield* registry.publish(retiredLease, 'unavailable')).toBe(false)
    }),
  )

  it.effect('closes current resources on shutdown', () =>
    Effect.gen(function* () {
      const retired = yield* Ref.make(false)
      const scope = yield* Scope.make()
      yield* makeRegistry(configured, () => Effect.addFinalizer(() => Ref.set(retired, true))).pipe(
        Effect.provideService(Scope.Scope, scope),
      )
      yield* Scope.close(scope, Exit.void)
      expect(yield* Ref.get(retired)).toBe(true)
    }),
  )
})
