export const appTemplate = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="__CSRF_TOKEN__">
    <title>Symphony Operator</title>
    <link rel="stylesheet" href="/styles.css">
    <script src="/app.js" defer></script>
  </head>
  <body>
    <div class="grain"></div>
    <main>
      <header class="masthead">
        <div>
          <p class="eyebrow"><span class="pulse"></span> Symphony / Operator</p>
          <h1>Conduct the work.</h1>
          <p class="lede">Move an issue into the score, watch agents play their parts, and intervene when needed.</p>
        </div>
        <button id="refresh" class="refresh" type="button">Refresh now</button>
      </header>

      <section class="metrics" aria-label="Runtime metrics">
        <article><span>Running</span><strong id="running-count">—</strong><small id="capacity">agents</small></article>
        <article><span>Retrying</span><strong id="retrying-count">—</strong><small>queued recoveries</small></article>
        <article><span>Completed</span><strong id="completed-count">—</strong><small>this session</small></article>
        <article><span>Tokens</span><strong id="token-count">—</strong><small id="runtime">runtime</small></article>
      </section>

      <section class="live-grid">
        <article class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Now playing</p><h2>Active agents</h2></div><span id="updated-at" class="timestamp">Waiting for state</span></div>
          <div id="running-list" class="work-list"><p class="empty">No agents are running.</p></div>
        </article>
        <article class="panel">
          <div class="panel-heading"><div><p class="eyebrow">On deck</p><h2>Recovery queue</h2></div></div>
          <div id="retry-list" class="work-list"><p class="empty">No retries are scheduled.</p></div>
        </article>
      </section>

      <section class="panel backlog-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">GitHub backlog</p><h2>Choose the next movement</h2></div>
          <p id="label-note" class="label-note">Loading orchestration label…</p>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Issue</th><th>Priority</th><th>Labels</th><th>Status</th><th><span class="sr-only">Action</span></th></tr></thead>
            <tbody id="backlog"><tr><td colspan="5" class="empty">Loading open issues…</td></tr></tbody>
          </table>
        </div>
      </section>
      <p id="notice" class="notice" role="status" aria-live="polite"></p>
    </main>
  </body>
</html>`

export const appJavaScript = String.raw`'use strict'

const element = (selector) => {
  const match = document.querySelector(selector)
  if (match === null) {
    throw new Error('Missing UI element: ' + selector)
  }
  return match
}

const csrf = element('meta[name="csrf-token"]').getAttribute('content') ?? ''
const notice = element('#notice')
let state = null

const text = (tag, className, value) => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = value
  return node
}

const request = async (path, options = {}) => {
  const response = await fetch(path, options)
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const message = payload?.error?.message ?? 'Request failed with HTTP ' + String(response.status)
    throw new Error(message)
  }
  return response.json()
}

const formatDuration = (seconds) => {
  if (seconds < 60) {
    return Math.round(seconds) + 's runtime'
  }
  const minutes = Math.floor(seconds / 60)
  return minutes + 'm ' + Math.round(seconds % 60) + 's runtime'
}

const formatTime = (value) => new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
}).format(new Date(value))

const renderWork = (container, entries, retrying) => {
  if (entries.length === 0) {
    container.replaceChildren(text('p', 'empty', retrying ? 'No retries are scheduled.' : 'No agents are running.'))
    return
  }
  const cards = entries.map((entry) => {
    const card = document.createElement('a')
    card.className = 'work-card'
    card.href = entry.url ?? '#'
    const copy = document.createElement('div')
    copy.append(text('strong', '', entry.title), text('span', '', entry.identifier))
    const detail = retrying
      ? 'Attempt ' + String(entry.attempt) + ' · ' + (entry.error ?? 'continuing')
      : (entry.lastEvent ?? 'Starting agent') + ' · ' + formatTime(entry.startedAt)
    card.append(copy, text('small', '', detail))
    return card
  })
  container.replaceChildren(...cards)
}

const renderState = (snapshot) => {
  state = snapshot
  element('#running-count').textContent = String(snapshot.counts.running)
  element('#retrying-count').textContent = String(snapshot.counts.retrying)
  element('#completed-count').textContent = String(snapshot.counts.completed)
  element('#capacity').textContent = 'of ' + String(snapshot.maxConcurrentAgents) + ' agents'
  element('#token-count').textContent = new Intl.NumberFormat().format(snapshot.totals.totalTokens)
  element('#runtime').textContent = formatDuration(snapshot.totals.secondsRunning)
  element('#updated-at').textContent = 'Updated ' + formatTime(snapshot.generatedAt)
  renderWork(element('#running-list'), snapshot.running, false)
  renderWork(element('#retry-list'), snapshot.retrying, true)
}

const action = async (issueNumber, enabled, button) => {
  button.disabled = true
  notice.textContent = enabled ? 'Adding issue to the score…' : 'Pausing issue…'
  try {
    await request('/api/v1/issues/' + String(issueNumber) + '/' + (enabled ? 'start' : 'pause'), {
      method: 'POST',
      headers: { 'X-Symphony-CSRF': csrf },
    })
    await request('/api/v1/refresh', { method: 'POST', headers: { 'X-Symphony-CSRF': csrf } })
    await Promise.all([loadState(), loadBacklog()])
    notice.textContent = enabled ? 'Issue enabled. Symphony is selecting work.' : 'Issue paused.'
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : 'The action failed'
  } finally {
    button.disabled = false
  }
}

const renderBacklog = (snapshot) => {
  element('#label-note').textContent = 'Controlled by the “' + snapshot.controlLabel + '” label'
  const body = element('#backlog')
  if (snapshot.issues.length === 0) {
    const row = document.createElement('tr')
    const cell = text('td', 'empty', 'There are no open issues.')
    cell.colSpan = 5
    row.append(cell)
    body.replaceChildren(row)
    return
  }
  const runningIds = new Set([
    ...(state?.running ?? []).map((entry) => entry.issueId),
    ...(state?.retrying ?? []).map((entry) => entry.issueId),
  ])
  const rows = snapshot.issues.map((issue) => {
    const row = document.createElement('tr')
    const issueCell = document.createElement('td')
    const link = text('a', 'issue-link', '#' + String(issue.number) + ' ' + issue.title)
    link.href = issue.url ?? '#'
    issueCell.append(link)
    const priority = text('td', '', issue.priority === null ? '—' : 'P' + String(issue.priority))
    const labels = text('td', 'labels', issue.labels.filter((label) => label !== snapshot.controlLabel).join(' · ') || '—')
    const live = runningIds.has(String(issue.number))
    const status = text('td', '', live ? 'In flight' : issue.enabled ? 'Enabled' : 'Backlog')
    status.append(text('span', 'status-dot ' + (live ? 'live' : issue.enabled ? 'enabled' : ''), ''))
    const actionCell = document.createElement('td')
    const button = text('button', issue.enabled ? 'action pause' : 'action start', issue.enabled ? 'Pause' : 'Start')
    button.type = 'button'
    button.addEventListener('click', () => action(issue.number, !issue.enabled, button))
    actionCell.append(button)
    row.append(issueCell, priority, labels, status, actionCell)
    return row
  })
  body.replaceChildren(...rows)
}

const loadState = async () => renderState(await request('/api/v1/state'))
const loadBacklog = async () => renderBacklog(await request('/api/v1/backlog'))

element('#refresh').addEventListener('click', async () => {
  notice.textContent = 'Refreshing Symphony…'
  try {
    await request('/api/v1/refresh', { method: 'POST', headers: { 'X-Symphony-CSRF': csrf } })
    await Promise.all([loadState(), loadBacklog()])
    notice.textContent = 'State refreshed.'
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : 'Refresh failed'
  }
})

Promise.all([loadState(), loadBacklog()]).catch((error) => {
  notice.textContent = error instanceof Error ? error.message : 'Could not load operator state'
})
setInterval(() => loadState().catch(() => undefined), 3000)
setInterval(() => loadBacklog().catch(() => undefined), 15000)
`

export const appStyles = String.raw`:root {
  color-scheme: dark;
  --ink: #f4f0e6;
  --muted: #9d9b93;
  --line: rgba(244, 240, 230, 0.12);
  --panel: rgba(21, 22, 21, 0.78);
  --acid: #d7ff64;
  --coral: #ff826b;
  background: #0b0c0b;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: radial-gradient(circle at 80% 0%, #28302a 0, transparent 34rem), #0b0c0b; min-height: 100vh; }
.grain { position: fixed; inset: 0; pointer-events: none; opacity: .16; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.22'/%3E%3C/svg%3E"); }
main { width: min(1480px, calc(100% - 48px)); margin: 0 auto; padding: 56px 0 80px; position: relative; }
.masthead { display: flex; align-items: end; justify-content: space-between; gap: 32px; margin-bottom: 44px; }
.eyebrow { color: var(--acid); text-transform: uppercase; letter-spacing: .16em; font: 700 11px/1.3 ui-monospace, monospace; margin: 0 0 13px; }
.pulse { display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: var(--acid); box-shadow: 0 0 0 5px rgba(215,255,100,.1); }
h1 { font: 500 clamp(48px, 8vw, 112px)/.86 Georgia, serif; letter-spacing: -.065em; margin: 0; max-width: 850px; }
.lede { color: var(--muted); max-width: 630px; font-size: 17px; line-height: 1.55; margin: 28px 0 0; }
button { font: inherit; }
.refresh, .action { border: 1px solid var(--line); border-radius: 999px; cursor: pointer; transition: .18s ease; }
.refresh { padding: 13px 20px; color: var(--ink); background: rgba(255,255,255,.04); white-space: nowrap; }
.refresh:hover { border-color: var(--acid); color: var(--acid); transform: translateY(-2px); }
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--line); border-radius: 18px; overflow: hidden; margin-bottom: 18px; background: var(--panel); backdrop-filter: blur(18px); }
.metrics article { padding: 24px; border-right: 1px solid var(--line); min-width: 0; }
.metrics article:last-child { border: 0; }
.metrics span, .metrics small { display: block; color: var(--muted); }
.metrics span { font-size: 12px; text-transform: uppercase; letter-spacing: .12em; }
.metrics strong { display: block; font: 500 44px/1 Georgia, serif; margin: 14px 0 9px; }
.metrics small { font-size: 12px; }
.live-grid { display: grid; grid-template-columns: 1.35fr 1fr; gap: 18px; margin-bottom: 18px; }
.panel { border: 1px solid var(--line); background: var(--panel); backdrop-filter: blur(18px); border-radius: 18px; overflow: hidden; }
.panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 25px 26px; border-bottom: 1px solid var(--line); }
.panel-heading .eyebrow { margin-bottom: 7px; }
h2 { font: 500 23px/1.1 Georgia, serif; margin: 0; }
.timestamp, .label-note { color: var(--muted); font-size: 12px; margin: 0; }
.work-list { min-height: 130px; }
.work-card { color: var(--ink); text-decoration: none; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 19px 26px; border-bottom: 1px solid var(--line); }
.work-card:last-child { border: 0; }
.work-card:hover { background: rgba(215,255,100,.04); }
.work-card strong, .work-card span { display: block; }
.work-card span, .work-card small { color: var(--muted); margin-top: 5px; font-size: 12px; }
.empty { color: var(--muted); text-align: center; padding: 42px 24px !important; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; min-width: 760px; }
th, td { padding: 17px 26px; text-align: left; border-bottom: 1px solid var(--line); font-size: 13px; }
th { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .13em; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: rgba(255,255,255,.018); }
.issue-link { color: var(--ink); text-decoration: none; font-weight: 600; }
.issue-link:hover { color: var(--acid); }
.labels { color: var(--muted); max-width: 280px; }
.status-dot { float: left; width: 7px; height: 7px; border-radius: 50%; margin: 5px 9px 0 0; background: #555; }
.status-dot.enabled { background: var(--acid); }
.status-dot.live { background: var(--coral); box-shadow: 0 0 0 5px rgba(255,130,107,.1); }
.action { padding: 8px 15px; min-width: 70px; }
.action.start { color: #111; background: var(--acid); border-color: var(--acid); }
.action.pause { color: var(--muted); background: transparent; }
.action:hover { transform: translateY(-1px); filter: brightness(1.08); }
.action:disabled { cursor: wait; opacity: .45; }
.notice { position: fixed; z-index: 2; bottom: 18px; right: 22px; margin: 0; padding: 10px 15px; border-radius: 999px; background: #252724; color: var(--muted); font-size: 12px; min-height: 34px; }
.notice:empty { display: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 900px) { .metrics { grid-template-columns: repeat(2, 1fr); } .metrics article:nth-child(2) { border-right: 0; } .metrics article:nth-child(-n+2) { border-bottom: 1px solid var(--line); } .live-grid { grid-template-columns: 1fr; } }
@media (max-width: 620px) { main { width: min(100% - 24px, 1480px); padding-top: 30px; } .masthead { display: block; } .refresh { margin-top: 24px; } .metrics { grid-template-columns: 1fr 1fr; } .metrics article { padding: 18px; } .metrics strong { font-size: 34px; } .panel-heading { align-items: flex-start; padding: 20px; } .label-note { max-width: 150px; text-align: right; } }
`
