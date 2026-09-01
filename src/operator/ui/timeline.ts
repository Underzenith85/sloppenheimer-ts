// The overlay's event timeline: which categories are shown, the controls that choose them, and the
// list itself. The presets are the whole of the filtering vocabulary, so they and the rendering that
// obeys them stay together.

type AgentTimelineCategory = import('@sloppenheimer/core/telemetry.js').AgentTimelineCategory

/** Supplied by the server from the same telemetry module the runtime uses. */
declare const timelineCategories: readonly AgentTimelineCategory[]

type TimelinePreset = 'summary' | 'failures' | 'everything' | 'custom'

/**
 * What Summary keeps. Everything excluded from it is protocol bookkeeping — session handshakes,
 * private reasoning, chat turns, individual tool calls and usage accounting — none of which tells
 * an operator whether the agent is making progress.
 */
const summaryCategories: readonly AgentTimelineCategory[] = [
  'file',
  'command',
  'retry',
  'error',
  'cancellation',
  'handoff',
]

const failureCategories: readonly AgentTimelineCategory[] = ['error', 'retry', 'cancellation']

const presetCategories = (preset: TimelinePreset): readonly AgentTimelineCategory[] => {
  if (preset === 'summary') {
    return summaryCategories
  }
  if (preset === 'failures') {
    return failureCategories
  }
  return timelineCategories
}

const detailTimeline = element('#detail-timeline')

const detailPresets = element('#detail-presets')
const detailFilters = element('#detail-filters')

let activePreset: TimelinePreset = 'summary'
const activeCategories = new Set<AgentTimelineCategory>(summaryCategories)

const renderTimeline = (): void => {
  if (detail === null) {
    detailTimeline.replaceChildren(
      text('li', 'empty', detailNotice.length > 0 ? detailNotice : 'No events yet.'),
    )
    return
  }
  const events = detail.timeline.events.filter((event) => activeCategories.has(event.category))
  if (events.length === 0) {
    detailTimeline.replaceChildren(text('li', 'empty', 'No events match the selected filters.'))
    return
  }
  const items = events.map((event) => {
    const item = document.createElement('li')
    item.className = 'timeline-event category-' + event.category
    item.append(text('span', 'timeline-time', formatTime(event.at)))
    item.append(text('span', 'timeline-category', telemetryLabel(event.category)))
    item.append(text('span', 'timeline-body', describeEvent(event)))
    item.append(
      text(
        'small',
        'timeline-meta',
        'attempt ' + String(event.attempt) + ' · #' + String(event.sequence),
      ),
    )
    return item
  })
  if (detail.timeline.dropped > 0) {
    items.unshift(
      text(
        'li',
        'timeline-dropped',
        String(detail.timeline.dropped) + ' earlier events were dropped to keep retention bounded.',
      ),
    )
  }
  detailTimeline.replaceChildren(...items)
}

const syncFilterControls = (): void => {
  for (const input of detailFilters.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
    input.checked = activeCategories.has(input.value as AgentTimelineCategory)
  }
  for (const button of detailPresets.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-pressed', String(button.dataset['preset'] === activePreset))
  }
}

const applyPreset = (preset: TimelinePreset): void => {
  activePreset = preset
  activeCategories.clear()
  for (const category of presetCategories(preset)) {
    activeCategories.add(category)
  }
  syncFilterControls()
  renderTimeline()
}

const buildFilters = (): void => {
  const presets: readonly (readonly [TimelinePreset, string])[] = [
    ['summary', 'Summary'],
    ['failures', 'Errors and retries'],
    ['everything', 'Everything'],
  ]
  detailPresets.replaceChildren(
    ...presets.map(([preset, label]) => {
      const button = text('button', 'preset', label)
      button.type = 'button'
      button.dataset['preset'] = preset
      button.setAttribute('aria-pressed', String(preset === activePreset))
      button.addEventListener('click', () => applyPreset(preset))
      return button
    }),
  )
  detailFilters.replaceChildren(
    ...timelineCategories.map((category) => {
      const label = document.createElement('label')
      label.className = 'filter'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = activeCategories.has(category)
      input.value = category
      input.addEventListener('change', () => {
        if (input.checked) {
          activeCategories.add(category)
        } else {
          activeCategories.delete(category)
        }
        activePreset = 'custom'
        syncFilterControls()
        renderTimeline()
      })
      label.append(input, text('span', '', telemetryLabel(category)))
      return label
    }),
  )
}
