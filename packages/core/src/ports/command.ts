import { Context, type Effect } from 'effect'

import type { SubprocessError } from '../domain/errors.js'

/** A bounded host command. Its output is evidence, never an agent completion signal. */
export type CommandRequest = Readonly<{
  command: string
  args: readonly string[]
  cwd: string
  environment?: Readonly<NodeJS.ProcessEnv>
  timeoutMs: number
  captureLimit: number
  terminationGraceMs?: number
}>

export type CommandResult = Readonly<{
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
  outputInterrupted: boolean
}>

export type CommandExecutorPort = Readonly<{
  run: (request: CommandRequest) => Effect.Effect<CommandResult, SubprocessError>
}>

export class CommandExecutor extends Context.Tag('sloppenheimer/CommandExecutor')<
  CommandExecutor,
  CommandExecutorPort
>() {}
