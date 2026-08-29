export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name
}

export type IssueId = Brand<string, 'IssueId'>
export type IssueIdentifier = Brand<string, 'IssueIdentifier'>

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
export type JsonObject = Readonly<{ [key: string]: JsonValue }>

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
