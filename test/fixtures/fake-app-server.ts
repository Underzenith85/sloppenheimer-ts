import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

type Message = Record<string, unknown>

const scenario = process.argv[2] ?? 'early'
const logPath = process.argv[3]

if (logPath === undefined) {
  throw new Error('fake app server requires a log path')
}

const isMessage = (value: unknown): value is Message =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const send = (message: Message): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const log = (message: Message): void => {
  appendFileSync(logPath, `${JSON.stringify(message)}\n`, 'utf8')
}

const complete = (status: 'completed' | 'failed' | 'interrupted' = 'completed'): void => {
  send({
    method: 'turn/completed',
    params: {
      threadId: 'thread-14',
      turn: {
        id: 'turn-14',
        status,
        ...(status === 'failed' ? { error: { message: 'deterministic turn failure' } } : {}),
      },
    },
  })
}

const pendingServerResponses = new Set<unknown>()

const startServerRequests = (): void => {
  const requests: readonly Message[] = [
    {
      id: 'command-approval',
      method: 'item/commandExecution/requestApproval',
      params: {},
    },
    { id: 702, method: 'item/fileChange/requestApproval', params: {} },
    {
      id: 'permission-approval',
      method: 'item/permissions/requestApproval',
      params: { permissions: {} },
    },
    { id: 'dynamic-tool', method: 'item/tool/call', params: { tool: 'missing' } },
    { id: 704, method: 'future/serverRequest', params: {} },
    { id: 'elicitation', method: 'mcpServer/elicitation/request', params: {} },
  ]
  for (const request of requests) {
    pendingServerResponses.add(request['id'])
    send(request)
  }
}

const handleClientRequest = (message: Message): void => {
  const id = message['id']
  const method = message['method']
  if (method === 'initialize') {
    const response = JSON.stringify({ id, result: { userAgent: 'fake-app-server' } })
    const split = Math.floor(response.length / 2)
    process.stdout.write(response.slice(0, split))
    process.stdout.write(`${response.slice(split)}\n`)
    return
  }
  if (method === 'thread/start') {
    send({ id, result: { thread: { id: 'thread-14' } } })
    return
  }
  if (method === 'thread/name/set') {
    send({ id, result: { thread: { id: 'thread-14' } } })
    return
  }
  if (method !== 'turn/start') {
    return
  }
  if (scenario === 'exit') {
    process.exit(23)
  }
  if (scenario === 'malformed-response') {
    send({ id, unexpected: true })
    return
  }
  if (scenario === 'oversized') {
    process.stdout.write(`${'x'.repeat(10 * 1024 * 1024 + 1)}\n`)
    return
  }
  if (scenario === 'input-required') {
    send({ id, result: { turn: { id: 'turn-14', status: 'inProgress' } } })
    send({
      id: 'input-request',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-14',
        turnId: 'turn-14',
        itemId: 'item-14',
        isBlocking: true,
        questions: [],
      },
    })
    return
  }
  if (scenario === 'requests') {
    send({ id, result: { turn: { id: 'turn-14', status: 'inProgress' } } })
    startServerRequests()
    return
  }
  process.stderr.write('fake diagnostic only\n')
  process.stdout.write('not-json\n')
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-14',
      turnId: 'turn-14',
      tokenUsage: {
        total: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
        last: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      },
    },
  })
  send({
    method: 'account/rateLimits/updated',
    params: { rateLimits: { planType: 'team', primary: { usedPercent: 12 } } },
  })
  complete(
    scenario === 'failed' ? 'failed' : scenario === 'interrupted' ? 'interrupted' : 'completed',
  )
  send({ id, result: { turn: { id: 'turn-14', status: 'inProgress' } } })
}

const handleServerResponse = (message: Message): void => {
  const id = message['id']
  if (!pendingServerResponses.delete(id)) {
    return
  }
  if (pendingServerResponses.size === 0) {
    complete()
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line): void => {
  const decoded = JSON.parse(line) as unknown
  if (!isMessage(decoded)) {
    throw new Error('client emitted a non-object message')
  }
  log(decoded)
  if (typeof decoded['method'] === 'string' && decoded['id'] !== undefined) {
    handleClientRequest(decoded)
  } else if (decoded['id'] !== undefined) {
    handleServerResponse(decoded)
  }
})

process.on('SIGTERM', (): void => {
  log({ fake: 'sigterm' })
  process.exit(0)
})
