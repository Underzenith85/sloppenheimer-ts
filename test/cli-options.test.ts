import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseCliArguments } from '../src/cli-options.js'

describe('CLI options', (): void => {
  it('supports a workflow path and ephemeral port', (): void => {
    expect(parseCliArguments(['custom.md', '--port', '0'])).toEqual({
      workflowPath: resolve('custom.md'),
      port: 0,
    })
  })

  it('supports the equals form', (): void => {
    expect(parseCliArguments(['--port=8080'])).toEqual({
      workflowPath: resolve('WORKFLOW.md'),
      port: 8080,
    })
  })

  it('accepts the package-manager option separator before the workflow path', (): void => {
    expect(parseCliArguments(['--', 'WORKFLOW.md'])).toEqual({
      workflowPath: resolve('WORKFLOW.md'),
      port: undefined,
    })
  })

  it('parses Symphony options before the option separator', (): void => {
    expect(parseCliArguments(['--port', '0', '--', 'custom.md'])).toEqual({
      workflowPath: resolve('custom.md'),
      port: 0,
    })
  })

  it('rejects unsafe ports and unknown options', (): void => {
    expect(() => parseCliArguments(['--port', '65536'])).toThrow('between 0 and 65535')
    expect(() => parseCliArguments(['--listen-all'])).toThrow('unknown option')
  })
})
