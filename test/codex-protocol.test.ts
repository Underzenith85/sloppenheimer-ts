import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runAgent, type AgentEvent, type AgentResult } from '../src/codex.js'
import { issueId, issueIdentifier, type Issue, type Workspace } from '../src/domain.js'
import { AgentError } from '../src/errors.js'
import type { CodexConfig } from '../src/workflow.js'

type JsonRecord = Record<string, unknown>

type ScenarioResult = Readonly<{
  result: AgentResult | null
  error: AgentError | null
  events: readonly AgentEvent[]
  messages: readonly JsonRecord[]
}>

const execFilePromise = promisify(execFile)
const fixturePath = fileURLToPath(new URL('./fixtures/fake-app-server.ts', import.meta.url))
const issue: Issue = {
  id: issueId('14'),
  nativeRef: { repository: 'Underzenith85/symphony-ts', number: 14 },
  identifier: issueIdentifier('Underzenith85/symphony-ts#14'),
  title: 'Bring the Codex App Server client into protocol conformance',
  description: null,
  priority: null,
  state: 'open',
  branchName: null,
  url: 'https://github.com/Underzenith85/symphony-ts/issues/14',
  assigneeId: null,
  labels: ['symphony'],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const parseMessages = (text: string): readonly JsonRecord[] =>
  text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isRecord)

const runScenario = async (scenario: string): Promise<ScenarioResult> => {
  const directory = await mkdtemp(join(tmpdir(), 'symphony-codex-test-'))
  const logPath = join(directory, 'messages.jsonl')
  const workspace: Workspace = { path: directory, key: 'issue-14', createdNow: true }
  const config: CodexConfig = {
    command: `${shellQuote(process.execPath)} ${shellQuote(fixturePath)} ${shellQuote(scenario)} ${shellQuote(logPath)}`,
    approvalPolicy: 'never',
    threadSandbox: 'workspace-write',
    turnSandboxPolicy: null,
    turnTimeoutMs: 2_000,
    readTimeoutMs: 2_000,
    stallTimeoutMs: 0,
  }
  const events: AgentEvent[] = []
  let result: AgentResult | null = null
  let error: AgentError | null = null
  const outcome = await Effect.runPromise(
    runAgent(
      issue,
      workspace,
      config,
      'Implement the issue.',
      1,
      [],
      () => Effect.succeed(null),
      () => false,
      (event) => {
        events.push(event)
      },
    ).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: 'Failed' as const, cause }),
        onSuccess: (value) => ({ _tag: 'Succeeded' as const, value }),
      }),
    ),
  )
  if (outcome._tag === 'Succeeded') {
    result = outcome.value
  } else {
    error = outcome.cause
  }
  const messages = parseMessages(await readFile(logPath, 'utf8'))
  await rm(directory, { recursive: true, force: true })
  return { result, error, events, messages }
}

const clientProtocolMessages = (messages: readonly JsonRecord[]): readonly JsonRecord[] =>
  messages.filter((message) => message['fake'] === undefined)

describe('Codex App Server protocol', (): void => {
  let schemaDirectory = ''

  beforeAll(async (): Promise<void> => {
    schemaDirectory = await mkdtemp(join(tmpdir(), 'symphony-codex-schema-'))
    await execFilePromise('codex', ['app-server', 'generate-json-schema', '--out', schemaDirectory])
  })

  afterAll(async (): Promise<void> => {
    if (schemaDirectory.length > 0) {
      await rm(schemaDirectory, { recursive: true, force: true })
    }
  })

  it('survives immediate responses and completion-before-response ordering', async (): Promise<void> => {
    const run = await runScenario('early')

    expect(run.error).toBeNull()
    expect(run.result).toEqual({ threadId: 'thread-14', turnId: 'turn-14', turnCount: 1 })
    expect(run.events.some((event) => event.event === 'diagnostic')).toBe(true)
    expect(run.events.some((event) => event.event === 'malformed')).toBe(true)
    expect(run.events.find((event) => event.event === 'thread/tokenUsage/updated')?.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    })
    expect(
      run.events.find((event) => event.event === 'account/rateLimits/updated')?.rateLimits,
    ).toEqual({ planType: 'team', primary: { usedPercent: 12 } })
    expect(run.events.find((event) => event.event === 'session_started')).toMatchObject({
      threadId: 'thread-14',
      turnId: 'turn-14',
      sessionId: 'thread-14-turn-14',
      issue: {
        id: '14',
        identifier: 'Underzenith85/symphony-ts#14',
        title: issue.title,
      },
    })
    expect(run.events.some((event) => event.event === 'turn_completed')).toBe(true)
    expect(run.messages.at(-1)).toEqual({ fake: 'sigterm' })
  })

  it('emits startup messages accepted by the installed Codex schema', async (): Promise<void> => {
    const run = await runScenario('early')
    const messages = clientProtocolMessages(run.messages)
    const requests = messages.filter((message) => typeof message['method'] === 'string')
    const requestSchema = JSON.parse(
      await readFile(join(schemaDirectory, 'ClientRequest.json'), 'utf8'),
    ) as unknown
    const notificationSchema = JSON.parse(
      await readFile(join(schemaDirectory, 'ClientNotification.json'), 'utf8'),
    ) as unknown

    expect(requests).toHaveLength(5)
    for (const request of requests.filter((message) => message['id'] !== undefined)) {
      expect(schemaAccepts(request, requestSchema)).toBe(true)
    }
    const initialized = requests.find((message) => message['method'] === 'initialized')
    expect(initialized).toEqual({ method: 'initialized' })
    expect(schemaAccepts(initialized, notificationSchema)).toBe(true)
    const threadStart = requests.find((message) => message['method'] === 'thread/start')
    expect(threadStart).toMatchObject({
      params: {
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        serviceName: 'symphony_ts',
      },
    })
    const threadStartParams = isRecord(threadStart?.['params']) ? threadStart['params'] : null
    const threadCwd = threadStartParams?.['cwd']
    expect(typeof threadCwd).toBe('string')
    expect(typeof threadCwd === 'string' && threadCwd.includes('symphony-codex-test-')).toBe(true)
    expect(requests.find((message) => message['method'] === 'thread/name/set')).toMatchObject({
      params: { threadId: 'thread-14', name: `${issue.identifier}: ${issue.title}` },
    })
    const turnStart = requests.find((message) => message['method'] === 'turn/start')
    expect(turnStart).toMatchObject({
      params: {
        threadId: 'thread-14',
        input: [{ type: 'text', text: 'Implement the issue.' }],
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'workspaceWrite',
          networkAccess: true,
        },
      },
    })
    const turnStartParams = isRecord(turnStart?.['params']) ? turnStart['params'] : null
    const sandboxPolicy = isRecord(turnStartParams?.['sandboxPolicy'])
      ? turnStartParams['sandboxPolicy']
      : null
    const writableRoots = sandboxPolicy?.['writableRoots']
    expect(Array.isArray(writableRoots)).toBe(true)
    expect(
      Array.isArray(writableRoots) &&
        typeof writableRoots[0] === 'string' &&
        writableRoots[0].includes('symphony-codex-test-'),
    ).toBe(true)
  })

  it('answers string and integer server IDs with schema-valid results', async (): Promise<void> => {
    const run = await runScenario('requests')
    const responses = clientProtocolMessages(run.messages).filter(
      (message) => message['id'] !== undefined && message['method'] === undefined,
    )

    expect(run.error).toBeNull()
    expect(responses).toContainEqual({
      id: 'command-approval',
      result: { decision: 'acceptForSession' },
    })
    expect(responses).toContainEqual({ id: 702, result: { decision: 'acceptForSession' } })
    expect(responses).toContainEqual({
      id: 'permission-approval',
      result: { permissions: {}, scope: 'session' },
    })
    expect(responses).toContainEqual({
      id: 'dynamic-tool',
      result: {
        success: false,
        contentItems: [{ type: 'inputText', text: 'Symphony does not support this dynamic tool' }],
      },
    })
    expect(responses).toContainEqual({
      id: 704,
      error: { code: -32601, message: 'Unsupported client request: future/serverRequest' },
    })
    expect(responses).toContainEqual({ id: 'elicitation', result: { action: 'decline' } })
    const responseSchemas = new Map<unknown, string>([
      ['command-approval', 'CommandExecutionRequestApprovalResponse.json'],
      [702, 'FileChangeRequestApprovalResponse.json'],
      ['permission-approval', 'PermissionsRequestApprovalResponse.json'],
      ['dynamic-tool', 'DynamicToolCallResponse.json'],
      ['elicitation', 'McpServerElicitationRequestResponse.json'],
    ])
    for (const response of responses) {
      const schemaFile = responseSchemas.get(response['id'])
      if (schemaFile !== undefined) {
        const schema = JSON.parse(
          await readFile(join(schemaDirectory, schemaFile), 'utf8'),
        ) as unknown
        expect(schemaAccepts(response['result'], schema)).toBe(true)
      }
    }
    const methodNotFound = responses.find((response) => response['id'] === 704)
    const errorSchema = JSON.parse(
      await readFile(join(schemaDirectory, 'JSONRPCError.json'), 'utf8'),
    ) as unknown
    expect(schemaAccepts(methodNotFound, errorSchema)).toBe(true)
  })

  it('fails user input arriving immediately after the turn/start response', async (): Promise<void> => {
    const run = await runScenario('input-required')

    expect(run.result).toBeNull()
    expect(run.error?.category).toBe('input_required')
    expect(run.events.some((event) => event.event === 'turn_input_required')).toBe(true)
  })

  it.each([
    ['failed', 'turn_failed'],
    ['interrupted', 'turn_cancelled'],
  ] as const)('maps an immediate %s terminal status', async (scenario, category): Promise<void> => {
    const run = await runScenario(scenario)

    expect(run.error?.category).toBe(category)
    expect(run.events.some((candidate) => candidate.event === category)).toBe(true)
  })

  it.each([
    ['malformed-response', 'protocol_error'],
    ['exit', 'process_exited'],
    ['oversized', 'protocol_error'],
  ] as const)(
    'fails %s without waiting for a timeout',
    async (scenario, category): Promise<void> => {
      const startedAt = Date.now()
      const run = await runScenario(scenario)

      expect(run.error?.category).toBe(category)
      expect(Date.now() - startedAt).toBeLessThan(1_500)
    },
  )
})

const schemaAccepts = (value: unknown, schemaValue: unknown, rootValue = schemaValue): boolean => {
  if (!isRecord(schemaValue) || !isRecord(rootValue)) {
    return false
  }
  const reference = schemaValue['$ref']
  if (typeof reference === 'string') {
    const target = resolveSchemaReference(rootValue, reference)
    return target !== null && schemaAccepts(value, target, rootValue)
  }
  for (const keyword of ['allOf'] as const) {
    const choices = schemaValue[keyword]
    if (
      Array.isArray(choices) &&
      !choices.every((choice) => schemaAccepts(value, choice, rootValue))
    ) {
      return false
    }
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const choices = schemaValue[keyword]
    if (Array.isArray(choices)) {
      const matches = choices.filter((choice) => schemaAccepts(value, choice, rootValue)).length
      if ((keyword === 'anyOf' && matches === 0) || (keyword === 'oneOf' && matches !== 1)) {
        return false
      }
    }
  }
  const enumerated = schemaValue['enum']
  if (Array.isArray(enumerated) && !enumerated.some((candidate) => Object.is(candidate, value))) {
    return false
  }
  const types = Array.isArray(schemaValue['type']) ? schemaValue['type'] : [schemaValue['type']]
  if (types[0] !== undefined && !types.some((type) => valueMatchesType(value, type))) {
    return false
  }
  if (Array.isArray(value)) {
    const items = schemaValue['items']
    return items === undefined || value.every((item) => schemaAccepts(item, items, rootValue))
  }
  if (!isRecord(value)) {
    return true
  }
  const required = schemaValue['required']
  if (
    Array.isArray(required) &&
    !required.every((key) => typeof key === 'string' && Object.hasOwn(value, key))
  ) {
    return false
  }
  const properties = schemaValue['properties']
  if (!isRecord(properties)) {
    return true
  }
  return Object.entries(value).every(([key, propertyValue]) => {
    const propertySchema = properties[key]
    return propertySchema === undefined || schemaAccepts(propertyValue, propertySchema, rootValue)
  })
}

const resolveSchemaReference = (root: JsonRecord, reference: string): unknown => {
  if (!reference.startsWith('#/')) {
    return null
  }
  let current: unknown = root
  for (const rawPart of reference.slice(2).split('/')) {
    if (!isRecord(current)) {
      return null
    }
    const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~')
    current = current[part]
  }
  return current
}

const valueMatchesType = (value: unknown, type: unknown): boolean => {
  switch (type) {
    case 'array': {
      return Array.isArray(value)
    }
    case 'boolean': {
      return typeof value === 'boolean'
    }
    case 'integer': {
      return typeof value === 'number' && Number.isInteger(value)
    }
    case 'null': {
      return value === null
    }
    case 'number': {
      return typeof value === 'number'
    }
    case 'object': {
      return isRecord(value)
    }
    case 'string': {
      return typeof value === 'string'
    }
    default: {
      return false
    }
  }
}
