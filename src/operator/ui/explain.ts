// What an agent detail snapshot means, in the operator's words. Nothing here touches the DOM: each
// function turns the published record into the one sentence, label or health verdict the overlay in
// `detail.ts` renders.

type AgentDetailSnapshot = import('@sloppenheimer/core/telemetry.js').AgentDetailSnapshot
type AgentTimelineEvent = import('@sloppenheimer/core/telemetry.js').AgentTimelineEvent

const describeEvent = (event: AgentTimelineEvent): string => {
  if (event.category === 'message') {
    const who = event.role === 'user' ? 'User message' : 'Agent message'
    return event.text === null ? who : `${who}: ${event.text}${event.truncated ? '…' : ''}`
  }
  if (event.category === 'reasoning') {
    return 'Thinking (private reasoning is never retained)'
  }
  if (event.category === 'tool') {
    const bytes = event.outputBytes === null ? '' : ` · ${event.outputBytes} output bytes`
    return `Tool ${event.name} · ${event.state}${bytes}`
  }
  if (event.category === 'command') {
    const exit = event.exitCode === null ? '' : ` · exit ${event.exitCode}`
    const quality = event.quality === null ? '' : ` · ${event.quality}`
    return `Command ${event.program} (${event.argumentCount} arguments)${quality} · ${event.state}${exit}`
  }
  if (event.category === 'file') {
    const added = event.addedLines ?? 0
    const deleted = event.deletedLines ?? 0
    const first = event.files[0]
    // One patch can touch many files. The first is named, because that is what an operator scanning
    // the timeline recognizes, and the rest are counted rather than listed — from the patch's own
    // count, which is larger than the named list whenever retention truncated it.
    const more = event.fileCount > 1 ? ` and ${event.fileCount - 1} more` : ''
    const named = first === undefined ? 'files' : `${first.change} ${first.path}${more}`
    return `${named} (+${added} / −${deleted}) · ${event.state}`
  }
  if (event.category === 'usage') {
    const tokens = event.tokens === null ? 'no token totals' : `${event.tokens.totalTokens} tokens`
    const limits = event.rateLimits
      .map((window) => `${window.name} ${window.usedPercent ?? 0}%`)
      .join(', ')
    return `Usage · ${tokens}${limits.length === 0 ? '' : ` · ${limits}`}`
  }
  if (event.category === 'retry') {
    const due = event.dueAt === null ? '' : ` · due ${formatTime(event.dueAt)}`
    const reason = event.reason === null ? '' : ` · ${event.reason}`
    return `Retry attempt ${event.attemptNumber}${due}${reason}`
  }
  if (event.category === 'error') {
    const code = event.code === null ? '' : ` [${event.code}]`
    return `${event.severity}${code}: ${event.message}`
  }
  if (event.category === 'cancellation') {
    return `Cancelled: ${event.reason}`
  }
  if (event.category === 'handoff') {
    const message = event.message === null ? '' : ` · ${event.message}`
    return `Handoff ${event.step.replaceAll('_', ' ')} · ${event.status}${message}`
  }
  const turn = event.turnNumber === undefined ? '' : ` · turn ${event.turnNumber}`
  return `${event.event}${turn}`
}

// The published snapshot carries absolute timestamps, so the console decides for itself whether the
// deadline has passed since the last fetch rather than waiting for the next one to say so.
const stalledNow = (snapshot: AgentDetailSnapshot): boolean => {
  if (snapshot.activity.stalled) {
    return true
  }
  return (
    snapshot.activity.stallDeadline !== null &&
    new Date(snapshot.activity.stallDeadline).getTime() <= Date.now()
  )
}

const idleNow = (snapshot: AgentDetailSnapshot): number => {
  if (snapshot.activity.lastActivityAt === null) {
    return Date.now() - new Date(snapshot.activity.startedAt).getTime()
  }
  return Date.now() - new Date(snapshot.activity.lastActivityAt).getTime()
}

const waitingExplanation = (snapshot: AgentDetailSnapshot): string => {
  if (snapshot.status === 'retrying' && snapshot.retry !== null) {
    const remaining = new Date(snapshot.retry.dueAt).getTime() - Date.now()
    const because =
      snapshot.retry.reason === null ? 'the attempt did not complete' : snapshot.retry.reason
    return `Retrying because ${because}. Attempt ${snapshot.retry.attempt} starts in ${formatClock(remaining)}.`
  }
  if (snapshot.status === 'completed') {
    return `The agent session has ended. ${snapshot.handoff.reason ?? 'No further work is scheduled.'}`
  }
  if (stalledNow(snapshot)) {
    return `Stalled: no protocol activity for ${formatClock(idleNow(snapshot))}.`
  }
  const operation = snapshot.phase.operation ?? telemetryLabel(snapshot.phase.phase)
  if (snapshot.activity.stallDeadline === null) {
    return `${operation}. Stall detection is disabled.`
  }
  const remaining = new Date(snapshot.activity.stallDeadline).getTime() - Date.now()
  return `${operation}. Considered stalled in ${formatClock(remaining)}.`
}

/** What the operator should expect to happen next, in one sentence. */
const expectedOutcome = (snapshot: AgentDetailSnapshot): string => {
  const handoff = snapshot.handoff
  if (!snapshot.handoffEnabled) {
    // This host composes no code-review services, so no pull request will be opened for the work.
    return snapshot.status === 'retrying'
      ? 'Handoff is disabled on this host. The next attempt runs on schedule and continues the issue.'
      : 'Handoff is disabled on this host. Sloppenheimer continues the issue itself rather than opening a pull request.'
  }
  if (handoff.outcome === 'merged') {
    return 'Merged. Nothing further is scheduled for this issue.'
  }
  if (handoff.outcome === 'delivery_failed') {
    return `The changes are in the workspace and not on the remote: ${handoff.publication.reason ?? 'the publication failed.'} Sloppenheimer retries the publication without running the agent again.`
  }
  if (handoff.outcome === 'no_progress') {
    return 'The turn left the workspace exactly as it found it, so there was nothing to publish and no pull request follows from it.'
  }
  if (handoff.outcome === 'intervention_required' || handoff.outcome === 'failed') {
    return `Needs a human: ${handoff.reason ?? 'the handoff could not complete on its own.'}`
  }
  if (handoff.outcome === 'pull_request_open') {
    const number = handoff.pullRequest.number
    return `A pull request${number === null ? '' : ` #${number}`} is open. Sloppenheimer watches its checks and reviews, repairs it when asked, and merges it once it is clean.`
  }
  if (handoff.outcome === 'no_branch') {
    return 'No branch was produced, so no pull request will be opened for this attempt.'
  }
  if (snapshot.status === 'retrying') {
    return 'The next attempt runs on schedule; the work so far is kept in the same workspace.'
  }
  return `On completion Sloppenheimer publishes ${handoff.expectedBranch ?? 'the issue branch'} with its host credential and opens a pull request for review.`
}

const detailHealth = (snapshot: AgentDetailSnapshot): Readonly<{ kind: string; label: string }> => {
  if (stalledNow(snapshot)) {
    return { kind: 'stalled', label: 'Stalled' }
  }
  if (snapshot.status === 'retrying') {
    return { kind: 'retrying', label: 'Retrying' }
  }
  if (snapshot.errors.length > 0) {
    return { kind: 'errors', label: `${snapshot.errors.length} errors reported` }
  }
  if (snapshot.status === 'completed') {
    return { kind: 'completed', label: 'Session ended' }
  }
  return { kind: 'healthy', label: 'Healthy' }
}
