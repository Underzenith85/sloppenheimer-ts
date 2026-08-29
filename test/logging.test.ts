import { Effect, Logger } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { logInfo } from '../src/logging.js'

describe('operator logging', (): void => {
  it('keeps orchestration effects alive when the configured sink throws', async (): Promise<void> => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const failingLogger = Logger.replace(
      Logger.defaultLogger,
      Logger.make(() => {
        throw new Error('sink unavailable')
      }),
    )

    await expect(
      Effect.runPromise(
        logInfo('action=test outcome=completed').pipe(Effect.provide(failingLogger)),
      ),
    ).resolves.toBeUndefined()
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('logging_sink_failed=true'))
    stderr.mockRestore()
  })
})
