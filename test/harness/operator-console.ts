import { Window, type HTMLElement } from 'happy-dom'

import { publishRefresh, publishState } from '../../src/operator/api.js'
import { appJavaScript, appTemplate } from '../../src/operator/ui-assets.js'
import type { BacklogSnapshot } from '../../src/operator/operator.js'
import type { OrchestratorSnapshot } from '@symphony/core'

export type DetailResponse = Readonly<{ status: number; body: unknown }>

type Interval = Readonly<{ handler: () => void; ms: number }>

type ConsoleScript = (
  window: Window,
  document: Window['document'],
  navigator: unknown,
  fetch: (path: string, options?: unknown) => Promise<Response>,
  setInterval: (handler: () => void, ms: number) => number,
) => void

export type BootOptions = Readonly<{
  hash?: string
  width?: number
  state?: OrchestratorSnapshot
  backlog?: BacklogSnapshot
  details?: ReadonlyMap<string, DetailResponse>
  /** Answers a request before the default fixtures do. Returning null falls through. */
  serve?: (path: string, options: unknown) => Promise<Response> | null
  confirm?: () => boolean
  detailPending?: () => boolean
}>

export type ConsolePage = Readonly<{
  window: Window
  requestLog: readonly string[]
  postLog: readonly string[]
  flush: () => Promise<void>
  /** Fires every interval the console registered at the given period. */
  tick: (ms: number) => Promise<void>
  query: <Found = HTMLElement>(selector: string) => Found
  all: (selector: string) => readonly HTMLElement[]
  text: (selector: string) => string
  identifiers: (selector: string) => readonly string[]
  card: (identifier: string) => HTMLElement
  resize: (width: number) => Promise<void>
  close: () => Promise<void>
}>

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export const bootConsole = async (options: BootOptions = {}): Promise<ConsolePage> => {
  const window = new Window({ url: `http://127.0.0.1:7777/${options.hash ?? ''}` })
  const intervals: Interval[] = []
  const requestLog: string[] = []
  const postLog: string[] = []
  const details = options.details ?? new Map<string, DetailResponse>()
  const mutable = window as unknown as { innerWidth: number; confirm: () => boolean }
  mutable.innerWidth = options.width ?? 1280
  mutable.confirm = options.confirm ?? ((): boolean => true)

  const serve = async (path: string, requestOptions?: unknown): Promise<Response> => {
    requestLog.push(path)
    const method = (requestOptions as { method?: string } | undefined)?.method
    if (method === 'POST') {
      postLog.push(path)
    }
    const overridden = options.serve?.(path, requestOptions) ?? null
    if (overridden !== null) {
      return overridden
    }
    if (path === '/api/v1/state') {
      // The console reads the published document, so the fixtures go through the same
      // serialization boundary the server uses rather than restating its field names.
      return jsonResponse(200, options.state === undefined ? null : publishState(options.state))
    }
    if (path === '/api/v1/backlog') {
      return jsonResponse(200, options.backlog ?? null)
    }
    if (path === '/api/v1/refresh') {
      return jsonResponse(
        202,
        publishRefresh({
          coalesced: false,
          requestedAt: new Date().toISOString(),
          operations: ['issue_reconciliation'],
        }),
      )
    }
    if (path.startsWith('/api/v1/issues/')) {
      return jsonResponse(202, { accepted: true })
    }
    if (path.startsWith('/api/v1/agents/')) {
      if (options.detailPending?.() === true) {
        return new Promise<Response>(() => undefined)
      }
      const identifier = decodeURIComponent(path.slice('/api/v1/agents/'.length))
      const configured = details.get(identifier)
      return configured === undefined
        ? jsonResponse(404, {
            version: 'v1',
            error: { code: 'agent_not_found', message: 'No agent has that identifier' },
          })
        : jsonResponse(configured.status, configured.body)
    }
    return jsonResponse(404, { version: 'v1', error: { code: 'not_found', message: 'missing' } })
  }

  /**
   * Settles everything the console has in flight. Reading a `Response` body crosses the macrotask
   * queue, so draining microtasks alone would leave a released request half-finished.
   */
  const flush = async (): Promise<void> => {
    for (let round = 0; round < 6; round += 1) {
      for (let index = 0; index < 20; index += 1) {
        await Promise.resolve()
      }
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0)
      })
    }
  }

  const body = /<body>([\s\S]*)<\/body>/u.exec(appTemplate)?.[1] ?? ''
  window.document.head.innerHTML = '<meta name="csrf-token" content="ui-test-token">'
  window.document.body.innerHTML = body
  // The console ships as one classic script, so evaluating that exact source is the only way to
  // exercise what an operator gets. Its globals are supplied explicitly, which keeps the timers
  // deterministic and the transport under the test's control.
  // oxlint-disable-next-line typescript/no-implied-eval
  const script = new Function(
    'window',
    'document',
    'navigator',
    'fetch',
    'setInterval',
    appJavaScript,
  ) as ConsoleScript
  script(
    window,
    window.document,
    { clipboard: { writeText: (): Promise<void> => Promise.resolve() } },
    serve,
    (handler, ms) => {
      intervals.push({ handler, ms })
      return intervals.length
    },
  )
  await flush()

  const all = (selector: string): readonly HTMLElement[] =>
    [...window.document.querySelectorAll(selector)] as unknown as HTMLElement[]

  return {
    window,
    requestLog,
    postLog,
    flush,
    tick: async (ms: number): Promise<void> => {
      for (const interval of intervals) {
        if (interval.ms === ms) {
          interval.handler()
        }
      }
      await flush()
    },
    query: <Found = HTMLElement>(selector: string): Found => {
      const found = window.document.querySelector(selector)
      if (found === null) {
        throw new Error(`missing element: ${selector}`)
      }
      return found as unknown as Found
    },
    all,
    text: (selector: string): string =>
      window.document.querySelector(selector)?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
    identifiers: (selector: string): readonly string[] =>
      all(selector).map((node) => node.getAttribute('data-identifier') ?? ''),
    card: (identifier: string): HTMLElement => {
      const found = all('.work-card').find(
        (node) => node.getAttribute('data-identifier') === identifier,
      )
      if (found === undefined) {
        throw new Error(`no work card for ${identifier}`)
      }
      return found
    },
    resize: async (width: number): Promise<void> => {
      mutable.innerWidth = width
      window.dispatchEvent(new window.Event('resize'))
      await flush()
    },
    close: async (): Promise<void> => {
      await window.happyDOM.close()
    },
  }
}
