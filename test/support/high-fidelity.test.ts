import { describe, expect, it } from 'vitest'

import {
  asJsonValue,
  byteLength,
  cutToBytes,
  retainJson,
  retainText,
  truncationMarker,
} from '@sloppenheimer/core/support/high-fidelity.js'
import { makeRedactor, redactionMarker } from '@sloppenheimer/core/support/redaction.js'

/**
 * Adversarial coverage for the redaction a durable trace depends on.
 *
 * The trace's whole premise is that complete agent output can be retained safely, and the only
 * thing standing between that output and a leaked credential is this module. So the cases below are
 * written as an attacker would: the configured secret pasted into ordinary prose, credential shapes
 * with no surrounding key to give them away, and secret-named keys nested inside a payload nobody
 * would think to look at.
 *
 * The last suite is the honest limit, asserted rather than only documented: a secret with no shape
 * and no name, that the host was never told about, survives. `README.md` says so to operators, and
 * this is the test that keeps that statement true.
 */

const withSecret = makeRedactor(['glacial-marmoset-77213'])

describe('retaining free text', (): void => {
  it('preserves whitespace, which the bounded timeline collapses', (): void => {
    const retained = retainText('stdout', 'first line\n\n  indented\n', 1024)
    expect(retained.text).toBe('first line\n\n  indented\n')
    expect(retained.truncation).toBeNull()
    expect(retained.redacted).toBe(false)
  })

  it('removes a configured literal secret wherever it appears in ordinary prose', (): void => {
    const retained = retainText(
      'stdout',
      'the deploy used glacial-marmoset-77213 and then exited',
      1024,
      withSecret,
    )
    expect(retained.text).not.toContain('glacial-marmoset-77213')
    expect(retained.text).toContain(redactionMarker)
    expect(retained.redacted).toBe(true)
  })

  it.each([
    ['a GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz012345'],
    ['a fine-grained GitHub token', 'github_pat_abcdefghijklmnop_qrstuvwxyz0123456789'],
    ['an OpenAI key', 'sk-proj-abcdefghijklmnopqrstuvwxyz'],
    ['a Slack token', 'xoxb-1234567890-abcdefghij'],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM'],
  ])('removes %s by shape alone, with no key to name it', (_name, credential): void => {
    const retained = retainText('stdout', `printing ${credential} to stdout`, 1024)
    expect(retained.text).not.toContain(credential)
    expect(retained.redacted).toBe(true)
  })

  it('removes a credential from a URL and from a query string', (): void => {
    const retained = retainText(
      'stdout',
      'git fetch https://someone:hunter2@example.test/repo?access_token=abcdefghijklmnop',
      1024,
    )
    expect(retained.text).not.toContain('hunter2')
    expect(retained.text).not.toContain('abcdefghijklmnop')
  })

  it('redacts before it truncates, so a cut can never split a secret into a visible half', (): void => {
    const secret = 'glacial-marmoset-77213'
    // The limit lands inside the secret, which is exactly where a truncate-then-redact order leaks.
    const retained = retainText('stdout', `prefix ${secret} suffix`, 14, withSecret)
    expect(retained.text).not.toContain('glacial')
    expect(retained.truncation?.reason).toBe('byte_limit')
  })

  it('reports the cut rather than hiding it', (): void => {
    const retained = retainText('stdout', 'x'.repeat(100), 40)
    expect(retained.text).toHaveLength(40)
    expect(retained.truncation).toEqual({
      field: 'stdout',
      reason: 'byte_limit',
      retainedBytes: 40,
      originalBytes: 100,
    })
  })

  it('never splits a code point when it cuts on a byte boundary', (): void => {
    // Four bytes each, so a limit of 6 lands inside the second one.
    const cut = cutToBytes('😀😀', 6)
    expect(cut).toBe('😀')
    expect(byteLength(cut)).toBe(4)
  })
})

describe('retaining structured payloads', (): void => {
  it('replaces a value under a secret-named key without reading it', (): void => {
    const retained = retainJson(
      'arguments',
      { headers: { authorization: 'Bearer abcdefghijklmnop', accept: 'application/json' } },
      4096,
    )
    expect(JSON.stringify(retained.value)).toContain(redactionMarker)
    expect(JSON.stringify(retained.value)).not.toContain('abcdefghijklmnop')
    expect(JSON.stringify(retained.value)).toContain('application/json')
    expect(retained.redacted).toBe(true)
  })

  it('redacts a credential nested deep inside an ordinary field', (): void => {
    const retained = retainJson(
      'result',
      { files: [{ path: 'a.ts', body: 'const key = "ghp_abcdefghijklmnopqrstuvwxyz012345"' }] },
      4096,
    )
    expect(JSON.stringify(retained.value)).not.toContain('ghp_abcdefghijklmnop')
    expect(retained.redacted).toBe(true)
  })

  it('names the field it cut when the whole payload exceeds the ceiling', (): void => {
    const retained = retainJson('arguments', { body: 'x'.repeat(500) }, 64)
    expect(typeof retained.value).toBe('string')
    expect(retained.truncations.some((cut) => cut.field === 'arguments')).toBe(true)
  })

  it('stops at the depth floor rather than following a structure the agent chose', (): void => {
    let nested: unknown = 'leaf'
    for (let depth = 0; depth < 40; depth += 1) {
      nested = { nested }
    }
    const retained = retainJson('arguments', asJsonValue(nested), 100_000)
    expect(JSON.stringify(retained.value)).toContain(truncationMarker)
  })

  it('drops what JSON cannot carry rather than coercing it', (): void => {
    expect(asJsonValue({ when: new Date(0), how: () => undefined, count: 2 })).toEqual({
      when: {},
      how: null,
      count: 2,
    })
  })
})

describe('the limit this redaction does not clear', (): void => {
  it('retains a secret with no configured value, no key and no recognizable shape', (): void => {
    const retained = retainText('patch', '+const passphrase = "correct horse battery"', 1024)
    // Asserted, not lamented: enabling high-fidelity capture is an operator's explicit choice
    // precisely because this case exists, and `README.md` states it.
    expect(retained.text).toContain('correct horse battery')
    expect(retained.redacted).toBe(false)
  })
})
