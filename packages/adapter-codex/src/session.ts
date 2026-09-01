import { Config, Effect, Redacted } from 'effect'

import type { AgentTurnOutcome } from '@sloppenheimer/core/ports/agent-runner.js'
import type { JsonObject } from '@sloppenheimer/core/domain/domain.js'
import { redact, redactionMarker } from '@sloppenheimer/core/support/redaction.js'
import { messageTextFrom } from './protocol.js'
import { codexAuthenticationEnvironmentNames } from './settings.js'

/**
 * What a Codex session is, apart from the connection that runs it: the environment the subprocess
 * inherits, the values its telemetry must never echo, the identity a turn reports under, and the
 * reading of a terminal turn status.
 */

export const makeCodexEnvironment = (
  environment: NodeJS.ProcessEnv,
  secretEnvironmentNames: readonly string[],
): NodeJS.ProcessEnv => {
  const preserved = new Set<string>(codexAuthenticationEnvironmentNames)
  const blockedEnvironmentNames = new Set(
    secretEnvironmentNames.filter((name) => !preserved.has(name)),
  )
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !blockedEnvironmentNames.has(name)),
  )
}

/** The App Server framing limit for one protocol line. */
export const codexMaxLineBytes = 10 * 1024 * 1024
/**
 * SPEC 4.1.6 and 4.2 compose a session identity from the coding-agent thread and turn as
 * `<thread_id>-<turn_id>`, so each turn on a thread is its own session while the thread id stays
 * the one the App Server issued. Continuation turns therefore reuse `thread_id` and produce a new
 * `session_id`, which is what 10.2 asks for.
 *
 * Before the first turn exists there is no turn half to compose. A trailing separator would name a
 * turn that never ran, so the thread id stands alone until a turn identity arrives — the only
 * event that sees this is `session_started`, emitted between `thread/start` and the first
 * `turn/start`.
 */
export const composeSessionId = (threadId: string, turnId: string | null): string =>
  turnId === null ? threadId : `${threadId}-${turnId}`

/**
 * Codex's own reading of its terminal turn statuses. It travels onto the event as
 * {@link AgentLifecycle}, so the runtime never matches a status string itself.
 */
export const codexTurnOutcome = (status: string): AgentTurnOutcome =>
  status === 'completed' ? 'completed' : isCancelledTurnStatus(status) ? 'cancelled' : 'failed'

export const isCancelledTurnStatus = (status: string): boolean =>
  status === 'cancelled' || status === 'canceled' || status === 'interrupted'

/**
 * The environment values a session's telemetry must never echo. The tracker's own secret names come
 * from the workflow; Codex's authentication sources are added because they are present in the
 * subprocess environment by design and could be printed by any tool the agent runs.
 *
 * Each name is read through the calling fiber's `ConfigProvider` — the host environment, not the
 * environment the subprocess is given. That distinction is deliberate: the tracker's own secret is
 * stripped from what Codex inherits, and a value the agent never receives is exactly the one most
 * worth removing if some tool prints it back. A name that is not set is simply absent, because a
 * missing credential is not an error here.
 */
export const sessionSecretValues = (
  secretEnvironmentNames: readonly string[],
): Effect.Effect<readonly string[]> => {
  const names = new Set([
    ...secretEnvironmentNames,
    ...codexAuthenticationEnvironmentNames,
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ])
  return Effect.forEach([...names], (name) => Config.option(Config.redacted(name))).pipe(
    Effect.map((values) =>
      values
        .flatMap((value) => (value._tag === 'Some' ? [Redacted.value(value.value)] : []))
        .filter((value) => value.length > 0),
    ),
    Effect.orDie,
  )
}

export const boundedMessage = (
  value: string,
  knownSecretValues: readonly string[] = [],
): string => {
  const knownSecretsRedacted = [...knownSecretValues]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((message, secret) => message.replaceAll(secret, redactionMarker), value)
  // `redact` composes the host's structural redactor with the shape-based patterns, so a bare
  // provider token in an agent message is removed as surely as an `Authorization:` header is.
  const redacted = redact(knownSecretsRedacted)
  return redacted.length <= 512 ? redacted : `${redacted.slice(0, 509)}...`
}

/** Redacted and bounded at ingest, before the event that carries it is ever retained. */
export const messageFrom = (
  message: JsonObject,
  knownSecretValues: readonly string[],
): string | null => {
  const text = messageTextFrom(message)
  return text === null ? null : boundedMessage(text, knownSecretValues)
}
