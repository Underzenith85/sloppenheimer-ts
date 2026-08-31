# Symphony for TypeScript

A Node.js 24 and native TypeScript 7 implementation of the
[OpenAI Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md).

This repository contains a working orchestration core: strict workflow loading and Liquid prompt
rendering, a GitHub Issues tracker adapter, isolated workspaces and lifecycle hooks, a typed Codex
App Server JSONL client, polling and hot reload, concurrency limits, reconciliation, stall detection,
bounded exponential retries, and a loopback operator console. `WORKFLOW.md` is configured so this
implementation can dispatch Codex to improve itself from labeled GitHub issues.

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
`src/operator/ui/`, so all three are linted, formatted, and typechecked. The script is four files —
`model.ts` (the pure view model), `dom.ts` (browser primitives), `detail.ts` (the agent overlay) and
`app.ts` (the shell) — written as classic scripts rather than modules: none of them imports or
exports, so `tsconfig.browser.json` typechecks them as one program and the server concatenates them,
in that order, into the single classic script the page loads. `pnpm build` compiles them against a
DOM-only `tsconfig.browser.json` and writes the served assets into `dist/operator/ui/`; running from
source strips the same files' types in memory, so `pnpm dev` and the test suites need no build
first. Because oxlint reads one file at a time it cannot see a declaration another of those files
uses, so `no-unused-vars` is off for that directory alone; the compiler still catches real misuse.
The console's timeline categories come from `packages/core/src/telemetry.ts` at load time rather than being
restated in the browser script.

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
configuration may not reuse those names. Each eligible issue must carry the `symphony` label.
Workspaces live under `.symphony/workspaces` and are never treated as trusted paths until
containment checks pass. Containment is re-verified immediately before every agent launch, not only
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
ssh -L 3000:127.0.0.1:3000 symphony-host
```

Before a normal turn, Symphony prepares `symphony/issue-<number>` from the current protected base;
before a repair, it prepares the exact recorded pull-request head. The agent edits only ordinary
worktree files and receives no GitHub credential. After a successful turn, the host commits the
diff, rebases it onto the current protected base, verifies the remote head still matches the
captured lease, and pushes it with the host credential. An empty diff remains distinct from a
publication failure, and lease or authentication failures preserve the local work for retry.

Pull-request handoff is an extension the workflow turns on and off with `handoff.enabled`, which
defaults to `true`; everything in the rest of this section describes the enabled host. With it
disabled, Symphony composes no code-review services and follows the core continuation lifecycle
alone.

After publication, Symphony creates or reuses an open pull request and schedules the same short
continuation retry used when no branch exists. The handoff is observation-only: only a live worker
or queued retry owns the issue claim, and the refreshed tracker state plus routability decide
whether another worker starts. Dispatch labels remain unchanged. Pull-request inspection and merge
remain separate code-review operations and also use only the host-side credential.

After handoff, Symphony persists the PR under the workspace root and monitors its exact head SHA,
CI checks, mergeability, review decision, and unresolved review threads. Failed checks, requested
changes, stale branches, and conflicts return to the coding agent with repair context. A clean PR is
squash-merged only through the repository protection rules with an expected-head guard. The
operator console shows each active handoff, its current blocker, and why its issue is not
dispatchable when tracker eligibility prevents continuation. No handoff or pause transition removes
the Symphony label.

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
lifecycle notification, a request Symphony cannot serve, the turn timeout, or the session dying —
writes a settlement against that turn id, and the first write wins. A completion that arrives
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
so Symphony sends none. `test/installed-codex.integration.test.ts` asserts that against the
installed `codex app-server generate-json-schema` and fails as soon as such a field appears.

Three timeouts stay distinct. `codex.read_timeout_ms` bounds one request/response round trip.
`codex.turn_timeout_ms` is a _silence_ timeout for an active turn: every valid protocol output
re-arms it, so a long but active turn never expires while a genuinely silent one does.
`codex.stall_timeout_ms` is the orchestrator's own watchdog over a worker that stops reporting.

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
requires each implementation to document what it chose. Symphony answers all four server-initiated
requests, so nothing stalls waiting on an operator who is not there:

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
exists to establish. Symphony answers in the shape the protocol requires — so the turn proceeds
rather than stalling — while granting nothing beyond the sandbox already configured, and records a
`permissions_grant_withheld` event. Widening is an operator decision made in `WORKFLOW.md` through
`codex.turn_sandbox_policy`, where it is reviewable, not one made by the agent mid-turn.

`test/fixtures/fake-app-server.ts` is a deterministic stand-in used by the protocol suite; a
separate test compares the methods, policy values, and permission types this client sends against
`codex app-server generate-json-schema` when Codex is installed, and is inert when it is not, so no
machine-specific schema is committed.

## Operator console

The console answers four questions, and its navigation is the four answers with their counts:

| View                | What is in it                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Needs attention** | Operator-actionable exceptions: a stalled agent, a handoff needing repair or intervention, exhausted or failed handoff recovery, a dependency cycle, and high-priority work that is blocked.                                                                                                                                                                                    |
| **Ready**           | Dependency-cleared work that can be dispatched, ranked by priority, then by how many issues it unblocks, then by issue number.                                                                                                                                                                                                                                                  |
| **In progress**     | Starting, running, retrying, handing off, awaiting checks, ready to merge, and merging.                                                                                                                                                                                                                                                                                         |
| **Finished**        | Work this host merged and closed out in the last 24 hours. The scope is stated on the view — it is a window _and_ a lifetime, since completions live in the running host's state and a restart empties it. An item is dated by the provider's merge time rather than by when Symphony noticed it, so a pull request merged while the host was down does not reappear as recent. |

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
orchestration label and asks Symphony to reselect, so the control reads **Start agent** when a
dispatch slot is free and **Queue issue** when none is; the row then says which happened, and names
the limit that bound — the global `agent.max_concurrent_agents`, or the narrower
`agent.max_concurrent_agents_by_state` cap for that issue's state. The runtime publishes which states
are saturated, so the console never promises an immediate start for work the scheduler will queue.
The backlog and the runtime snapshot are fetched separately, so until the runtime half arrives
capacity is unknown rather than free, and the control reads **Queue issue** for the same reason. **Pause**
removes the issue from orchestration eligibility, cancels the agent running for it, and drops any
queued retry — it does not remove the Symphony label from the pull-request handoff lifecycle. Because
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

## Live agent inspection

Every running and retrying agent has a detail resource at
`GET /api/v1/agents/<url-encoded issue identifier>`, and each running and retrying entry in
`/api/v1/state` carries that link as `detailUrl`, identical to the `self` link inside the detail
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

Redaction happens at the parser, before anything is retained, not when a response is serialized: a
credential a message carried is gone before the timeline, a log, or an HTTP response can hold it.
One redactor serves both: the structural rules in `logging.ts` — secret-named keys in any quoting
style, `Authorization` and `Cookie` headers, bearer tokens, URL credentials, PEM blocks — composed
with shape-based patterns for values that are credentials on sight, such as provider tokens, AWS key
ids, and JWTs, wherever they appear. The resolved values of the environment variables the host
treats as secret — the tracker's own secret, plus `GITHUB_TOKEN`, `GH_TOKEN`, `OPENAI_API_KEY`, and
`CODEX_ACCESS_TOKEN` — are removed literally. Private reasoning is
never retained, not even truncated; tool input and output are reduced to byte counts; a command is
reduced to its program name, an argument count, and an allowlisted quality-phase label; a file
change is reduced to a workspace-relative path and its added and deleted line counts. Retention is
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

| Key                           | Default                                     |
| ----------------------------- | ------------------------------------------- |
| `tracker.required_labels`     | `[]`                                        |
| `tracker.active_states`       | `[open]`                                    |
| `tracker.terminal_states`     | `[closed]`                                  |
| `polling.interval_ms`         | `30000`                                     |
| `workspace.root`              | `<tmpdir>/symphony_workspaces`              |
| `hooks.timeout_ms`            | `60000`                                     |
| `agent.max_concurrent_agents` | `10`                                        |
| `agent.max_turns`             | `20`                                        |
| `agent.max_retry_backoff_ms`  | `300000`                                    |
| `codex.command`               | `codex app-server`                          |
| `codex.approval_policy`       | `never`                                     |
| `codex.thread_sandbox`        | `workspace-write`                           |
| `codex.turn_sandbox_policy`   | unset (host-derived workspace-write policy) |
| `codex.turn_timeout_ms`       | `3600000`                                   |
| `codex.read_timeout_ms`       | `5000`                                      |
| `codex.stall_timeout_ms`      | `300000` (`0` disables stall detection)     |
| `server.port`                 | unset (no operator console)                 |
| `handoff.enabled`             | `true` (pull-request handoff composed)      |

`codex.approval_policy` accepts `untrusted`, `on-request`, or `never`, and
`codex.thread_sandbox` accepts `read-only`, `workspace-write`, or `danger-full-access`; both are
Codex-owned values that must stay aligned with the generated App Server schemas.
`codex.turn_sandbox_policy` is an escape hatch: when set, the map is passed to `turn/start` as
`sandboxPolicy` verbatim instead of the host-derived workspace-write policy.

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
all absent; `handoffs.json` is neither read at startup nor written, so a store left by an earlier
handoff-enabled run survives untouched; and the provider's code-review tools are not advertised to
the agent. Everything else is unchanged — the host still prepares the workspace, commits, rebases,
and pushes the branch, because publication is a capability of its own rather than part of this
extension. With the extension enabled, a tracker provider that supplies no `CodeReviewPort` or no
`SourceControlPort` is an operator-visible `invalid_config` failure instead of a silently degraded
run.

Reload semantics: `handoff.enabled` is read once, at startup, when the composition root decides
which services to compose — the same point at which `server.port` is read. Editing it in a running
host does not take effect on the reload; restart the host. Every other key in the workflow, and the
handoff behaviour itself, continues to follow the reloaded definition.

### Workspace hooks

Each hook runs `bash -lc <script>` in the workspace directory as its own process group.

| Hook            | When                                                     | Failure                             |
| --------------- | -------------------------------------------------------- | ----------------------------------- |
| `after_create`  | Once, immediately after a workspace directory is created | Fatal — the workspace is not usable |
| `before_run`    | Before every agent launch                                | Fatal — the issue is retried        |
| `after_run`     | After every agent turn                                   | Best effort — logged and ignored    |
| `before_remove` | Before removing an existing workspace                    | Best effort — removal continues     |

`before_remove` runs only when the workspace directory is actually present, so a startup sweep over
closed issues does not execute it for workspaces that were never created.

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
string — including `codex.command` and hook scripts — is used literally, so a `$VAR` inside a hook
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
`SYMPHONY_INTEGRATION_REPOSITORY`, `GITHUB_TOKEN`, and
`OPENAI_API_KEY`/`CODEX_ACCESS_TOKEN` as skipped.
When a CI job explicitly sets `SYMPHONY_REAL_INTEGRATION=1`, missing credentials or integration
failures fail the job. The profile creates a uniquely named temporary workspace and removes it in a
`finally` block; its GitHub check is read-only and creates no tracker artifacts.

The complete bullet-to-test mapping is in
[the Section 17/18 conformance matrix](docs/conformance-matrix.md).

This project is independent of OpenAI and is not an official OpenAI distribution.
