// The published shape of the operator API. SPEC 13.7.2 names the baseline document a Sloppenheimer host
// serves from `/api/v1/state`, and it is not the runtime's internal record: it is snake_case, it
// calls a running row's issue `issue_id`, `issue_identifier` and `issue_url`, and it publishes the
// aggregate token counters as `codex_totals`.
//
// The mapping lives here, at the HTTP boundary, rather than in the runtime. `OrchestratorSnapshot`
// is also read by the operator console's own backend and by the agent detail path, so renaming its
// fields to match the wire would push a published vocabulary back into the scheduler. One function
// converts, once, and everything the server sends goes through it.
//
// Sloppenheimer publishes a superset of the baseline — handoffs, workflow reload state, handoff
// recovery, retained completions, saturated states — and those extension fields follow the same
// snake_case convention, so a reader never has to know which half of the document they are in.
//
// The per-issue resource 13.7.2 documents beside `/api/v1/state` is mapped here too, from the same
// snapshot and from the agent detail record the runtime publishes for that issue.
//
// The durable high-fidelity agent trace is published here too, from `api/trace.ts`. It is a
// separate resource rather than a section of the per-issue document on purpose: a whole session's
// messages, command output and tool payloads must be paged, and a document that carried them would
// have to be built in full before any of it could be sent.
//
// This module is the whole of that published surface and the only path anything imports; the
// documents it re-exports live beside it in `api/`, which is one module split for size rather than
// a boundary of its own.

export {
  issueDetailPath,
  publishedRecentEvents,
  publishIssueDetail,
  type PublishedIssueDetail,
  type PublishedIssueError,
  type PublishedIssueEvent,
  type PublishedIssueRetry,
  type PublishedIssueRun,
  type PublishedIssueStatus,
} from './api/issue.js'
export {
  publishRefresh,
  publishState,
  type PublishedCompleted,
  type PublishedHandoff,
  type PublishedRefresh,
  type PublishedRetrying,
  type PublishedRunning,
  type PublishedState,
} from './api/state.js'
export { type PublishedTokens, type PublishedTotals } from './api/tokens.js'
export {
  publishTrace,
  publishTraceEvent,
  tracePath,
  traceQueryFrom,
  traceStreamPath,
  type PublishedTrace,
  type PublishedTraceEvent,
  type PublishedTraceEviction,
  type PublishedTraceLimits,
  type PublishedTraceTruncation,
  type TraceQueryResult,
} from './api/trace.js'
