// The dependency plan, drawn. The layout is a deterministic topological one — sorted at every step,
// so one backlog always draws the same graph — and the nodes carry the runtime status the dashboard
// shows, because a plan that disagreed with the queues would be a second source of truth.

const graphLayout = (
  snapshot: BacklogSnapshot,
): Readonly<{
  positions: ReadonlyMap<string, Readonly<{ x: number; y: number }>>
  width: number
  height: number
}> => {
  const identifiers = snapshot.nodes.map((node) => node.identifier).sort()
  const present = new Set(identifiers)
  const edges = snapshot.edges.filter(
    (edge) => present.has(edge.blocker) && present.has(edge.dependent),
  )
  const indegree = new Map(identifiers.map((identifier) => [identifier, 0]))
  const outgoing = new Map<string, string[]>(identifiers.map((identifier) => [identifier, []]))
  for (const edge of edges) {
    indegree.set(edge.dependent, (indegree.get(edge.dependent) ?? 0) + 1)
    outgoing.get(edge.blocker)?.push(edge.dependent)
  }
  for (const targets of outgoing.values()) {
    targets.sort()
  }
  const queue = identifiers.filter((identifier) => indegree.get(identifier) === 0)
  const layer = new Map(identifiers.map((identifier) => [identifier, 0]))
  const visited = new Set<string>()
  while (queue.length > 0) {
    queue.sort()
    const identifier = queue.shift()
    if (identifier === undefined) {
      break
    }
    visited.add(identifier)
    for (const dependent of outgoing.get(identifier) ?? []) {
      layer.set(dependent, Math.max(layer.get(dependent) ?? 0, (layer.get(identifier) ?? 0) + 1))
      const remaining = (indegree.get(dependent) ?? 1) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) {
        queue.push(dependent)
      }
    }
  }
  const lastLayer = Math.max(0, ...layer.values())
  for (const identifier of identifiers) {
    if (!visited.has(identifier)) {
      layer.set(identifier, lastLayer + 1)
    }
  }
  const columns = new Map<number, string[]>()
  for (const identifier of identifiers) {
    const column = layer.get(identifier) ?? 0
    const entries = columns.get(column) ?? []
    entries.push(identifier)
    columns.set(column, entries)
  }
  const positions = new Map<string, Readonly<{ x: number; y: number }>>()
  for (const [column, entries] of columns) {
    entries.sort()
    entries.forEach((identifier, row) =>
      positions.set(identifier, { x: 28 + column * 280, y: 30 + row * 150 }),
    )
  }
  return {
    positions,
    width: Math.max(320, (Math.max(0, ...columns.keys()) + 1) * 280),
    height: Math.max(190, ...[...columns.values()].map((entries) => entries.length * 150 + 30)),
  }
}

const runtimeStatus = (node: BacklogSnapshot['nodes'][number]): string => {
  if (node.readiness === 'cyclic') {
    return 'Cyclic'
  }
  if ((state?.running ?? []).some((entry) => entry.issue_identifier === node.identifier)) {
    return 'Running'
  }
  if ((state?.retrying ?? []).some((entry) => entry.issue_identifier === node.identifier)) {
    return 'Retrying'
  }
  const handoff = (state?.handoffs ?? []).find(
    (entry) => entry.issue_identifier === node.identifier,
  )
  if (handoff !== undefined) {
    return phaseLabels[handoffPhases[handoff.state] ?? 'handing_off']
  }
  if (node.readiness === 'completed') {
    return 'Completed'
  }
  return node.readiness === 'blocked' ? 'Blocked' : 'Ready'
}

/**
 * Draws the plan inside a bounded, scrollable stage. The stage's own size is whatever the layout
 * needs, but it lives inside a viewport with a capped height, so a large graph pans rather than
 * stretching the document.
 */
const renderGraph = (snapshot: BacklogSnapshot): void => {
  const graph = element('#dependency-graph')
  if (snapshot.nodes.length === 0) {
    graph.replaceChildren(text('p', 'empty', 'There are no dependency nodes.'))
    return
  }
  const layout = graphLayout(snapshot)
  const stage = document.createElement('div')
  stage.className = 'graph-stage'
  stage.style.width = `${layout.width}px`
  stage.style.height = `${layout.height}px`
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'graph-edges')
  svg.setAttribute('width', String(layout.width))
  svg.setAttribute('height', String(layout.height))
  svg.setAttribute('aria-hidden', 'true')
  for (const edge of snapshot.edges) {
    const start = layout.positions.get(edge.blocker)
    const end = layout.positions.get(edge.dependent)
    if (start !== undefined && end !== undefined) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const blocker = snapshot.nodes.find((node) => node.identifier === edge.blocker)
      path.setAttribute('class', blocker?.readiness === 'completed' ? 'satisfied' : 'active')
      const startX = start.x + 224
      const endX = end.x
      const middle = (startX + endX) / 2
      const startY = start.y + 48
      const endY = end.y + 48
      path.setAttribute(
        'd',
        `M ${startX} ${startY} C ${middle} ${startY}, ${middle} ${endY}, ${endX} ${endY}`,
      )
      svg.append(path)
    }
  }
  stage.append(svg)
  for (const node of snapshot.nodes) {
    const position = layout.positions.get(node.identifier)
    if (position === undefined) {
      continue
    }
    const status = runtimeStatus(node)
    const card = document.createElement('a')
    card.className = `graph-node state-${statusClass(status)}`
    card.href = node.url ?? '#'
    card.style.left = `${position.x}px`
    card.style.top = `${position.y}px`
    const reason = node.reason === null ? '' : `. ${node.reason}`
    card.setAttribute('aria-label', `${node.identifier}: ${node.title}. ${status}${reason}`)
    card.append(
      text('span', 'graph-state', status),
      text('strong', '', node.title),
      text('small', '', node.identifier),
    )
    if (node.reason !== null) {
      card.append(text('span', 'graph-reason', node.reason))
    }
    stage.append(card)
  }
  graph.replaceChildren(stage)
}
