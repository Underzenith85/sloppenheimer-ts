import { Clock, Effect } from 'effect'

import type { SourceControlError } from '@sloppenheimer/core/domain/errors.js'
import type {
  Candidate,
  VerificationConfig,
  VerifiedCandidate,
} from '@sloppenheimer/core/ports/candidate.js'
import { runCommand } from './command.js'
import { assertCandidate, candidateFailure } from './git-candidate-state.js'
import type { GitSourceControlSettings } from './git-process.js'

/** The gate receives repository files, without the tracker or Git credential environment. */
const verificationEnvironment = (secretEnvironmentNames: readonly string[]): NodeJS.ProcessEnv => {
  const denied = new Set(
    [
      ...secretEnvironmentNames,
      'GIT_ASKPASS',
      'SSH_ASKPASS',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'SLOPPENHEIMER_GIT_USERNAME',
      'SLOPPENHEIMER_GIT_PASSWORD',
    ].map((name) => name.toUpperCase()),
  )
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !denied.has(name.toUpperCase())),
  )
}

/** A passing command certifies only the unchanged commit and content it actually checked. */
export const verifyCandidate = (
  settings: GitSourceControlSettings,
  candidate: Candidate,
  configuration: VerificationConfig,
  secretEnvironmentNames: readonly string[],
): Effect.Effect<VerifiedCandidate, SourceControlError> =>
  Effect.gen(function* () {
    yield* assertCandidate(settings, candidate)
    const result = yield* runCommand({
      command: 'bash',
      args: ['-lc', configuration.command],
      cwd: candidate.prepared.workspace.path,
      environment: verificationEnvironment(secretEnvironmentNames),
      timeoutMs: configuration.timeoutMs,
      captureLimit: 64 * 1024,
    }).pipe(
      Effect.mapError((cause) =>
        candidateFailure('verification_failed', 'host verification could not complete', cause),
      ),
    )
    if (result.code !== 0 || result.outputInterrupted) {
      // Raw output may contain credentials from repository tooling. Keep it out of errors.
      return yield* Effect.fail(
        candidateFailure(
          'verification_failed',
          `host verification failed (exit ${String(result.code)}); candidate retained`,
        ),
      )
    }
    yield* assertCandidate(settings, candidate)
    return {
      candidate,
      evidence: {
        headSha: candidate.headSha,
        treeSha: candidate.treeSha,
        command: configuration.command,
        verifiedAt: yield* Clock.currentTimeMillis,
      },
    }
  })
