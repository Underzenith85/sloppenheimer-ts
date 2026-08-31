import { describe, expect, it } from 'vitest'

import {
  hostToolCallFrom,
  messageTextFrom,
  notificationIdentity,
  protocolErrorMessage,
  responseIdentity,
  telemetryFrom,
  turnFrom,
} from '../../../src/adapters/codex/protocol.js'

describe('Codex protocol decoding', (): void => {
  it('reports no usage at all rather than a partial reading', (): void => {
    // Three fields make a total; two make a number that would understate it.
    expect(
      telemetryFrom('turn/usage', { params: { usage: { inputTokens: 8, outputTokens: 2 } } }).usage,
    ).toBeNull()
    expect(
      telemetryFrom('turn/usage', {
        params: { usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } },
      }).usage,
    ).toEqual({ inputTokens: 8, outputTokens: 2, totalTokens: 10 })
  })

  it('reads a token count whether or not it is wrapped in msg', (): void => {
    const wrapped = telemetryFrom('codex/event/token_count', {
      params: {
        msg: { info: { total_token_usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } },
      },
    })
    const flat = telemetryFrom('codex/event/token_count', {
      params: { info: { totalTokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } },
    })

    expect(wrapped.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 })
    expect(flat.usage).toEqual(wrapped.usage)
  })

  it('degrades a notification it cannot read to no telemetry', (): void => {
    expect(telemetryFrom('turn/usage', { params: 'unexpected' })).toEqual({
      usage: null,
      rateLimits: null,
    })
    expect(telemetryFrom('account/rateLimits/updated', { params: { rateLimits: [] } })).toEqual({
      usage: null,
      rateLimits: null,
    })
  })

  it('finds the free text a notification carries, wherever it puts it', (): void => {
    expect(messageTextFrom({ params: { message: 'direct' } })).toBe('direct')
    expect(messageTextFrom({ params: { error: { message: 'failed' } } })).toBe('failed')
    expect(messageTextFrom({ params: { item: { type: 'agentMessage', text: 'said' } } })).toBe(
      'said',
    )
    // Only an agent message is the agent talking; a reasoning item is not.
    expect(messageTextFrom({ params: { item: { type: 'reasoning', text: 'thought' } } })).toBeNull()
    expect(messageTextFrom({ params: { message: 42 } })).toBeNull()
    expect(messageTextFrom({ method: 'turn/started' })).toBeNull()
  })

  it('reads identity a message declares for itself', (): void => {
    expect(notificationIdentity({ params: { threadId: 'thread-1', turnId: 'turn-2' } })).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-2',
    })
    expect(notificationIdentity({ params: { threadId: 7 } })).toEqual({
      threadId: null,
      turnId: null,
    })
    expect(notificationIdentity({})).toEqual({ threadId: null, turnId: null })
  })

  it('reads the turn a lifecycle notification reports on', (): void => {
    expect(turnFrom({ params: { turn: { id: 'turn-1', status: 'completed' } } })).toEqual({
      id: 'turn-1',
      status: 'completed',
    })
    // A turn that omits its status is still a turn; the caller decides what an absent status means.
    expect(turnFrom({ params: { turn: { id: 'turn-1' } } })).toEqual({
      id: 'turn-1',
      status: null,
    })
    expect(turnFrom({ params: { turn: { status: 'completed' } } })).toBeNull()
    expect(turnFrom({ params: { turn: 'turn-1' } })).toBeNull()
  })

  it('reads identity a response result declares', (): void => {
    expect(responseIdentity({ thread: { id: 'thread-1' }, turn: { id: 'turn-1' } })).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-1',
    })
    // Nothing declared means nothing to adopt, so the connection keeps what it already has.
    expect(responseIdentity('accepted')).toEqual({ threadId: null, turnId: null })
    expect(responseIdentity({ thread: { id: 'thread-1' } })).toEqual({
      threadId: 'thread-1',
      turnId: null,
    })
  })

  it('reports a host tool request against its tool even when the request is unusable', (): void => {
    expect(hostToolCallFrom({ params: { tool: 'symphony_status', arguments: { a: 1 } } })).toEqual({
      tool: 'symphony_status',
      arguments: { a: 1 },
    })
    expect(hostToolCallFrom({ params: { tool: 'symphony_status' } })).toEqual({
      tool: 'symphony_status',
      arguments: undefined,
    })
    expect(hostToolCallFrom({ params: {} })).toEqual({ tool: null, arguments: undefined })
  })

  it('names an error the server did not describe', (): void => {
    expect(protocolErrorMessage({ code: -32_601, message: 'no such method' })).toBe(
      'no such method',
    )
    expect(protocolErrorMessage({ code: -32_601 })).toBe('unknown protocol error')
    expect(protocolErrorMessage(null)).toBe('unknown protocol error')
  })
})
