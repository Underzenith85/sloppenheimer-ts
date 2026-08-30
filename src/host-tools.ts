import type { IssueIdentifier, JsonObject, JsonValue } from './domain/domain.js'

/** A provider-native function exposed to Codex through the App Server dynamic-tool protocol. */
export type HostToolSpec = Readonly<{
  name: string
  description: string
  inputSchema: JsonObject
}>

/** Normalized tracker identity supplied by the host, never accepted from model-authored input. */
export type HostToolContext = Readonly<{
  issueId: string
  issueIdentifier: IssueIdentifier
  nativeRef: JsonObject | null
}>

export type HostToolFailureCode =
  | 'invalid_arguments'
  | 'missing_auth'
  | 'authorization_failed'
  | 'rate_limited'
  | 'transport_error'
  | 'provider_error'
  | 'unsupported_tool'

export type HostToolResult =
  | Readonly<{ success: true; data: JsonValue }>
  | Readonly<{
      success: false
      error: Readonly<{
        code: HostToolFailureCode
        message: string
        retryable: boolean
        retryAfterMs?: number
      }>
    }>

/** Everything a running App Server session may use, captured before the child is launched. */
export type HostToolSession = Readonly<{
  specs: readonly HostToolSpec[]
  context: HostToolContext
  execute: (
    name: string,
    argumentsValue: JsonValue,
    context: HostToolContext,
  ) => HostToolResult | Promise<HostToolResult>
}>

export const unsupportedHostTool = (name: string): HostToolResult => ({
  success: false,
  error: {
    code: 'unsupported_tool',
    message: `Unsupported host tool: ${name}`,
    retryable: false,
  },
})
