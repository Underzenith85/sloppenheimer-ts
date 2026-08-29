import { resolve } from 'node:path'

export type CliOptions = Readonly<{
  workflowPath: string
  port: number | undefined
}>

const parsePort = (value: string): number => {
  if (!/^\d+$/u.test(value)) {
    throw new Error('--port must be an integer between 0 and 65535')
  }
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error('--port must be an integer between 0 and 65535')
  }
  return port
}

export const parseCliArguments = (arguments_: readonly string[]): CliOptions => {
  let workflow = 'WORKFLOW.md'
  let workflowWasSet = false
  let port: number | undefined
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--port') {
      const value = arguments_[index + 1]
      if (value === undefined) {
        throw new Error('--port requires a value')
      }
      port = parsePort(value)
      index += 1
      continue
    }
    if (argument?.startsWith('--port=') === true) {
      port = parsePort(argument.slice('--port='.length))
      continue
    }
    if (argument?.startsWith('-') === true) {
      throw new Error(`unknown option: ${argument}`)
    }
    if (argument !== undefined && !workflowWasSet) {
      workflow = argument
      workflowWasSet = true
      continue
    }
    throw new Error('only one workflow path may be provided')
  }
  return { workflowPath: resolve(workflow), port }
}
