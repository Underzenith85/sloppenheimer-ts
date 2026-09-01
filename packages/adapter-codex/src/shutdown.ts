import { Clock, Effect, Fiber } from 'effect'

import { AgentError } from '@sloppenheimer/core/domain/errors.js'
import {
  childProcessGroupIsAlive,
  signalChildGroup,
} from '@sloppenheimer/core/support/subprocess.js'
import { beginClose } from './connection-state.js'
import {
  emitEvent,
  failSession,
  type SessionReaders,
  type SessionRuntime,
} from './session-runtime.js'

/** How a session ends: the readers, the child, and everything its process group started. */

const shutdownGraceMs = 5_000
/** After `SIGKILL`, how long to wait for the group to vanish, and how often to look. */
const groupReapDeadlineMs = 2_000
const groupReapPollMs = 25
/** How long a stopping session waits for the diagnostic reader to drain and flush. */
const diagnosticDrainDeadlineMs = 1_000

export const stopSession = (
  session: SessionRuntime,
  readers: SessionReaders,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const shouldStop = yield* beginClose(session.state)
    if (!shouldStop) {
      return
    }
    yield* emitEvent(session, 'session_stopped', null).pipe(
      Effect.zipRight(
        failSession(
          session,
          new AgentError({ category: 'process_exited', message: 'Codex session was closed' }),
          false,
        ),
      ),
    )
    yield* Fiber.interrupt(readers.stdout)
    session.process.stdin.end()
    signalChildGroup(session.process, 'SIGTERM')
    yield* reapGroup(session)
    yield* drainDiagnostics(session, readers.stderr)
  })

/**
 * Lets the diagnostic reader finish. The child's death closes stderr, which ends the stream and
 * flushes the record it was still assembling — an unterminated final line, or a PEM block whose
 * end marker never arrived — so the last thing a failing session said is reported before the
 * session is torn down.
 *
 * Bounded, because a descendant that inherited the pipe and outlived the reap would otherwise
 * hold the session open indefinitely. A diagnostic lost to that bound is diagnostic only.
 */
export const drainDiagnostics = (
  session: SessionRuntime,
  stderr: Fiber.RuntimeFiber<void>,
): Effect.Effect<void> =>
  Fiber.await(stderr).pipe(
    Effect.timeout(diagnosticDrainDeadlineMs),
    Effect.catchAll(() => Fiber.interrupt(stderr)),
    Effect.asVoid,
    Effect.ensuring(
      Effect.sync(() => {
        // The reader leaves the pipe open for a child that is still writing; with the session
        // over there is no such child, and the handle is released rather than held to the end
        // of the host.
        session.process.stderr.destroy()
      }),
    ),
  )

/**
 * Waits for the App Server's process group to empty, escalating to `SIGKILL` once the grace has
 * passed. Polling rather than waiting on the leader's `exit`: the group emptying is not an event
 * Node reports, so a tree whose last member leaves a moment after the leader would otherwise sit
 * out the whole grace before anyone noticed, delaying workspace cleanup for ordinary sessions.
 *
 * Both phases are bounded, and the poll timers are referenced on purpose — an awaited promise
 * does not hold the event loop open, so an unreferenced wait would let the host exit before the
 * escalation ever fired and leave behind the descendant this exists to kill.
 */
export const reapGroup = (session: SessionRuntime): Effect.Effect<void> =>
  Effect.gen(function* () {
    const escalateAt = (yield* Clock.currentTimeMillis) + shutdownGraceMs
    while (childProcessGroupIsAlive(session.process)) {
      if ((yield* Clock.currentTimeMillis) >= escalateAt) {
        signalChildGroup(session.process, 'SIGKILL')
        break
      }
      yield* Effect.sleep(groupReapPollMs)
    }
    // Signal delivery is asynchronous, so returning as soon as SIGKILL was sent would let the
    // finalizer complete — and terminal reconciliation start removing the workspace — while a
    // descendant is still running in it.
    const deadline = (yield* Clock.currentTimeMillis) + groupReapDeadlineMs
    while (
      childProcessGroupIsAlive(session.process) &&
      (yield* Clock.currentTimeMillis) < deadline
    ) {
      yield* Effect.sleep(groupReapPollMs)
    }
  })
