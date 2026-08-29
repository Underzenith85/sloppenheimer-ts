import { createInterface } from 'node:readline'

type Request = Readonly<{ id: number | undefined; method: string | undefined }>

const decodeRequest = (line: string): Request => {
  const decoded = JSON.parse(line) as unknown
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new TypeError('fake App Server received a non-object request')
  }
  const record = decoded as Readonly<Record<string, unknown>>
  return {
    id: typeof record['id'] === 'number' ? record['id'] : undefined,
    method: typeof record['method'] === 'string' ? record['method'] : undefined,
  }
}

const scenario = process.argv[2] ?? 'complete'
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let turnId = 'turn-fake'

const send = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const completeTurn = (): void => {
  send({
    method: 'turn/usageUpdated',
    params: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
  })
  send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } })
}

lines.on('line', (line) => {
  const request = decodeRequest(line)
  if (request.method === 'initialize') {
    if (scenario !== 'read-timeout') {
      send({ id: request.id, result: { userAgent: 'fake-app-server' } })
    }
    return
  }
  if (request.method === 'initialized') {
    return
  }
  if (request.method === 'thread/start') {
    send({ id: request.id, result: { thread: { id: 'thread-fake' } } })
    return
  }
  if (request.method === 'turn/start') {
    turnId = 'turn-fake'
    send({ id: request.id, result: { turn: { id: turnId } } })
    if (scenario === 'diagnostic') {
      process.stderr.write('fake diagnostic\n')
      completeTurn()
    } else if (scenario === 'approval') {
      send({ id: 900, method: 'item/commandExecution/requestApproval', params: {} })
    } else if (scenario === 'unsupported-tool') {
      send({ id: 901, method: 'fake/tool/call', params: {} })
    } else if (scenario === 'user-input') {
      send({ id: 902, method: 'item/tool/requestUserInput', params: {} })
    } else if (scenario !== 'turn-timeout') {
      completeTurn()
    }
    return
  }
  if (request.id === 900 || request.id === 901) {
    completeTurn()
  }
})
