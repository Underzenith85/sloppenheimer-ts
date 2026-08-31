import type { JsonObject } from '../support/json.js'

export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name
}

export type IssueId = Brand<string, 'IssueId'>
export type IssueIdentifier = Brand<string, 'IssueIdentifier'>

/**
 * The JSON structural vocabulary lives in `support/`, the bottom layer, so that the JSON
 * predicates in `support/json.ts` do not have to reach up into `domain/`.  It is re-exported here
 * because domain types describe tracker payloads in terms of it.
 */
export type { JsonObject, JsonPrimitive, JsonValue } from '../support/json.js'

export type BlockerRef = Readonly<{
  id: string
  identifier: IssueIdentifier
  title: string
  state: string
  url: string
}>

export type Issue = Readonly<{
  id: IssueId
  nativeRef: JsonObject | null
  identifier: IssueIdentifier
  title: string
  description: string | null
  priority: number | null
  state: string
  branchName: string | null
  url: string | null
  assigneeId: string | null
  labels: readonly string[]
  blockedBy: readonly BlockerRef[]
  dispatchable: boolean
  createdAt: Date | null
  updatedAt: Date | null
}>

export type Workspace = Readonly<{
  path: string
  key: string
  createdNow: boolean
}>

export type TokenTotals = Readonly<{
  inputTokens: number
  outputTokens: number
  totalTokens: number
  secondsRunning: number
}>

export const issueId = (value: string): IssueId => value as IssueId
export const issueIdentifier = (value: string): IssueIdentifier => value as IssueIdentifier
export const normalizeState = (value: string): string => value.trim().toLowerCase()
