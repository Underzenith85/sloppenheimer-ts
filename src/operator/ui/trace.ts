// The high-fidelity trace view: the complete record of what an agent did, paged from disk and
// tailed live, under the compressed timeline that answers whether it is healthy.
//
// It is a separate view rather than more columns on the timeline because the two answer different
// questions. The timeline is a health summary an operator scans; this is evidence they read, and
// reading it means whole command lines, whole output, whole tool payloads.
//
// Three rules shape the rendering:
//
// - **Nothing is ever interpolated as markup.** Every value goes in through `textContent`, and a
//   `<script>` tag an agent printed renders as the characters it is. The trace is the one surface
//   here whose content is agent-authored end to end.
// - **A large payload is not in the DOM until it is asked for.** Output, patches and tool payloads
//   live behind a disclosure and are built on first open, so a page of a hundred events costs a
//   hundred summaries rather than a hundred transcripts.
// - **Redaction and truncation are visible.** An event the redactor touched says so, and every cut
//   field is named with what it kept and what it cut. A trace whose gaps were silent would be worse
//   than no trace, because it would read as complete.

type PublishedTraceEvent = import('../api.js').PublishedTraceEvent
type PublishedTrace = import('../api.js').PublishedTrace
type TraceCategory = import('@sloppenheimer/core/domain/trace.js').TraceCategory
type TraceOutcome = import('@sloppenheimer/core/domain/trace.js').TraceOutcome

/** Supplied by the server from the same vocabulary the runtime records against. */
declare const traceCategories: readonly TraceCategory[]
declare const traceOutcomes: readonly TraceOutcome[]

const traceList = element('#detail-trace')
const traceStatus = element('#detail-trace-status')
const traceFilters = element('#detail-trace-filters')
const traceMore = element<HTMLButtonElement>('#detail-trace-more')
const tracePanel = element<HTMLDetailsElement>('#detail-trace-panel')

/** How many records one request takes. The server caps it; this is what the console asks for. */
const tracePageSize = 100

let traceEvents: PublishedTraceEvent[] = []
let traceNextAfter = 0
let traceHasMore = false
let traceEnabled = true
let traceNotice = ''
let traceLoading = false
/** Categories the operator has switched off. Empty means everything, which is the default. */
const hiddenCategories = new Set<TraceCategory>()
let traceOutcome: TraceOutcome | 'all' = 'all'
/** The identifier the loaded records belong to, so a panel left open cannot show another issue's. */
let traceIdentifier: string | null = null
/** Aborts the live tail when the overlay closes or moves to another issue. */
let traceStream: AbortController | null = null

const traceUrl = (identifier: string, after: number): string => {
  const query = new URLSearchParams({ after: String(after), limit: String(tracePageSize) })
  if (traceOutcome !== 'all') {
    query.set('outcome', traceOutcome)
  }
  const shown = traceCategories.filter((category) => !hiddenCategories.has(category))
  if (shown.length < traceCategories.length) {
    query.set('category', shown.join(','))
  }
  return `/api/v1/agents/${encodeURIComponent(identifier)}/trace?${query.toString()}`
}

/**
 * The trace resources require the console token even on a read — they carry complete agent output,
 * so the server serves them only to a caller that can present it. That is also why the live tail is
 * read off a `fetch` body rather than through `EventSource`, which cannot send a header.
 */
const traceHeaders = { 'X-Sloppenheimer-CSRF': csrf }

const traceEmpty = (message: string): void => {
  traceList.replaceChildren(text('li', 'empty', message))
}

const bytesLabel = (value: number): string =>
  value < 1024 ? `${String(value)} B` : `${String(Math.round(value / 1024))} KB`

/** The one-line summary every event shows before anything is expanded. */
const traceSummary = (event: PublishedTraceEvent): string => {
  const body = event.body
  switch (body.kind) {
    case 'lifecycle': {
      return body.detail === null ? body.phase : `${body.phase} · ${body.detail}`
    }
    case 'message': {
      return `${body.role}: ${body.text}`
    }
    case 'reasoning_summary': {
      return body.text
    }
    case 'command': {
      const code = body.exitCode === null ? '' : ` · exit ${String(body.exitCode)}`
      return `${body.commandLine}${code}`
    }
    case 'tool': {
      return body.name
    }
    case 'file': {
      return body.files.map((file) => `${file.change} ${file.path}`).join(', ')
    }
    case 'approval': {
      return `${body.decision} · ${body.subject}`
    }
    case 'usage': {
      return `${String(body.totalTokens)} tokens`
    }
    case 'retry': {
      return `attempt ${String(body.attempt)}${body.reason === null ? '' : ` · ${body.reason}`}`
    }
    case 'cancellation': {
      return body.reason
    }
    case 'handoff': {
      return `${body.step} · ${body.status}`
    }
    case 'error': {
      return `${body.severity}: ${body.message}`
    }
    case 'unknown': {
      return body.fields.map((field) => `${field.name} (${field.type})`).join(', ')
    }
  }
}

/** The fields worth a disclosure of their own, as label and content, built only when opened. */
const tracePayloads = (event: PublishedTraceEvent): readonly (readonly [string, string])[] => {
  const body = event.body
  if (body.kind === 'command') {
    return [
      ...(body.stdout === null ? [] : ([['stdout', body.stdout]] as const)),
      ...(body.stderr === null ? [] : ([['stderr', body.stderr]] as const)),
    ]
  }
  if (body.kind === 'tool') {
    return [
      ...(body.arguments === null
        ? []
        : ([['arguments', JSON.stringify(body.arguments, null, 2)]] as const)),
      ...(body.result === null
        ? []
        : ([['result', JSON.stringify(body.result, null, 2)]] as const)),
    ]
  }
  if (body.kind === 'file') {
    return body.files
      .filter((file) => file.patch !== null)
      .map((file) => [`patch ${file.path}`, file.patch ?? ''] as const)
  }
  if (body.kind === 'message' || body.kind === 'reasoning_summary') {
    return body.text.includes('\n') ? [['full text', body.text] as const] : []
  }
  return []
}

/**
 * A payload disclosure whose content is built the first time it is opened.
 *
 * The listener is what makes "does not load large payloads until expanded" true of the DOM and not
 * only of the network: a hundred collapsed transcripts still cost a hundred transcripts if they are
 * all built up front.
 */
const tracePayload = (label: string, content: string): HTMLElement => {
  const disclosure = document.createElement('details')
  disclosure.className = 'trace-payload'
  disclosure.append(text('summary', '', `${label} · ${bytesLabel(content.length)}`))
  let built = false
  disclosure.addEventListener('toggle', () => {
    if (!disclosure.open || built) {
      return
    }
    built = true
    disclosure.append(text('pre', 'trace-pre', content))
  })
  return disclosure
}

const traceMarks = (event: PublishedTraceEvent): readonly HTMLElement[] => {
  const marks: HTMLElement[] = []
  if (event.redacted) {
    marks.push(chip('redacted', 'Redacted'))
  }
  for (const truncation of event.truncations) {
    const original =
      truncation.original_bytes === null ? '' : ` of ${bytesLabel(truncation.original_bytes)}`
    marks.push(
      chip(
        'truncated',
        `Truncated ${truncation.field} · kept ${bytesLabel(truncation.retained_bytes)}${original}`,
      ),
    )
  }
  return marks
}

const traceItem = (event: PublishedTraceEvent): HTMLElement => {
  const item = document.createElement('li')
  item.className = `trace-event category-${statusClass(event.category)} outcome-${statusClass(event.outcome)}`
  const head = document.createElement('div')
  head.className = 'trace-head'
  head.append(
    text('span', 'trace-time', formatTime(event.recorded_at)),
    text('span', 'trace-category', telemetryLabel(event.category)),
    chip(event.outcome, telemetryLabel(event.outcome)),
    ...traceMarks(event),
  )
  item.append(head)
  item.append(text('p', 'trace-body', traceSummary(event)))
  for (const [label, content] of tracePayloads(event)) {
    item.append(tracePayload(label, content))
  }
  item.append(
    text(
      'small',
      'trace-meta',
      `#${String(event.sequence)} · attempt ${String(event.attempt)} · run ${String(event.run_id)} · ${event.event}`,
    ),
  )
  return item
}

const renderTraceStatus = (page: PublishedTrace | null): void => {
  if (traceNotice.length > 0) {
    traceStatus.textContent = traceNotice
    return
  }
  if (!traceEnabled) {
    traceStatus.textContent =
      'High-fidelity capture is off for this host. Set trace.enabled in the workflow to retain a durable agent trace.'
    return
  }
  const parts = [`${String(traceEvents.length)} records`]
  if (page !== null && page.malformed_records > 0) {
    parts.push(`${String(page.malformed_records)} unreadable records were skipped`)
  }
  if (page !== null && page.evictions_total > 0) {
    parts.push(`${String(page.evictions_total)} segments have been evicted by retention`)
  }
  traceStatus.textContent = parts.join(' · ')
}

const renderTrace = (): void => {
  traceMore.hidden = !traceHasMore
  traceMore.disabled = traceLoading
  if (!traceEnabled) {
    traceEmpty('No durable trace is retained for this host.')
    renderTraceStatus(null)
    return
  }
  if (traceEvents.length === 0) {
    traceEmpty(traceLoading ? 'Loading trace…' : 'No trace records match the selected filters.')
    renderTraceStatus(null)
    return
  }
  traceList.replaceChildren(...traceEvents.map(traceItem))
}

/** Appends a record the live tail delivered, ignoring one the paged read already has. */
const appendTraceEvent = (event: PublishedTraceEvent): void => {
  if (event.identifier !== traceIdentifier) {
    return
  }
  if (traceEvents.some((held) => held.sequence === event.sequence)) {
    return
  }
  traceEvents.push(event)
  traceEvents.sort((left, right) => left.sequence - right.sequence)
  traceNextAfter = Math.max(traceNextAfter, event.sequence)
  renderTrace()
}

const loadTracePage = async (after: number): Promise<void> => {
  if (traceIdentifier === null || traceLoading) {
    return
  }
  const target = traceIdentifier
  traceLoading = true
  renderTrace()
  try {
    const response = await fetch(traceUrl(target, after), { headers: traceHeaders })
    const payload = (await response.json().catch(() => null)) as PublishedTrace | null
    if (target !== traceIdentifier) {
      return
    }
    if (!response.ok || payload === null) {
      traceNotice = `The trace could not be read (HTTP ${String(response.status)}).`
      return
    }
    traceNotice = ''
    traceEnabled = payload.enabled
    traceEvents = after === 0 ? [...payload.events] : [...traceEvents, ...payload.events]
    traceNextAfter = payload.next_after
    traceHasMore = payload.has_more
    renderTraceStatus(payload)
  } catch {
    traceNotice = 'The trace is temporarily unreachable.'
  } finally {
    traceLoading = false
    renderTrace()
  }
}

/**
 * The live tail, read off a streaming response body.
 *
 * A browser or a test environment that hands back no readable body is not an error: the panel keeps
 * the records it paged and the operator can ask for more. Tailing is a convenience over a resource
 * that is durable by construction, so it is allowed to be absent.
 */
const openTraceStream = (identifier: string): void => {
  traceStream?.abort()
  const controller = new AbortController()
  traceStream = controller
  const consume = async (): Promise<void> => {
    const response = await fetch(`/api/v1/agents/${encodeURIComponent(identifier)}/trace/stream`, {
      headers: traceHeaders,
      signal: controller.signal,
    })
    const body = response.body
    if (!response.ok || body === null) {
      return
    }
    // An environment that reports a body but hands back nothing readable throws here, and the
    // catch below treats it as no tail at all — which is the same outcome as a body of `null`.
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        return
      }
      buffered += decoder.decode(chunk.value, { stream: true })
      const frames = buffered.split('\n\n')
      buffered = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.split('\n').find((part) => part.startsWith('data: '))
        if (line === undefined) {
          continue
        }
        try {
          appendTraceEvent(JSON.parse(line.slice('data: '.length)) as PublishedTraceEvent)
        } catch {
          // A frame this console cannot read is dropped: the record is on disk either way, and the
          // next page will carry it.
        }
      }
    }
  }
  consume().catch(() => undefined)
}

/** Forgets everything the panel holds. Called whenever the overlay moves to another issue. */
const resetTrace = (identifier: string | null): void => {
  traceStream?.abort()
  traceStream = null
  traceIdentifier = identifier
  traceEvents = []
  traceNextAfter = 0
  traceHasMore = false
  traceEnabled = true
  traceNotice = ''
  if (tracePanel.open && identifier !== null) {
    void loadTracePage(0)
    openTraceStream(identifier)
  } else {
    renderTrace()
  }
}

const reloadTrace = (): void => {
  traceEvents = []
  traceNextAfter = 0
  void loadTracePage(0)
}

const buildTraceFilters = (): void => {
  const outcome = document.createElement('select')
  outcome.id = 'detail-trace-outcome'
  outcome.className = 'trace-outcome'
  outcome.append(text('option', '', 'Every outcome'))
  for (const value of traceOutcomes) {
    const option = text('option', '', telemetryLabel(value))
    option.value = value
    outcome.append(option)
  }
  outcome.addEventListener('change', () => {
    const chosen = outcome.value
    traceOutcome = traceOutcomes.find((candidate) => candidate === chosen) ?? 'all'
    reloadTrace()
  })
  const label = document.createElement('label')
  label.className = 'filter'
  label.append(text('span', '', 'Outcome'), outcome)
  traceFilters.replaceChildren(
    label,
    ...traceCategories.map((category) => {
      const wrapper = document.createElement('label')
      wrapper.className = 'filter'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = true
      input.value = category
      input.addEventListener('change', () => {
        if (input.checked) {
          hiddenCategories.delete(category)
        } else {
          hiddenCategories.add(category)
        }
        reloadTrace()
      })
      wrapper.append(input, text('span', '', telemetryLabel(category)))
      return wrapper
    }),
  )
}

const bindTrace = (): void => {
  buildTraceFilters()
  traceMore.addEventListener('click', () => {
    void loadTracePage(traceNextAfter)
  })
  tracePanel.addEventListener('toggle', () => {
    if (!tracePanel.open || traceIdentifier === null) {
      return
    }
    if (traceEvents.length === 0) {
      void loadTracePage(0)
    }
    openTraceStream(traceIdentifier)
  })
  renderTrace()
}
