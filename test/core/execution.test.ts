import { it } from '@effect/vitest'
import { Deferred, Effect, Exit, FiberMap, Ref, Scope } from 'effect'
import { describe, expect } from 'vitest'

import { issueId, type IssueId } from '@sloppenheimer/core/domain/domain.js'
import {
  makeExecutionOwner,
  ownIssueFiber,
  ownPollTimer,
  releaseIssueFiber,
  releaseIssueFiberFork,
  type ExecutionOwner,
} from '@sloppenheimer/core/core/runtime/execution.js'

/**
 * Execution ownership on its own: no orchestrator, no mailbox, no ports.
 *
 * Every case here is a race the runtime used to resolve by hand — a replacement that had to
 * remember to interrupt what it displaced, a fiber that had to be taken back out of the state when
 * it ended, a shutdown that had to reach every fiber some transition was holding. What the
 * collection owes them is stated directly, because it is the whole reason the fibers left the
 * state records.
 */

const issue: IssueId = issueId('1')
const other: IssueId = issueId('2')

/** What a fiber body did, in the order it did it: the only thing these tests read. */
type Trace = Ref.Ref<readonly string[]>

type Body = Readonly<{
  /** Runs until interrupted, and never of its own accord. */
  effect: Effect.Effect<void>
  /** Resolves once the body is running, so a replacement cannot race its start. */
  started: Deferred.Deferred<void>
  /** Resolves once the body's finalizer has run, so an assertion never races the interruption. */
  finished: Deferred.Deferred<void>
}>

const bodyOf = (trace: Trace, name: string): Effect.Effect<Body> =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const finished = yield* Deferred.make<void>()
    return {
      started,
      finished,
      effect: Deferred.succeed(started, undefined).pipe(
        Effect.zipRight(Effect.never),
        Effect.onInterrupt(() =>
          Ref.update(trace, (seen) => [...seen, name]).pipe(
            Effect.zipRight(Deferred.succeed(finished, undefined)),
            Effect.asVoid,
          ),
        ),
        Effect.asVoid,
      ),
    }
  })

/** A body that ends on its own the moment it is let go, rather than waiting to be interrupted. */
const settling = (trace: Trace, name: string): Effect.Effect<Body> =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const finished = yield* Deferred.make<void>()
    return {
      started,
      finished,
      effect: Deferred.succeed(started, undefined).pipe(
        Effect.zipRight(Deferred.await(finished)),
        Effect.zipRight(Ref.update(trace, (seen) => [...seen, name])),
      ),
    }
  })

const arm = (owner: ExecutionOwner, name: string, trace: Trace): Effect.Effect<Body> =>
  Effect.gen(function* () {
    const body = yield* bodyOf(trace, name)
    yield* ownIssueFiber(owner, 'worker', issue, body.effect)
    yield* Deferred.await(body.started)
    return body
  })

describe('replacing an owned fiber', (): void => {
  it.effect('interrupts what the key held, and leaves the replacement running', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const trace = yield* Ref.make<readonly string[]>([])
        const owner = yield* makeExecutionOwner()
        const first = yield* arm(owner, 'first', trace)

        const second = yield* arm(owner, 'second', trace)
        yield* Deferred.await(first.finished)

        expect(yield* Ref.get(trace)).toEqual(['first'])
        expect(yield* Deferred.isDone(second.finished)).toBe(false)
        expect(yield* FiberMap.size(owner)).toBe(1)
      }),
    ),
  )

  it.effect('interrupts the replacement, and only it, when the key is released', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const trace = yield* Ref.make<readonly string[]>([])
        const owner = yield* makeExecutionOwner()
        const first = yield* arm(owner, 'first', trace)
        const second = yield* arm(owner, 'second', trace)
        yield* Deferred.await(first.finished)

        yield* releaseIssueFiber(owner, 'worker', issue)

        expect(yield* Deferred.isDone(second.finished)).toBe(true)
        expect(yield* Ref.get(trace)).toEqual(['first', 'second'])
        expect(yield* FiberMap.size(owner)).toBe(0)
      }),
    ),
  )

  it.effect('keys by purpose and by issue, so neither displaces the other', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const trace = yield* Ref.make<readonly string[]>([])
        const owner = yield* makeExecutionOwner()
        const worker = yield* bodyOf(trace, 'worker')
        const retry = yield* bodyOf(trace, 'retry')
        const elsewhere = yield* bodyOf(trace, 'elsewhere')
        const poll = yield* bodyOf(trace, 'poll')
        yield* ownIssueFiber(owner, 'worker', issue, worker.effect)
        yield* ownIssueFiber(owner, 'retry', issue, retry.effect)
        yield* ownIssueFiber(owner, 'worker', other, elsewhere.effect)
        yield* ownPollTimer(owner, poll.effect)
        yield* Effect.all(
          [worker, retry, elsewhere, poll].map((body) => body.started).map(Deferred.await),
        )

        yield* releaseIssueFiber(owner, 'worker', issue)

        expect(yield* Ref.get(trace)).toEqual(['worker'])
        expect(yield* FiberMap.size(owner)).toBe(3)
      }),
    ),
  )
})

describe('a fiber that ends on its own', (): void => {
  it.effect('leaves execution ownership without anything having to remove it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const trace = yield* Ref.make<readonly string[]>([])
        const owner = yield* makeExecutionOwner()
        const body = yield* settling(trace, 'settled')
        yield* ownIssueFiber(owner, 'delivery', issue, body.effect)
        yield* Deferred.await(body.started)
        expect(yield* FiberMap.size(owner)).toBe(1)

        yield* Deferred.succeed(body.finished, undefined)
        yield* Effect.yieldNow()

        expect(yield* Ref.get(trace)).toEqual(['settled'])
        expect(yield* FiberMap.size(owner)).toBe(0)
      }),
    ),
  )

  it.effect('is nothing left to release: a spent key interrupts nobody', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const trace = yield* Ref.make<readonly string[]>([])
        const owner = yield* makeExecutionOwner()
        const body = yield* settling(trace, 'settled')
        yield* ownIssueFiber(owner, 'delivery', issue, body.effect)
        yield* Deferred.await(body.started)
        yield* Deferred.succeed(body.finished, undefined)
        yield* Effect.yieldNow()

        yield* releaseIssueFiber(owner, 'delivery', issue)

        expect(yield* Ref.get(trace)).toEqual(['settled'])
      }),
    ),
  )
})

describe('cancelling concurrently', (): void => {
  it.effect('settles every caller and runs the fiber finalizer once', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const trace = yield* Ref.make<readonly string[]>([])
        const owner = yield* makeExecutionOwner()
        yield* arm(owner, 'worker', trace)

        yield* Effect.all(
          [
            releaseIssueFiber(owner, 'worker', issue),
            releaseIssueFiber(owner, 'worker', issue),
            releaseIssueFiber(owner, 'worker', issue),
          ],
          { concurrency: 'unbounded' },
        )

        expect(yield* Ref.get(trace)).toEqual(['worker'])
        expect(yield* FiberMap.size(owner)).toBe(0)
      }),
    ),
  )

  it.effect('waits for the interruption it asked for before answering', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const trace = yield* Ref.make<readonly string[]>([])
        const owner = yield* makeExecutionOwner()
        const body = yield* arm(owner, 'worker', trace)

        yield* releaseIssueFiber(owner, 'worker', issue)

        // The awaiting release is what lets `cancelRunning` dispose of the workspace the worker
        // was holding: by the time it answers, the worker's own finalizers have run.
        expect(yield* Deferred.isDone(body.finished)).toBe(true)
      }),
    ),
  )

  it.effect('signals rather than waits when the caller must not block on a publication', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const trace = yield* Ref.make<readonly string[]>([])
        const owner = yield* makeExecutionOwner()
        const started = yield* Deferred.make<void>()
        const stuck = yield* Deferred.make<void>()
        const finished = yield* Deferred.make<void>()
        yield* ownIssueFiber(
          owner,
          'delivery',
          issue,
          Deferred.succeed(started, undefined).pipe(
            Effect.zipRight(Effect.never),
            // A publication interrupted mid-push finishes on the child process, not on the caller.
            Effect.onInterrupt(() =>
              Deferred.await(stuck).pipe(
                Effect.zipRight(Ref.update(trace, (seen) => [...seen, 'delivery'])),
                Effect.zipRight(Deferred.succeed(finished, undefined)),
                Effect.asVoid,
              ),
            ),
            Effect.asVoid,
          ),
        )
        yield* Deferred.await(started)

        yield* releaseIssueFiberFork(owner, 'delivery', issue)

        expect(yield* Ref.get(trace)).toEqual([])
        yield* Deferred.succeed(stuck, undefined)
        yield* Deferred.await(finished)
        expect(yield* Ref.get(trace)).toEqual(['delivery'])
      }),
    ),
  )

  it.effect('is a no-op on a key nothing owns', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* makeExecutionOwner()

        yield* releaseIssueFiber(owner, 'retry', issue)
        yield* releaseIssueFiberFork(owner, 'retry', issue)

        expect(yield* FiberMap.size(owner)).toBe(0)
      }),
    ),
  )
})

describe('shutting the owner down', (): void => {
  it.effect('interrupts every owned fiber and waits for their finalizers', () =>
    Effect.gen(function* () {
      const trace = yield* Ref.make<readonly string[]>([])
      const scope = yield* Scope.make()
      const owner = yield* Scope.extend(makeExecutionOwner(), scope)
      const worker = yield* bodyOf(trace, 'worker')
      const retry = yield* bodyOf(trace, 'retry')
      const poll = yield* bodyOf(trace, 'poll')
      yield* ownIssueFiber(owner, 'worker', issue, worker.effect)
      yield* ownIssueFiber(owner, 'retry', other, retry.effect)
      yield* ownPollTimer(owner, poll.effect)
      yield* Effect.all([worker, retry, poll].map((body) => body.started).map(Deferred.await))

      yield* Scope.close(scope, Exit.void)

      // Not "the interruptions were sent": the close answers only once every finalizer has run,
      // which is what a bounded agent teardown on shutdown depends on.
      expect([...(yield* Ref.get(trace))].sort()).toEqual(['poll', 'retry', 'worker'])
      expect(yield* FiberMap.size(owner)).toBe(0)
    }),
  )

  it.effect('refuses to arm anything afterwards, so nothing outlives the orchestrator', () =>
    Effect.gen(function* () {
      const trace = yield* Ref.make<readonly string[]>([])
      const scope = yield* Scope.make()
      const owner = yield* Scope.extend(makeExecutionOwner(), scope)
      yield* Scope.close(scope, Exit.void)
      const body = yield* bodyOf(trace, 'late')

      // A closed owner interrupts whoever tries to arm under it rather than forking work nothing
      // would ever be able to reach: after shutdown there is no owner left to hold a fiber.
      const armed = yield* Effect.exit(ownIssueFiber(owner, 'worker', issue, body.effect))

      expect(Exit.isInterrupted(armed)).toBe(true)
      expect(yield* Deferred.isDone(body.started)).toBe(false)
      expect(yield* FiberMap.size(owner)).toBe(0)
    }),
  )
})
