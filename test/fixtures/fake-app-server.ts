// Deterministic Codex App Server stand-in, run directly by Node's native TypeScript support. The
// scenario name selects one protocol behaviour so a test can drive a specific startup, framing,
// ordering, approval, malformed-data or shutdown path without depending on an installed Codex.

type JsonRecord = Record<string, unknown>

const scenario = process.argv[2] ?? 'normal'

const send = (message: JsonRecord): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const sendRaw = (text: string): void => {
  process.stdout.write(text)
}

const thread = { id: 'thread-1' } as const
const turn = { id: 'turn-1', status: 'completed' } as const

const completeTurn = (status: string = 'completed'): void => {
  send({ method: 'turn/completed', params: { turn: { ...turn, status } } })
}

const handleInitialize = (id: unknown): void => {
  if (scenario === 'startup-silent') {
    return
  }
  if (scenario === 'startup-exit') {
    process.exit(3)
  }
  if (scenario === 'stderr-noise') {
    process.stderr.write('warning: this is diagnostic only\n')
  }
  if (scenario === 'malformed') {
    sendRaw('this is not json\n')
    sendRaw('[1,2,3]\n')
    sendRaw('{"unrelated":true}\n')
  }
  if (scenario === 'oversize-line') {
    sendRaw(`${'x'.repeat(11 * 1024 * 1024)}\n`)
    return
  }
  send({ id, result: { userAgent: 'fake-app-server/1.0' } })
}

const handleThreadStart = (id: unknown): void => {
  if (scenario === 'thread-error') {
    send({ id, error: { code: -32000, message: 'thread/start refused' } })
    return
  }
  if (scenario === 'thread-missing-id') {
    send({ id, result: { thread: {} } })
    return
  }
  send({ id, result: { thread } })
}

const handleTurnStart = (id: unknown): void => {
  switch (scenario) {
    case 'immediate-completion': {
      // The completion is written before the response: the ordering race that must not lose a turn.
      completeTurn()
      send({ id, result: { turn } })
      return
    }
    case 'turn-failed': {
      send({ id, result: { turn } })
      completeTurn('failed')
      return
    }
    case 'turn-cancelled': {
      send({ id, result: { turn } })
      send({ method: 'turn/failed', params: { turn: { ...turn, status: 'cancelled' } } })
      return
    }
    case 'approval': {
      send({ id, result: { turn } })
      send({ id: 9001, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } })
      return
    }
    case 'unsupported-request': {
      send({ id, result: { turn } })
      send({ id: 9002, method: 'item/unknown/doSomething', params: {} })
      return
    }
    case 'input-required': {
      send({ id, result: { turn } })
      send({ id: 9003, method: 'item/tool/requestUserInput', params: { prompt: 'continue?' } })
      return
    }
    case 'exit-during-turn': {
      send({ id, result: { turn } })
      setTimeout(() => {
        process.exit(9)
      }, 20)
      return
    }
    case 'permissions-approval': {
      send({ id, result: { turn } })
      send({
        id: 9004,
        method: 'item/permissions/requestApproval',
        params: { permissions: ['network'] },
      })
      return
    }
    case 'carried-identity': {
      // An item notification naming its own thread and turn, emitted before the response that
      // would otherwise teach the client those ids.
      send({
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item: { id: 'item-1' } },
      })
      send({ id, result: { turn } })
      completeTurn()
      return
    }
    case 'batched-identity': {
      // Response and a turn-less notification in a single write, so the client reads both from one
      // chunk and must know the turn id before it dispatches the notification.
      sendRaw(
        `${JSON.stringify({ id, result: { turn } })}\n${JSON.stringify({
          method: 'item/agentMessage',
          params: { text: 'working' },
        })}\n`,
      )
      completeTurn()
      return
    }
    case 'usage': {
      send({ id, result: { turn } })
      send({
        method: 'turn/usage',
        params: { usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } },
      })
      completeTurn()
      return
    }
    default: {
      send({ id, result: { turn } })
      completeTurn()
    }
  }
}

const handle = (message: JsonRecord): void => {
  const id = message['id']
  const method = message['method']

  if (method === 'initialize') {
    handleInitialize(id)
    return
  }
  if (method === 'initialized') {
    return
  }
  if (method === 'thread/start') {
    handleThreadStart(id)
    return
  }
  if (method === 'turn/start') {
    handleTurnStart(id)
    return
  }
  if (typeof method === 'string') {
    send({ id, error: { code: -32601, message: `unknown method ${method}` } })
    return
  }
  // Client responses to server-initiated requests.
  if (id === 9001) {
    send({ method: 'approval/observed', params: message })
    completeTurn()
    return
  }
  if (id === 9002 || id === 9003 || id === 9004) {
    send({ method: 'request/rejected', params: message })
  }
}

let pendingInput = ''

process.stdin.on('data', (chunk: Buffer) => {
  pendingInput += chunk.toString('utf8')
  for (;;) {
    const index = pendingInput.indexOf('\n')
    if (index < 0) {
      break
    }
    const line = pendingInput.slice(0, index)
    pendingInput = pendingInput.slice(index + 1)
    if (line.trim().length === 0) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      handle(parsed as JsonRecord)
    }
  }
})

process.stdin.on('end', () => {
  process.exit(0)
})
