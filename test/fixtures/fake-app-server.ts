// Deterministic Codex App Server stand-in, run directly by Node's native TypeScript support. The
// scenario name selects one protocol behaviour so a test can drive a specific startup, framing,
// ordering, approval, malformed-data or shutdown path without depending on an installed Codex.

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

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
  if (scenario === 'split-stderr-secret') {
    process.stderr.write('Authorization:')
    setTimeout(() => {
      process.stderr.write(' Bearer split-secret\n')
      send({ id, result: { userAgent: 'fake-app-server/1.0' } })
    }, 20)
    return
  }
  if (scenario === 'pem-stderr-secret') {
    process.stderr.write('PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n')
    process.stderr.write('c2VjcmV0LXByaXZhdGUta2V5LWJvZHk=\n')
    process.stderr.write('-----END PRIVATE KEY-----\n')
  }
  if (scenario === 'pgp-stderr-secret') {
    process.stderr.write('-----BEGIN PGP PRIVATE KEY BLOCK-----\n')
    process.stderr.write('c2VjcmV0LXBncC1wcml2YXRlLWtleQ==\n')
    process.stderr.write('-----END PGP PRIVATE KEY BLOCK-----\n')
  }
  if (scenario === 'unterminated-stderr-secret') {
    process.stderr.write('Authorization: Bearer final-secret')
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
    case 'turn-interrupted': {
      send({ id, result: { turn } })
      send({ method: 'turn/failed', params: { turn: { ...turn, status: 'interrupted' } } })
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
    case 'approval-before-response': {
      // The approval request precedes the response that would teach the client the turn id, so the
      // event can only be attributed from the identity the request itself carries.
      send({
        id: 9007,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: thread.id, turnId: turn.id, command: 'ls' },
      })
      send({ id, result: { turn } })
      return
    }
    case 'string-request-id': {
      // `RequestId` permits a string. The client must answer it like any other request; if it
      // reads it as a notification the turn never completes.
      send({ id, result: { turn } })
      send({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'ls' },
      })
      return
    }
    case 'complete-then-exit': {
      // A turn the server genuinely completed, then the session dies. Settling the in-flight turn
      // on session death must not overwrite a completion already recorded.
      send({ id, result: { turn } })
      completeTurn()
      setTimeout(() => {
        process.exit(0)
      }, 20)
      return
    }
    case 'failed-then-completed': {
      // Two lifecycle notifications for one turn. The first settlement is the turn's result; a
      // later one must not overturn it.
      send({ id, result: { turn } })
      send({ method: 'turn/failed', params: { turn: { ...turn, status: 'failed' } } })
      completeTurn()
      return
    }
    case 'turn-no-status': {
      send({ id, result: { turn } })
      send({ method: 'turn/completed', params: { turn: { id: turn.id } } })
      return
    }
    case 'input-then-completion': {
      // An interactive-input request and a completion for the same turn, both before any waiter can
      // exist. One write, so the client sees all three lines in one synchronous pass.
      sendRaw(
        [
          JSON.stringify({ id, result: { turn } }),
          JSON.stringify({
            id: 9006,
            method: 'item/tool/requestUserInput',
            params: { prompt: 'continue?' },
          }),
          JSON.stringify({ method: 'turn/completed', params: { turn } }),
        ].join('\n') + '\n',
      )
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
    case 'heartbeat': {
      send({ id, result: { turn } })
      let ticks = 0
      const beat = setInterval(() => {
        ticks += 1
        send({ method: 'turn/progress', params: { turn, tick: ticks } })
        if (ticks >= 10) {
          clearInterval(beat)
          completeTurn()
        }
      }, 60)
      return
    }
    case 'silent-turn': {
      send({ id, result: { turn } })
      return
    }
    case 'garbage-heartbeat': {
      // Parseable but meaningless output, faster than the silence timeout. It must not keep the
      // turn alive: a stuck server emitting `{}` is silence as far as the turn is concerned.
      send({ id, result: { turn } })
      setInterval(() => {
        sendRaw('{}\n')
      }, 40)
      return
    }
    case 'unattributed-heartbeat': {
      // Well-formed session-level notifications that name no turn, faster than the silence
      // timeout. They say nothing about the live turn and must not keep it alive.
      send({ id, result: { turn } })
      setInterval(() => {
        send({ method: 'session/keepAlive', params: { note: 'still here' } })
      }, 40)
      return
    }
    case 'slow-exiting-grandchild': {
      // Ignores SIGTERM but leaves on its own shortly after. Shutdown should notice the group
      // emptying rather than sitting out the whole escalation grace.
      send({ id, result: { turn } })
      // A single process that really ignores SIGTERM — a shell trap does not help, because the
      // `sleep` it waits on is signalled independently and returns early.
      const child = spawn(
        'node',
        ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 500)'],
        { stdio: 'ignore' },
      )
      child.unref()
      writeFileSync('grandchild.pid', String(child.pid ?? 0))
      return
    }
    case 'unmatched-response-heartbeat': {
      // Response-shaped messages answering ids the client never sent, faster than the silence
      // timeout. They settle nothing, so they are not progress and must not keep the turn alive.
      send({ id, result: { turn } })
      let unknown = 5000
      setInterval(() => {
        unknown += 1
        send({ id: unknown, result: { ok: true } })
      }, 40)
      return
    }
    case 'stale-turn-heartbeat': {
      // Steady traffic naming a turn that already ended. It belongs to no live turn and must not
      // keep the current one alive.
      send({ id, result: { turn } })
      setInterval(() => {
        send({
          method: 'item/started',
          params: { threadId: thread.id, turnId: 'turn-0', item: { id: 'stale' } },
        })
      }, 40)
      return
    }
    case 'orphan-after-crash': {
      // A descendant that ignores SIGTERM, then the App Server itself dies. Shutdown must still
      // reap the group rather than treating the leader's exit as completion.
      send({ id, result: { turn } })
      const child = spawn('sh', ['-c', 'trap "" TERM; sleep 300'], { stdio: 'ignore' })
      child.unref()
      writeFileSync('grandchild.pid', String(child.pid ?? 0))
      setTimeout(() => {
        process.exit(7)
      }, 60)
      return
    }
    case 'spawn-grandchild': {
      send({ id, result: { turn } })
      const child = spawn('sleep', ['300'], { stdio: 'ignore' })
      child.unref()
      writeFileSync('grandchild.pid', String(child.pid ?? 0))
      return
    }
    case 'stubborn-grandchild': {
      send({ id, result: { turn } })
      // Ignores SIGTERM and holds none of the inherited pipes, so the App Server can close while
      // the descendant is still alive in the process group.
      const child = spawn('sh', ['-c', 'trap "" TERM; sleep 300'], { stdio: 'ignore' })
      child.unref()
      writeFileSync('grandchild.pid', String(child.pid ?? 0))
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
  if (method === 'account/rateLimits/read') {
    if (scenario === 'sparse-rate-limit-before-read') {
      send({
        method: 'account/rateLimits/updated',
        params: { rateLimits: { primary: { usedPercent: 42 } } },
      })
    }
    send({
      id,
      result: {
        rateLimits: {
          limitId: 'codex',
          credits: { hasCredits: true, unlimited: false, balance: '20' },
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_730_948_100 },
          secondary: { usedPercent: 5, windowDurationMins: 1_440, resetsAt: 1_730_948_200 },
        },
      },
    })
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
  if (id === 9001 || id === 9007 || id === 'approval-1') {
    send({ method: 'approval/observed', params: message })
    completeTurn()
    return
  }
  if (id === 9004) {
    // The permissions grant is a result, not an error: the turn proceeds once it is answered.
    send({ method: 'permissions/observed', params: message })
    completeTurn()
    return
  }
  if (id === 9002) {
    send({ method: 'request/rejected', params: message })
    completeTurn()
    return
  }
  if (id === 9003 || id === 9006) {
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
