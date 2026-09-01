// Shared browser primitives: element lookup, node construction, HTTP, and the time and duration
// formats the whole console uses. Nothing here knows what the console is for.

type DetailPayload = Readonly<{
  detail?: import('@sloppenheimer/core/telemetry.js').AgentDetailSnapshot
  error?: Readonly<{ message?: string }>
}>

const element = <ElementType extends HTMLElement = HTMLElement>(selector: string): ElementType => {
  const match = document.querySelector<ElementType>(selector)
  if (match === null) {
    throw new Error(`Missing UI element: ${selector}`)
  }
  return match
}

const text = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className: string,
  value: string,
): HTMLElementTagNameMap[Tag] => {
  const node = document.createElement(tag)
  if (className.length > 0) {
    node.className = className
  }
  node.textContent = value
  return node
}

const csrf = element('meta[name="csrf-token"]').getAttribute('content') ?? ''
const notice = element('#notice')

const request = async <Value>(path: string, options: RequestInit = {}): Promise<Value> => {
  const response = await fetch(path, options)
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as DetailPayload | null
    const message = payload?.error?.message ?? `Request failed with HTTP ${response.status}`
    throw new Error(message)
  }
  return response.json() as Promise<Value>
}

const requestStatus = async (
  path: string,
): Promise<Readonly<{ ok: boolean; status: number; payload: DetailPayload }>> => {
  const response = await fetch(path)
  const payload = (await response.json().catch(() => ({}))) as DetailPayload
  return { ok: response.ok, status: response.status, payload }
}

const post = async (path: string): Promise<void> => {
  await request<unknown>(path, { method: 'POST', headers: { 'X-Sloppenheimer-CSRF': csrf } })
}

const formatDuration = (seconds: number): string => {
  if (seconds < 60) {
    return `${Math.round(seconds)}s runtime`
  }
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s runtime`
}

const formatTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))

const formatClock = (milliseconds: number): string => {
  const total = Math.max(Math.round(milliseconds / 1000), 0)
  const minutes = Math.floor(total / 60)
  if (minutes === 0) {
    return `${total}s`
  }
  return `${minutes}m ${String(total % 60).padStart(2, '0')}s`
}

/** How long ago, in words, for a timestamp the operator is scanning rather than reading exactly. */
const formatAgo = (value: string, now: number): string => {
  const elapsed = now - new Date(value).getTime()
  if (elapsed < 60_000) {
    return 'just now'
  }
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  return `${Math.floor(minutes / 60)}h ago`
}

/** A CSS-safe suffix for a status token, so state is styled without interpolating raw text. */
const statusClass = (status: string): string =>
  status
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/(^-|-$)/g, '')

const telemetryLabel = (value: string): string =>
  value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

/**
 * A chip. Status is never carried by colour alone: the chip always spells its meaning out, and the
 * class only tints what the text already says.
 */
const chip = (kind: string, label: string): HTMLElement =>
  text('span', `chip chip-${statusClass(kind)}`, label)

const setNotice = (message: string): void => {
  notice.textContent = message
}
