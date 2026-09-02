# Sloppenheimer for TypeScript

A Node.js 24 and native TypeScript 7 implementation of the
[OpenAI Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md).

This repository contains a working orchestration core: strict workflow loading and Liquid prompt
rendering, a GitHub Issues tracker adapter, isolated workspaces and lifecycle hooks, a typed Codex
App Server JSONL client, polling and hot reload, concurrency limits, reconciliation, stall detection,
bounded exponential retries, and a loopback operator console. `WORKFLOW.md` is configured so this
implementation can dispatch Codex to improve itself from labeled GitHub issues.

Operational logs, traces, metrics, cardinality constraints, and suggested alerts are documented in
[Operational observability](docs/operational-observability.md).

## Requirements

- Node.js 24
- pnpm 11.24.0
- Git
- Codex CLI, authenticated for `codex app-server`
- A GitHub token in `GITHUB_TOKEN`

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
```

The codebase uses TypeScript 7's native compiler directly. Oxlint runs its native type-aware engine,
and Oxfmt enforces no-semicolon formatting. Strict compiler options, `no-explicit-any`, the
type-aware unsafe-operation rules, and mandatory braces are CI errors.

The operator console's markup, styles, and browser script live as real source files under
`src/operator/ui/`, so all three are linted, formatted, and typechecked. The script is nine files —
`model.ts` (the view model's vocabulary, orderings and fold), `items.ts` (one snapshot row to one
work item), `dom.ts` (browser primitives), `explain.ts` (an agent detail record in the operator's
words), `timeline.ts` (the event timeline and its filters), `detail.ts` (the agent overlay),
`cards.ts` (one work item, rendered, and the action on it), `graph.ts` (the dependency plan, drawn)
and `app.ts` (the shell) — written as classic scripts rather than modules: none of them imports or
exports, so `tsconfig.browser.json` typechecks them as one program and the server concatenates them,
in that order, into the single classic script the page loads. Splitting one of them is therefore
splitting a script rather than adding an import: the parts become new entries in the ordered list in
`src/operator/ui-assets.ts`, which is the only place that order is written down. `pnpm build`
compiles them against a DOM-only `tsconfig.browser.json` and writes the served assets into
`dist/operator/ui/`; running from source strips the same files' types in memory, so `pnpm dev` and
the test suites need no build first. Because oxlint reads one file at a time it cannot see a
declaration another of those files uses, so `no-unused-vars` is off for that directory alone; the
compiler still catches real misuse. The console's timeline categories come from
`packages/core/src/telemetry.ts` at load time rather than being restated in the browser script.

The console's own regression suite is deterministic and runs inside `pnpm check`: `test/operator/`
drives the exact published script under happy-dom, through the shared harness in
`test/harness/operator-console.ts` and one repository fixture in `test/harness/console-fixtures.ts`
covering blocked, cyclic, stalled, retrying, intervention-required, ready, running, awaiting-checks,
merged and completed work. Run it alone with `pnpm test test/operator`. There is no separate slower
browser suite to schedule.

The `effect`, `@effect/platform`, and `@effect/platform-node` versions are pinned as a compatible
Effect 3 set. Update them together: Platform releases declare Effect-line peer ranges, and a partial
upgrade can produce incompatible HTTP runtime types or behavior.

## Run

```sh
pnpm build
GITHUB_TOKEN=github_pat_... pnpm start -- WORKFLOW.md
```

The workflow path is optional and defaults to `WORKFLOW.md` in the current directory. The CLI
accepts at most one path and one `--port <0-65535>` override; invalid arguments and startup failures
exit nonzero with a concise error. `SIGINT` and `SIGTERM` initiate a scoped shutdown of polling,
watching, workers, hooks, App Server subprocesses, and the HTTP listener. Those finalizers run
concurrently, so the wall-clock cost of shutdown is the slowest single agent's teardown rather than
one teardown per active agent: the operator port is released and the host exits within the deadline
whatever `agent.max_concurrent_agents` is set to. A completed signal-driven shutdown exits zero,
while an abnormal host failure or a shutdown exceeding 10 seconds exits nonzero; that 10-second
watchdog is a last-resort failure path, not the bound cleanup is designed against.

Tracker credentials in repository-owned workflow files must use `$VAR` references; literal tracker
tokens are rejected. The host retains the reference's environment-variable name as secret
provenance, without making another plaintext token copy, and removes that name plus the GitHub
fallback aliases `GITHUB_TOKEN` and `GH_TOKEN` from Codex subprocess environments. Codex's own
`OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` authentication sources are always preserved, and tracker
configuration may not reuse those names. Each eligible issue must carry the `sloppenheimer` label.
Workspaces live under `.sloppenheimer/workspaces`, one directory per issue holding one directory
per dispatched run, and are never treated as trusted paths until containment checks pass. Containment is re-verified immediately before every agent launch, not only
at creation: the path must be a strict descendant of the configured root both as written and after
symlink resolution, and must be a real directory that still exists. The verified real path — not
the caller-supplied one — becomes the Codex subprocess cwd and the thread and turn `cwd`, so a
stale, forged, or substituted workspace can never be entered. Every executor, local or remote, goes
through the same invariant.

A path string is re-resolved by the kernel at every consumer, so verification alone is not enough:
a directory can be renamed and the path repointed between the check and the use. The host therefore
binds the verified directory's identity. It holds an open handle on it for the whole session, which
keeps the inode allocated so a directory deleted and recreated at the same path cannot reuse it,
and it re-confirms the device and inode at each path-consuming boundary — after the process is
created and before every turn — rejecting a directory whose identity changed.

The configured operator console is available at `http://127.0.0.1:3000`. It is organised around four
work states rather than around implementation surfaces — see [Operator console](#operator-console)
below. The browser never receives GitHub or ChatGPT credentials. Override the workflow port with
`--port 8080`, or use `--port 0` to select an ephemeral port.

The server deliberately binds only to loopback. From another machine, reach an LXC deployment with
an SSH tunnel:

```sh
ssh -L 3000:127.0.0.1:3000 sloppenheimer-host
```

Before a normal turn, Sloppenheimer prepares `sloppenheimer/issue-<number>` from the current
protected base; before a repair, it prepares the exact recorded pull-request head. The agent edits
only ordinary worktree files and receives no GitHub credential. After a successful turn, the host
commits the diff, rebases it onto the current protected base, verifies the remote head still matches
the captured lease, and pushes it with the host credential. An empty diff remains distinct from a
publication failure, and lease or authentication failures preserve the local work for retry.

Pull-request handoff is an extension the workflow turns on and off with `handoff.enabled`, which
defaults to `true`; everything in the rest of this section describes the enabled host. With it
disabled, Sloppenheimer composes no code-review services and follows the core continuation lifecycle
alone.

After publication, Sloppenheimer creates or reuses an open pull request and schedules the same short
continuation retry used when no branch exists. The handoff is observation-only: only a live worker
or queued retry owns the issue claim, and the refreshed tracker state plus routability decide
whether another worker starts. Dispatch labels remain unchanged. Pull-request inspection and merge
remain separate code-review operations and also use only the host-side credential.

After handoff, Sloppenheimer persists the PR under the workspace root and monitors its exact head
SHA, CI checks, mergeability, review decision, and unresolved review threads. Failed checks,
requested changes, stale branches, and conflicts return to the coding agent with repair context. A
clean PR is squash-merged only through the repository protection rules with an expected-head guard.

A review thread's resolution and its outdatedness are read as separate answers, because unresolved
feedback is not the same thing as feedback that still applies. Only unresolved threads GitHub still
raises against the inspected head reach a repair agent or count towards `repair_needed`; feedback
the head under inspection has already retired stays on the pull request, and the handoff's reason
records how much of it was withheld and where to read it. Withholding a thread never resolves it: a
thread is resolved only once GitHub has retired it against a head that then came back clean and
reviewed, whether Sloppenheimer, a human, or a restored handoff produced that head. Feedback GitHub
still raises against the head under inspection is outstanding work whoever wrote it, and is
repaired rather than resolved on the reviewer's behalf.
The operator console shows each active handoff, its current blocker, and why its issue is not
dispatchable when tracker eligibility prevents continuation. No handoff or pause transition removes
the Sloppenheimer label.

## Codex App Server client

The client speaks the App Server protocol over the subprocess's stdio: stdout carries protocol
framing only and stderr is diagnostic only, never parsed. Each is read as a stream that frames on
newlines and enforces the 10 MB framing limit on the _pending_ buffer, so an unterminated line is
rejected as a protocol error before it can grow without bound. The diagnostic stream assembles a
whole record before redaction — a multiline private key is swallowed until its end marker arrives —
so a credential split across a chunk boundary can never escape the redactor as an unkeyed fragment,
and a record still open when stderr closes is flushed rather than lost.

Ordering is not assumed. A pending request is registered before its line is written, so a response
can never arrive unowned. How a turn ended is one record per turn: whatever observes the end — a
lifecycle notification, a request Sloppenheimer cannot serve, the turn timeout, or the session dying
— writes a settlement against that turn id, and the first write wins. A completion that arrives
before its waiter exists is therefore not lost, a turn the server already reported keeps its own
result, and a later session-level error cannot relabel finished work. A process that exits or fails
to start settles every outstanding request and turn once, including the turn in flight, so no call
waits out its timeout after the session is already gone.

Malformed protocol data is reported as an event rather than ending the session. Session identity is
composed as SPEC §4.1.6 defines it: `sessionId` is `<threadId>-<turnId>`, so a continuation turn on
the same live thread reuses the thread id the App Server issued and gets a new session id. Thread
and turn identity stay separately visible through `threadId`, `turnId` and `turnCount`. The one
event with no turn half is `session_started`, emitted between `thread/start` and the first
`turn/start`: it names the thread alone rather than a turn that never ran, and its `message` is
null. Every event is attributed from the `threadId` and `turnId` the provoking message carries where
it has them, so a message that arrives before the response introducing those ids is still recorded
against the right turn, and a late event from a turn the run has moved past can restore neither
half of the identity.

SPEC §10.2 also asks for issue-identifying metadata "when the targeted protocol supports turn or
session titles". The App Server does not: neither `thread/start` nor `turn/start` accepts a title,
name, or label, and the `name` a thread reads back with is server-derived with no method to set it,
so Sloppenheimer sends none. `test/installed-codex.integration.test.ts` asserts that against the
installed `codex app-server generate-json-schema` and fails as soon as such a field appears.

Three timeouts stay distinct. `runner.read_timeout_ms` bounds one request/response round trip.
`runner.turn_timeout_ms` is a _silence_ timeout for an active turn: every valid protocol output
re-arms it, so a long but active turn never expires while a genuinely silent one does.
`runner.stall_timeout_ms` is the orchestrator's own watchdog over a worker that stops reporting.

The App Server runs in its own process group. Shutdown, cancellation and interruption signal the
whole tree — `SIGTERM`, then `SIGKILL` after a bounded grace — so tools the App Server itself
started are not left behind, and every outstanding request and turn settles exactly once.

Whether a tree is still alive is decided by process state, not by whether the group still answers a
signal: on Linux the group's members are read from `/proc`, and a group holding nothing but unreaped
zombies counts as dead. Without that, a host whose PID 1 does not reap orphans — a container, the
intended deployment target — would report a killed tree as alive forever and hold every escalation
open to its bound. Where `/proc` is unavailable the probe falls back to `kill(-pid, 0)` alone, which
may over-report liveness but never under-reports it, so a descendant that is still running is never
abandoned. The same rule governs the workspace hook trees.

Failures map onto stable categories: `spawn_failed`, `workspace_rejected`, `protocol_error`,
`read_timeout`, `turn_timeout`, `turn_failed`, `turn_cancelled`, `input_required`, and
`process_exited`.

### Trust and safety posture

SPEC §10.5 leaves approval, sandbox, and operator-confirmation behaviour implementation-defined and
requires each implementation to document what it chose. Sloppenheimer answers all four
server-initiated requests, so nothing stalls waiting on an operator who is not there:

| Request                                 | Response                     | Effect                    |
| --------------------------------------- | ---------------------------- | ------------------------- |
| `item/commandExecution/requestApproval` | `decision: acceptForSession` | auto-approved             |
| `item/fileChange/requestApproval`       | `decision: acceptForSession` | auto-approved             |
| `item/permissions/requestApproval`      | empty grant, `scope: turn`   | answered, nothing widened |
| `item/tool/requestUserInput`            | `-32000`                     | declined; the turn fails  |

Any other server-initiated request is declined with `-32601` and the session continues.

The first two match the high-trust example the SPEC sketches. The third is a deliberate departure:
a permissions request asks to widen the sandbox the thread was started with, and granting what it
asks would let the agent negotiate the containment that verifying the workspace before launch
exists to establish. Sloppenheimer answers in the shape the protocol requires — so the turn proceeds
rather than stalling — while granting nothing beyond the sandbox already configured, and records a
`permissions_grant_withheld` event. Widening is an operator decision made in `WORKFLOW.md` through
`runner.settings.turn_sandbox_policy`, where it is reviewable, not one made by the agent mid-turn.

`test/fixtures/fake-app-server.ts` is a deterministic stand-in used by the protocol suite; a
separate test compares the methods, policy values, and permission types this client sends against
`codex app-server generate-json-schema` when Codex is installed, and is inert when it is not, so no
machine-specific schema is committed.

## Operator console

The console answers four questions, and its navigation is the four answers with their counts:

| View                | What is in it                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Needs attention** | Operator-actionable exceptions: a stalled agent, a handoff needing repair or intervention, exhausted or failed handoff recovery, a dependency cycle, and high-priority work that is blocked.                                                                                                                                                                                                                 |
| **Ready**           | Dependency-cleared work that can be dispatched, ranked by priority, then by how many issues it unblocks, then by issue number.                                                                                                                                                                                                                                                                               |
| **In progress**     | Starting, running, retrying, delivering, handing off, awaiting checks, ready to merge, and merging. _Delivering_ is an agent that finished and whose change has not reached the remote: the work is in its workspace and the host is retrying the publication, with no agent running.                                                                                                                        |
| **Finished**        | Work merged and closed out in the last 24 hours. The scope is stated on the view, and it is the window alone: completions are persisted to `.sloppenheimer/completions.json`, so a restart inside the window no longer empties it. An item is dated by the provider's merge time rather than by when Sloppenheimer noticed it, so a pull request merged while the host was down does not reappear as recent. |

Every issue and handoff has exactly one primary placement, so no row appears twice. An **Inspect
agent** control appears only where the detail resource will answer: a handoff restored from the
store after a restart has a pull request to open but no agent session behind it, and the runtime
publishes which identifiers are inspectable rather than leaving the console to guess. Finished work
keeps the control for as long as its timeline is retained, so a post-mortem stays one click away. Attention
condition, pipeline phase, and orchestration eligibility are separate from that placement and are
shown as their own labelled chips — status is never carried by colour alone. Ordinary dependency
blocking is not an exception: blocked work is summarised under Ready ("_n_ issues are waiting on a
dependency"), enumerated in the complete work list, and laid out in the Plan view. The console opens
on Needs attention while an exception is live and on Ready otherwise, and an idle host collapses to
one system-health line rather than four empty panels.

Each Ready row says why it is ranked where it is — `P1 · unlocks 8 issues · ranked first`. The
`unlocks` count is computed by the backend from the dependency graph. It is a cascade, not plain
reachability: an issue is credited only with work whose _every_ unresolved blocker it clears, so work
held by two blockers counts for neither of them alone, and blockers already in a terminal state are
ignored.

Actions are named after what the backend does. Making an issue eligible adds the configured
orchestration label and asks Sloppenheimer to reselect, so the control reads **Start agent** when a
dispatch slot is free and **Queue issue** when none is; the row then says which happened, and names
the limit that bound — the global `agent.max_concurrent_agents`, or the narrower
`agent.max_concurrent_agents_by_state` cap for that issue's state. The runtime publishes which states
are saturated, so the console never promises an immediate start for work the scheduler will queue.
The backlog and the runtime snapshot are fetched separately, so until the runtime half arrives
capacity is unknown rather than free, and the control reads **Queue issue** for the same reason. **Pause**
removes the issue from orchestration eligibility, cancels the agent running for it, and drops any
queued retry — it does not remove the Sloppenheimer label from the pull-request handoff lifecycle. Because
pausing can interrupt live work, it asks for confirmation exactly when the issue is starting, running
or retrying. Every mutation reports pending, success and failure in the affected row, keeps a failure
attached to that row with a retry, cannot be submitted twice from one row, and survives the next poll.
Blocked work never offers a start control at all: it offers **View blockers**, which lists the
unresolved dependencies and can open the Plan view focused on that issue.

The dependency graph is not on the default dashboard. **Open dependency plan** reveals a secondary
Plan view with cycle diagnostics, a focus control that narrows to one issue with its immediate
blockers and dependents, and a complete text list of every dependency relationship. The graph itself
is drawn inside a bounded viewport that pans rather than growing the document, and on a small screen
the list stands in for it entirely.

The console is a single responsive layout: work is laid out as rows at desktop widths and as cards
below 768px, with title, state, reason and action kept together in both. There is a skip link into
the work queues, the state navigation is a tablist reachable before any planning content, all
primary controls clear a 44px touch target, and reduced-motion and forced-colors preferences are
respected. The agent overlay is `aria-modal`, and Tab and Shift+Tab cycle within it rather than
reaching the obscured page behind. `test/harness/accessibility.ts` runs a structural audit — accessible names, labelled
controls, tab/panel pairing, duplicate ids, forced tab order, heading levels, landmarks — over every
view, the Plan, and the open detail overlay at 390px, 768px and 1280px, and over the empty
dashboard. It is a structural audit rather than a browser-engine scan: happy-dom has no layout or
computed styles, so a contrast or overlap check there would be reporting on a page nobody sees.
Those remain a manual review.

## Operator HTTP API

The console's own data comes from the same versioned API a script can call. Every response carries
`Cache-Control: no-store` and the console's security headers, the server answers only loopback
`Host` headers (`421` otherwise), an unknown path is `404`, a wrong method is `405` with `Allow`,
and every refusal is the envelope `{"version":"v1","error":{"code","message"}}` with no backend
detail in it.

The API is one executable contract. `src/operator/api/endpoints.ts` defines every versioned endpoint
as an `@effect/platform` schema-backed `HttpApi` endpoint — its path, method, parameters, success
document and the statuses it may refuse with — and nothing else describes them. The handlers in
`src/operator/handlers.ts` are written against those definitions, each response is encoded through
the schema its endpoint declared before it is sent, and the `404`/`405` the server answers for a URI
no endpoint claims are derived from the same registrations. The schemas are annotated with the
published types beside them, so a mapping that stops agreeing with its own type fails the build
rather than reshaping a document quietly.

`GET /openapi.json` serves the OpenAPI description generated from those definitions. It sits outside
the versioned namespace deliberately: a name under `/api/v1/` would shadow an issue identifier
spelled the same way, and that namespace reserves exactly two (see below). The description carries no
`400`, because nothing this API reads can fail to decode — there is no request body, no query
parameter, and the one path parameter is an unconstrained string.

`GET /api/v1/state` publishes the SPEC 13.7.2 baseline document. That document is not the runtime's
internal record: it is snake_case, and it names a running row's issue `issue_id`,
`issue_identifier`, `issue_url` and `state`, and the aggregate counters `codex_totals` with
`seconds_running`. `src/operator/api.ts` is the one place that mapping happens. The internal
`OrchestratorSnapshot` keeps its own vocabulary, because the operator backend and the agent detail
path read it too, and a published name has no business travelling back into the scheduler.

| Baseline (13.7.2)                                                              | Sloppenheimer extension fields                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generated_at`, `counts`, `codex_totals`                                       | `workflow_path`, `effective_workflow`, `polling_interval_ms`, `max_concurrent_agents`, `rate_limits`                                                                                                                      |
| `running[]` with `issue_id`, `issue_identifier`, `issue_url`, `title`, `state` | `attempt`, `started_at`, `last_event_at`, `last_event`, `last_message`, `process_id`, `thread_id`, `turn_id`, `session_id`, `turn_count`, `tokens`, `last_reported_tokens`, `worker_host`, `stall_deadline`, `detail_url` |
| `retrying[]` with `attempt`, `due_at`, `error`                                 | the same identity, `worker_host` and `detail_url` as a running row                                                                                                                                                        |
| —                                                                              | `delivering[]`, `handoffs[]`, `completed[]`, `paused_issue_numbers`, `saturated_states`, `inspectable_agents`, `workflow_reload_error`, `handoff_recovery`                                                                |

`counts` carries `delivering` beside `running`, `retrying` and `completed`, and a `delivering[]`
row names the `branch_name` the work is owed to, the typed source-control `category` and `reason`
that held it, the `attempt` and `due_at` of the next publication, and `changed_file_count`. A row
here is Sloppenheimer saying the agent succeeded and the delivery did not — which neither a running
nor a retrying row can say.

The extension fields follow the baseline's convention, so a reader never has to know which half of
the document they are in. `rate_limits` is the exception and is passed through exactly as the coding
agent reported it: its keys belong to that protocol, not to this API.

`POST /api/v1/refresh` answers `202` with the suggested body:

```json
{
  "queued": true,
  "coalesced": false,
  "requested_at": "2026-08-31T09:00:00.000Z",
  "operations": [
    "credential_revalidation",
    "handoff_recovery",
    "workflow_reload",
    "handoff_reconciliation",
    "issue_reconciliation",
    "dispatch"
  ]
}
```

`operations` is what the pass that answered this request actually reached, reported by the pass
itself rather than restated by the HTTP layer: a pass whose credential or workflow validation failed
stops before `dispatch`, and its acknowledgement stops there too. `coalesced` is `true` when the
request joined a pass somebody else had already arranged, rather than bringing one into being, so a
burst of refreshes costs one poll rather than one each and the request that caused the poll is the
one told so. Sloppenheimer holds the response until that pass has finished — stronger than the `202`
the SPEC suggests — so a caller that reads `/api/v1/state` next sees the state the refresh produced.

`GET /api/v1/backlog` is the console's own endpoint rather than a SPEC route, and stays in the
internal vocabulary its consumer is written against.

### The two per-issue resources

`GET /api/v1/<url-encoded issue identifier>` is the SPEC 13.7.2 per-issue baseline, in the field
names the SPEC documents: `status`, `tracked`, `workspace.path`, `attempts.restart_count` and
`attempts.current_retry_attempt`, `running`, `retry`, `logs`, `recent_events`, and `last_error`,
with a `detail_url` pointing at the other one. Everything in it is sourced from the agent detail
record the runtime already publishes, so the two resources cannot disagree.

`GET /api/v1/agents/<url-encoded issue identifier>` is a documented **superset** rather than an
alias: it publishes the whole `AgentDetailSnapshot` — the complete timeline, the attempt and session
histories, per-category workspace and handoff detail — and it keeps the four distinguished outcomes
described under "Live agent inspection". Collapsing the two would cost either the baseline's
interoperability or the superset's precision, so both are published and `src/operator/api.ts` is the
single place internal records are mapped onto published names.

The two also differ on what counts as missing, deliberately. The baseline resource answers `404
issue_not_found` only for an identifier unknown to the current in-memory state, so an issue whose
work has moved to the pull-request handoff lifecycle resolves with `status: "handoff"` instead of
being reported absent — the host can disprove that absence. The superset keeps its narrower reading,
where an issue with no live agent session is `409 agent_not_active`, because that is the question an
inspector is asking.

Neither resource matches its identifier against a shape. `IssueIdentifier` is an unconstrained
branded string and the port boundary is tracker-neutral, so a tracker is free to spell one `GH-7`;
deciding syntactically which spellings are addressable would make both resources unreachable for a
provider whose identifiers carry no `#`. Existence is the only question, and in-memory state answers
it — which also keeps a published `detail_url` followable, since the link and its target read the
identifier the same way.

Three baseline fields are mapped rather than stored under those names. `workspace.path` publishes
the deterministic workspace key, not the host absolute path: the path is a filesystem detail the
console never needs, and the detail pipeline redacts it before retention, so there is no absolute
path to publish. `logs` is timeline retention accounting — retained, dropped, the bound, and how
many events this response carries — because Sloppenheimer retains a bounded, redacted event timeline
rather than raw agent logs. `tracked` says the orchestrator holds this issue as live work (starting,
running, retrying, or handed off) rather than as retained history.

### Two identifiers the versioned namespace cannot address

SPEC 13.7.2 places `GET /api/v1/state`, `POST /api/v1/refresh` and `GET /api/v1/{identifier}` at the
same level of one namespace, so an issue whose identifier is spelled exactly like a fixed **GET**
route is shadowed by that route. `GET /api/v1/backlog` is Sloppenheimer's own route and shadows a
second name the same way:

| Identifier | What `GET /api/v1/<identifier>` answers |
| ---------- | --------------------------------------- |
| `state`    | the runtime state document              |
| `backlog`  | the backlog document                    |

For such an issue the published `self` names a URL that answers for something else, and the
per-issue resource is unreachable. **The collision is documented as a known limit of the SPEC's
namespace and left unhandled**
([#220](https://github.com/Underzenith85/sloppenheimer-ts/issues/220)). It is inherent to the URL
design rather than to this host, and the two ways out both cost more than the collision does. Moving
the resource under a prefix such as `/api/v1/issues/{identifier}` changes the URL of a SPEC route —
the one thing a SPEC route may not do — and escaping the two names changes it for every identifier.
Both would be spent on identifiers no tracker profile can currently spell: `IssueIdentifier` is an
unconstrained branded string, but the only profile is GitHub, whose identifiers are
`owner/repo#number` and can never equal a bare word. Moving `/api/v1/backlog` alone, the one route
here Sloppenheimer owns, would resolve one of the two and not the one the SPEC forces. A tracker
profile whose identifiers could collide is what would reopen this.

`refresh` is not among them, though the same path is spelled by a fixed route. That route is
registered for POST alone rather than for every method, so the method distinguishes it from the
per-issue resource: `GET /api/v1/refresh` reads the issue identified that way, and `POST` refreshes.
The consequence is that a GET of that path no longer reports `405`; it answers as the per-issue
resource does, which for a host with no such issue is `404 issue_not_found`. A method neither route
serves is `405` naming both — `Allow: GET, POST` — since `Allow` states what the URI serves rather
than what one route does; the set is read from the registrations, so it stays true if another fixed
route comes to share a path. `agents` and `issues`
are addressable for a different reason — the routes that use those words carry a further segment.

`test/operator/server.test.ts` pins both halves — what each shadowed identifier answers, and that
the set has not silently grown. The second reads the endpoint definitions rather than the source that
spells them, taking each route's method as well as its path, since what reserves a name is a fixed
one-segment path reachable by GET. A third such route cannot be added without this decision being
taken again.

### Why a refresh needs the console's token

`POST /api/v1/refresh` requires the `X-Sloppenheimer-CSRF` header, so the plain empty-body POST SPEC
13.7.2 suggests receives `403 invalid_csrf_token`. **The requirement stands, as deliberate SPEC 15.5
hardening.** The server listens on loopback with no authentication, which means every page in the
operator's browser can reach it; a refresh is not a read — it spends tracker API quota and can
dispatch agents — so it is protected exactly like the start and pause controls. Dropping the header
for one mutating route would leave the console's other mutations defended and this one open.

A non-browser caller is not locked out, and needs no credential: the token is served in the console
page and is valid for the life of the process.

```sh
token=$(curl -s http://127.0.0.1:3000/ | sed -n 's/.*name="csrf-token" content="\([^"]*\)".*/\1/p')
curl -s -X POST -H "X-Sloppenheimer-CSRF: $token" http://127.0.0.1:3000/api/v1/refresh
```

The token is a forgery defence, not authentication: it proves the caller could read the console
page, which a cross-origin page cannot do. Anything that needs authentication belongs behind the
host, not behind this token.

## Live agent inspection

Every running and retrying agent has a detail resource at
`GET /api/v1/agents/<url-encoded issue identifier>`, and each running and retrying entry in
`/api/v1/state` carries that link as `detail_url`, identical to the `self` link inside the detail
itself. The console turns each live work card into an inspector: a phase header, elapsed time, last
activity, the stall countdown, an aggregate workspace summary, handoff progress, and what the agent
is expected to do next — which on a host that composes no code-review services says the continuation
lifecycle will run rather than promising a pull request that will never be opened. Process and worker identity, thread/turn/session identity, attempt and retry
timing, token totals and raw rate limits are one **Diagnostics** disclosure below that, available
without being the first thing an operator reads. The timeline has three presets — **Summary**, which
drops session handshakes, private reasoning, chat turns, individual tool calls and usage accounting
while keeping failures, retries, file changes, commands and handoff transitions; **Errors and
retries**; and **Everything** — with the full per-category filters still available under **Advanced
filters**. The panel is a modal overlay at every width, so opening it never displaces the queue row
it was opened from, and it contains keyboard focus while it is open. It has a copyable deep link
(`#/agents/<identifier>`), closes on `Escape` with focus returned to the card that opened it, and
polls on its own timer and its own request, so opening it cannot delay tracker polling or the
dashboard. Elapsed time and the stall countdown are recomputed in the browser from the absolute
timestamps the snapshot carries, so they stay live between fetches.

The four outcomes a detail request can have are distinguished rather than collapsed into one
"missing": `404 agent_not_found` for an identifier this session has never run, `409
agent_not_active` for an issue with no live session, `410 agent_session_completed` once a finished
session's timeline has aged out of retention, and `503 agent_detail_unavailable` while a dispatch is
still starting. A finished session that is still retained answers `200` with `status: "completed"`,
so a post-mortem is available for the most recent agents.

`/api/v1/agents/<identifier>` is a documented superset of the SPEC per-issue resource rather than
an alias of it; the Operator HTTP API section above says how the two divide.

Handoff detail tracks the expected branch, whether the remote branch was found, whether the pull
request was opened by this handoff or adopted from an existing one, its observed disposition through
merge, and the dispatch-label step. The GitHub adapter does not remove dispatch labels at handoff, so
that step reports `not_performed` with that reason instead of sitting pending forever.

Telemetry is one pipeline. The Codex client extracts session identity, token totals, rate limits,
turn count, and turn status once, and alongside them a bounded, already-redacted payload — the
timeline categories are session, reasoning, message, tool, file, command, usage, retry, error,
cancellation, and handoff. The orchestrator folds those events, plus the scheduling facts only it
knows, into actor-owned state; nothing re-derives what the client already reports. Snapshot requests
read an immutable index the actor publishes; no consumer touches a scheduler map, and a published
snapshot is frozen.

The workspace summary is folded from the file items alone, and one patch is counted exactly once.
A file-change item names every file it touched — the App Server reports a multi-file patch as one
item carrying a list — and it is reported twice, first as the patch the agent proposes and then as
the patch it applied. Only the applied report reaches the ledger: counting the proposal as well
would double every line, and a patch that failed or was declined never reached the worktree and is
not counted at all. Both reports still appear on the timeline, each carrying its own state, so an
attempt that was refused is visible rather than silently absent. The turn-level aggregate the App
Server also publishes is deliberately not folded, since it restates the same edits cumulatively
after every patch.

Redaction happens at the parser, before anything is retained, not when a response is serialized: a
credential a message carried is gone before the timeline, a log, or an HTTP response can hold it.
One redactor serves both: the structural rules in `logging.ts` — secret-named keys in any quoting
style, `Authorization` and `Cookie` headers, bearer tokens, URL credentials, PEM blocks — composed
with shape-based patterns for values that are credentials on sight, such as provider tokens, AWS key
ids, and JWTs, wherever they appear. The resolved values of the environment variables the host
treats as secret — the tracker's own secret, plus `GITHUB_TOKEN`, `GH_TOKEN`, `OPENAI_API_KEY`, and
`CODEX_ACCESS_TOKEN` — are removed literally. Private reasoning is
never retained, not even truncated; tool input and output are reduced to byte counts; a command is
reduced to its program name, an argument count, and an allowlisted quality-phase label; a patch is
reduced to one workspace-relative path per file it touched, each with the added and deleted line
counts its diff was counted for before that diff was discarded. Retention is
bounded per issue — 200 timeline events, 50 changed paths, 10 errors, 20 attempts and sessions — and
every retained string is cut to 240 characters. Truncation and dropped events are reported
explicitly rather than being silent.

## Configuration

`WORKFLOW.md` has YAML front matter followed by a strict Liquid template. Supported sections are
`tracker`, `polling`, `workspace`, `hooks`, `agent`, `codex`, `server`, and `handoff`. The current
tracker profile is GitHub Issues; the orchestration interfaces keep tracker and workspace concerns
separate so additional profiles can be implemented without weakening the domain types.

Unknown front-matter keys are preserved verbatim on `config.extensions` and otherwise ignored, so a
newer workflow file stays loadable on an older host without weakening required-field validation. A
value that cannot round-trip through JSON is the one thing such a key is rejected for, and it is
reported against the key that carried it.

The front matter is declared as a schema, so a rejected document is reported as one `invalid_config`
failure naming the key as the file spells it — `polling.interval_ms must be a positive integer` —
rather than as the first exception a decoder happened to throw.

### Defaults

| Key                           | Default                                  |
| ----------------------------- | ---------------------------------------- |
| `tracker.required_labels`     | `[]`                                     |
| `tracker.active_states`       | `[open]`                                 |
| `tracker.terminal_states`     | `[closed]`                               |
| `polling.interval_ms`         | `30000`                                  |
| `workspace.root`              | `<tmpdir>/sloppenheimer_workspaces`      |
| `hooks.timeout_ms`            | `60000`                                  |
| `agent.max_concurrent_agents` | `10`                                     |
| `agent.max_turns`             | `20`                                     |
| `agent.max_retry_backoff_ms`  | `300000`                                 |
| `runner.kind`                 | `codex`                                  |
| `runner.command`              | the selected runner's own default        |
| `runner.turn_timeout_ms`      | `3600000`                                |
| `runner.read_timeout_ms`      | `5000`                                   |
| `runner.stall_timeout_ms`     | `300000` (`0` disables stall detection)  |
| `runner.settings`             | `{}` (validated by the selected adapter) |
| `server.port`                 | unset (no operator console)              |
| `handoff.enabled`             | `true` (pull-request handoff composed)   |

### Selecting an agent runner

`runner.kind` selects the coding agent, the same way `tracker.kind` selects the issue tracker. The
four fields beside it are the ones the host consumes itself; `runner.settings` is preserved exactly
as authored and validated only by the adapter that owns the kind, so the host never has to know what
values a particular backend permits. `runner.command` defaults to that adapter's own launch command
(`codex app-server` for `codex`), because naming an executable is the one part of the neutral
configuration only the backend can supply.

For `kind: codex`, `runner.settings` accepts `approval_policy` (`untrusted`, `on-request`, or
`never`), `thread_sandbox` (`read-only`, `workspace-write`, or `danger-full-access`) — both
Codex-owned values that must stay aligned with the generated App Server schemas — and
`turn_sandbox_policy`, an escape hatch that is passed to `turn/start` as `sandboxPolicy` verbatim
instead of the host-derived workspace-write policy.

A top-level `codex:` block is the deprecated spelling of `runner: {kind: codex}`: its `command` and
three timeouts are the runner's own fields, and every other key it carries becomes `runner.settings`.
Every workflow written before `runner` existed therefore loads unchanged. Declaring both `runner`
and `codex` is a configuration error rather than a merge.

The runner is selected once, at startup. It holds no per-workflow state, so unlike the tracker it
has no cell to be replaced through: a reload may change everything about how it is configured, but a
reload that changes `runner.kind` is refused and the last known good workflow stays in force.

### Pull-request handoff

`handoff` owns the pull-request handoff extension the way `server` owns the HTTP status surface.

| Key               | Type    | Default | Validation                          |
| ----------------- | ------- | ------- | ----------------------------------- |
| `handoff.enabled` | boolean | `true`  | `handoff.enabled must be a boolean` |

A `handoff` that is not a map is rejected as `handoff must be a map`, and any other value for
`handoff.enabled` — including the string `"false"` — fails configuration validation rather than
being ignored, exactly as every other declared key does. An unknown key inside `handoff` is ignored,
as it is in every known section; an unknown top-level key is still preserved on
`config.extensions`.

The default is enabled because handoff is observation-only: a normal worker exit schedules the
continuation retry whether or not a pull request was opened, and no handoff holds an issue claim, so
the extension adds a lifecycle to observe rather than replacing the core one.

Setting `handoff.enabled: false` composes no code-review services at all. Branch detection, pull
request creation and adoption, check and review monitoring, protected merge, and repair dispatch are
all absent; neither `handoffs.json` nor `completions.json` is read at startup or written, so the
stores left by an earlier handoff-enabled run survive untouched; and the provider's code-review tools are not advertised to
the agent. Everything else is unchanged — the host still prepares the workspace, commits, rebases,
and pushes the branch, because publication is a capability of its own rather than part of this
extension. With the extension enabled, a tracker provider that supplies no `CodeReviewPort` or no
`SourceControlPort` is an operator-visible `invalid_config` failure instead of a silently degraded
run.

Reload semantics: `handoff.enabled` is read once, at startup, when the composition root decides
which services to compose — the same point at which `server.port` is read. Editing it in a running
host does not take effect on the reload; restart the host. Every other key in the workflow, and the
handoff behaviour itself, continues to follow the reloaded definition.

### Workspace allocation and leases

Every dispatched run and repair attempt receives its own workspace: `<root>/<issue key>/<run key>`,
where the run key names the run number and the host that allocated it. Two attempts on one issue
therefore share no worktree, no index and no ref store, and two hosts pointed at one root can never
name the same directory. The agent's cwd is the run directory; the host writes nothing inside it.

Ownership is a lease file beside the run directory rather than orchestrator memory, held for exactly
as long as the run it was allocated for: a workspace is handed out only inside the bracket that
releases it, so no ending can leave a lease nobody holds. Publishing that lease is the exclusive
claim: the record is written whole and hard-linked into place, and the kernel
refuses a link whose name already exists, so a duplicate dispatch fails before any process is
launched. The run directory is created only afterwards, so cleanup elsewhere never comes across a
workspace that has no lease. The record names the issue, the run, the host, its process id and when
that process started, and a run releases its lease on success, failure, cancellation and shutdown
alike.

A run that published its work leaves nothing behind. Every other ending — a failure, a cancellation,
or a composition with no source control to publish through at all — keeps the workspace and rewrites
its lease as a retained recovery artifact naming why it was kept, which is never adopted by a later
run: retained workspaces go when the issue reaches a terminal state, and cleanup skips any workspace
whose lease is still held by a running owner — this host, or a second one.

A lease is given up by the run that holds it, or taken from a host that can be seen to be gone. It is
never waited out. What this host holds is something it knows rather than something it reads back, so
a release whose write fails does not leave a workspace held for the life of the process. A lease left by a departed host stops holding anything back, because its process is
no longer there; so does one whose process id the kernel has since handed to a successor, which is
why the record carries the owner's start as well as its id. A process id means nothing outside the
namespace that issued it, so an owner is probed only when both sides name the same one — two
containers can share a kernel and a root while each sees only its own ids — and an owner this host
cannot place is left alone.

Left alone for good, which is the deliberate limit of the rule: on a shared root, a crashed peer's
workspaces stay as retained artifacts that cleanup reports and never takes, until an operator clears
them. The alternative is an expiry, and an expiry is one host deleting another's work on the strength
of a clock they do not share and a run length nothing bounds. A workspace left behind is untidy; a
workspace deleted from under a live run is gone.

Cleanup fences what it does take. Deciding a workspace is free and removing it are two steps with an
operator's `before_remove` hook between them, so the record is moved aside in one rename first and
the decision made again on what was actually taken — and put back if it turns out to still be held.

Directories are held still while they are acted through: opened, which pins the inode, and confirmed
by device and inode again before each step that creates, renames, executes in or removes. That
guards against the substitutions a host can stumble into — a path that resolves outside the root, a
symlink in the tree, a directory recreated under an inspected name — and not against a process with
write access to the root that is racing this one, which no check-then-act sequence could. The
workspace root is the host's own directory.

Unpublished work therefore does not travel from one attempt to the next in a shared worktree. A
normal run starts from its branch's own published head when the branch exists, and from the
protected base when it does not, so an attempt that ran out of turns is continued by the branch it
published; a repair still starts from the exact pull-request head it was dispatched against. Work an
attempt never published survives only in that attempt's retained workspace.

### After the turn: publication and delivery

A successful agent turn says one thing — the protocol finished — and Sloppenheimer treats it as
exactly that. After it, the host inspects the workspace against the baseline it recorded before the
launch, and publishes what it finds. The agent's own account of what it did is never consulted.

| The host found                             | What it reports                    | What happens next                                                                         |
| ------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Nothing: the worktree matches its baseline | `no_progress`                      | The handoff lifecycle continues; only this reading can conclude the agent changed nothing |
| A change, published                        | `published`, with the new commit   | The pull request is asked about, now that there is something on the remote to ask about   |
| A change it could not publish              | `delivery_failed`, with the reason | The workspace is retained and the publication alone is retried, with no agent running     |

That last row is the point. A publication failure is not an agent failure: the change is real, it is
still in the workspace, and repeating the turn would pay for it twice. Sloppenheimer retries the
delivery on its own backoff, up to a small limit, and only hands the work back to the agent when the
failure did not preserve the worktree or those attempts are spent. A restart does not carry the
delivery over: the run's workspace stays behind as a retained recovery artifact, kept under the
reason it was kept for, exactly as the workspace lifecycle above says — and it goes when the issue
is finished with.

Unpublished work is discarded in exactly one case: the issue is finished with. A cancellation that
removes the workspace drops the retained delivery in the same step, and a delivery that comes due
re-reads its issue first, so a closed issue never has a branch pushed for it after the fact.

### Workspace hooks

Each hook runs `bash -lc <script>` in the workspace directory as its own process group.

| Hook            | When                                                     | Failure                             |
| --------------- | -------------------------------------------------------- | ----------------------------------- |
| `after_create`  | Immediately after a run's workspace directory is created | Fatal — the workspace is not usable |
| `before_run`    | Before every agent launch                                | Fatal — the issue is retried        |
| `after_run`     | After every agent turn                                   | Best effort — logged and ignored    |
| `before_remove` | Before removing a run's workspace                        | Best effort — removal continues     |

A workspace belongs to one run, so `after_create` runs once per dispatched run rather than once per
issue, and `before_remove` runs once for each workspace a removal actually takes. `before_remove`
runs only when the workspace directory is actually present, so a startup sweep over closed issues
does not execute it for workspaces that were never created.

Both output streams are drained continuously, so a chatty hook cannot fill a pipe and hang; only a
bounded head of each stream is kept for diagnostics and is marked truncated when it overflows. A
hook that exceeds `hooks.timeout_ms`, or whose effect is interrupted, has its whole process tree
signalled — `SIGTERM` first, then `SIGKILL` after a bounded grace — so background grandchildren are
never left behind. Hook scripts are never written to the log, because they may embed credentials.

### Declared secret and path fields

`$VAR` indirection and `~` expansion apply only to fields that declare them. `workspace.root` is the
declared path field: it resolves a bare `$VAR` reference, expands a leading `~`, and resolves
relative values against the workflow file's directory. Each tracker adapter declares its own secret
fields; for GitHub that is `tracker.provider.token`, which must be a `$VAR` reference. Every other
string — including `runner.command` and hook scripts — is used literally, so a `$VAR` inside a hook
is expanded by the hook shell rather than by the loader.

Every one of these reads goes through Effect's `Config`, resolved against the `ConfigProvider` the
running fiber carries: the composition root supplies the process environment, and a test supplies
exactly the variables its case is about. A declared secret is read with `Config.redacted`, so the
resolved credential is wrapped from the moment it leaves the environment and is unwrapped only
where it is used — for GitHub, the `Authorization` header. A reference that resolves to nothing, or
to an empty value, is rejected as a missing environment variable.

### Adapter-owned provider configuration

`tracker.provider` is kept as the exact JSON object that was authored and is handed to the adapter
selected by `tracker.kind`; the core configuration layer never decodes provider-specific fields.
That holds for the types as well as the JSON: a validated selection carries its provider opaquely,
alongside the adapter's own equality and the environment names it resolved secrets from, so no
provider-specific type reaches the core. Each adapter owns the validation for its kind and
registers it in the composition root, which is also where the supported kinds are enumerated;
adding a kind changes no file under `packages/core/`.

Values that cannot round-trip through JSON are rejected. The GitHub adapter validates:

| Key            | Required | Default                  |
| -------------- | -------- | ------------------------ |
| `owner`        | yes      | —                        |
| `repository`   | yes      | —                        |
| `token`        | yes      | — (must be `$VAR`)       |
| `api_base_url` | no       | `https://api.github.com` |
| `base_branch`  | no       | `main`                   |

The adapter fails with `invalid_config` for an unsupported `tracker.kind`, a missing or empty
`owner`/`repository`/`token`, a literal (non-`$VAR`) token, a token that reuses Codex's own
`OPENAI_API_KEY` or `CODEX_ACCESS_TOKEN`, a `$VAR` reference whose environment variable is unset or
empty, or an `api_base_url` that is not an absolute `http(s)` URL. A trailing slash on
`api_base_url` is trimmed. Unknown provider keys are preserved and ignored.

The host removes the configured token's environment-variable name plus the GitHub fallback aliases
`GITHUB_TOKEN` and `GH_TOKEN` from Codex subprocess environments.

This validation runs at startup, on every workflow reload, and again as a dispatch preflight before
each agent launch. When the referenced variable resolves to a different value, the tracker is
rebuilt from the revalidated provider — including live workers and handoffs — so no request keeps
using a superseded credential.

## GitHub tracker adapter profile

**Configuration and secrets.** See the provider table above. `token` is the adapter's only declared
secret and must be a `$VAR` reference. The host keeps the reference's variable name as provenance
rather than a second plaintext copy, and strips that name plus `GITHUB_TOKEN` and `GH_TOKEN` from
Codex subprocess environments while always preserving `OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN`.

**Host-side tool profile.** A GitHub-backed session advertises three App Server dynamic tools. No
other adapter's tools are included. The profile, validated provider configuration, normalized issue
identity, and `nativeRef` are captured with the immutable session snapshot; model-authored arguments
cannot select a repository or issue. The tracker token stays in the host HTTP client and is absent
from the child environment, tool schemas, arguments, results, telemetry, and logs.

| Tool                       | Accepted arguments                                    | Host mutation                                                                    |
| -------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `github_add_comment`       | exactly `{ body }`                                    | `POST` one comment on the current issue                                          |
| `github_handoff_issue`     | one or more of `state`, `add_labels`, `remove_labels` | update open/closed state, add labels, and idempotently remove labels             |
| `github_link_pull_request` | exactly `{ pull_request_number }`                     | verify the in-repository PR, then add a current-issue comment containing its URL |

These are write tools: a valid invocation is authorization to perform the documented mutation with
the configured tracker credential. They do not expose arbitrary URLs, repository selection, issue
selection, comment deletion, label creation, PR editing, merging, or general GitHub API access.
Handoff operations run in state/add/remove order and are not transactional; an earlier mutation can
remain applied if GitHub rejects a later one. Removing a label that is already absent is successful.
Object keys, enum values, integer bounds, label arrays, and string bounds are checked exactly before
any request. Every call completes with a JSON-safe success/failure object. Failures distinguish
`invalid_arguments`, `missing_auth`, `authorization_failed`, `rate_limited` (including retry delay),
`transport_error`, `provider_error`, and `unsupported_tool`; malformed and unsupported calls are
answered immediately rather than leaving the App Server turn waiting.

**Scope.** Every request is scoped to `/repos/{owner}/{repository}` on the configured
`api_base_url`. Pagination links to a different origin are rejected, so the token is never sent
off-origin. Dispatch identity is the opaque issue number; native identity is
`{ node_id, issue_number, owner, repository }`. The core never parses either.

**Request limits and pagination.** List reads use `per_page=100`, follow only the `rel="next"` link,
reject a repeated URL as a cycle, and fail after 100 pages for one scoped read. Requests time out
after 30 s. Identity refresh and dependency hydration run at concurrency 4; state reads run one
state at a time. Dependency hydration is cached for 60 s per issue, keyed on the issue's
`updated_at`.

The `dependencyLabels` argument of a state-list read selects blocker hydration: `null` hydrates
every dispatch candidate, a list hydrates only candidates carrying all of those labels, and an empty
list hydrates none — which is what a startup terminal sweep wants.

**Normalization (Section 11.3).**

| Field                     | Source                          | Rule                                                        |
| ------------------------- | ------------------------------- | ----------------------------------------------------------- |
| `id`                      | `number`                        | Required positive integer, as an opaque string              |
| `nativeRef`               | `node_id` + provider scope      | Required                                                    |
| `identifier`              | provider scope + `number`       | `owner/repository#number`                                   |
| `title`                   | `title`                         | Required, non-empty                                         |
| `description`             | `body`                          | Nullable                                                    |
| `priority`                | `priority:1`–`priority:4` label | Nullable                                                    |
| `state`                   | `state`                         | Required, non-empty                                         |
| `branchName`              | —                               | Always `null` (GitHub issues carry no branch)               |
| `url`                     | `html_url`                      | Nullable; empty becomes `null`                              |
| `assigneeId`              | `assignee.login`                | Nullable; empty becomes `null`                              |
| `labels`                  | `labels`                        | Object or string entries, trimmed, lowercased, deduplicated |
| `blockedBy`               | `dependencies/blocked_by`       | Collection; scope-checked repository URLs                   |
| `dispatchable`            | provider eligibility            | `false` for pull requests, open blockers, or cycle members  |
| `createdAt` / `updatedAt` | `created_at` / `updated_at`     | Nullable; unparsable becomes `null`                         |

**Dispatchability.** The GitHub adapter derives blocker and dependency-cycle eligibility into
`dispatchable`; the generic scheduler combines that value only with configured required labels.
State-list reads still return every normalized record in scope, including `dispatchable=false`, so
the scheduler owns the final dispatch filter. Dependency hydration is skipped for pull-request
records. The operator backlog retains blocked and cyclic issues for readiness diagnostics while
excluding pull requests.

**Malformed records.** A malformed record in a state-list read is skipped with a warning naming its
index and reason; valid records on the same page are preserved. A malformed record in an identity
refresh fails the call, because the caller asked for that specific record.

**Portable error mappings.**

| Condition                                                                  | Category               | Retryable | Metadata                                                    |
| -------------------------------------------------------------------------- | ---------------------- | --------- | ----------------------------------------------------------- |
| Transport failure or timeout                                               | `tracker_request`      | yes       | —                                                           |
| `429`, or `403` with `Retry-After` or an exhausted `x-ratelimit-remaining` | `tracker_rate_limited` | yes       | `retryAfterMs` from `Retry-After`, else `x-ratelimit-reset` |
| `5xx`, `408`, `409`                                                        | `tracker_status`       | yes       | —                                                           |
| Other non-success status                                                   | `tracker_status`       | no        | —                                                           |
| Non-JSON or schema-violating payload                                       | `tracker_response`     | no        | —                                                           |
| Cyclic, off-origin, malformed or unbounded pagination                      | `tracker_pagination`   | no        | —                                                           |

## Conformance profiles

`pnpm test:conformance` runs the deterministic Core Conformance profile. The default `pnpm test`
also runs the shipped extension suites and never discovers real-integration tests.

`pnpm test:real-integration` runs the opt-in GitHub/Codex smoke profile. It reports missing
`SLOPPENHEIMER_INTEGRATION_REPOSITORY`, `GITHUB_TOKEN`, and
`OPENAI_API_KEY`/`CODEX_ACCESS_TOKEN` as skipped.
When a CI job explicitly sets `SLOPPENHEIMER_REAL_INTEGRATION=1`, missing credentials or integration
failures fail the job. The profile creates a uniquely named temporary workspace and removes it in a
`finally` block; its GitHub check is read-only and creates no tracker artifacts.

The complete bullet-to-test mapping is in
[the Section 17/18 conformance matrix](docs/conformance-matrix.md).

This project is independent of OpenAI and is not an official OpenAI distribution.
