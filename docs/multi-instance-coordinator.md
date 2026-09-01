# Design: a multi-instance coordinator

Status: proposed. Supersedes nothing. This document is the architecture record for the coordinator;
do not open a separate ADR for it.

## What this adds

Today one Sloppenheimer host serves one operator console, bound to loopback, showing the work of the
one workflow that host is running. An operator running four hosts against four repositories runs four
consoles on four ports and holds the union in their head.

This design adds a **coordinator**: a separate service that aggregates every instance into one
operator surface and issues control actions against any of them. It is a second deployable with its
own frontend — React, Vite and TanStack Query — talking to its own backend, which is the only thing
that talks to instances.

The end state an operator sees is a single page that answers the same four questions the instance
console answers — what needs attention, what is ready, what is running, what finished — across every
instance at once, with `Start`, `Pause` and `Refresh` working on any row regardless of which host
owns it.

Instances remain independently operable. Nothing in this design makes an instance require a
coordinator, and the per-instance console at `/` keeps working exactly as it does now.

## Vocabulary

- **Instance** — one Sloppenheimer process, running one workflow against one tracker, serving the
  operator API described by SPEC 13.7.2 plus this repository's extensions.
- **Coordinator** — the new service. Holds the instance registry, polls each instance, publishes one
  aggregate document, and proxies control actions.
- **Instance console** — the existing per-instance UI in `src/operator/ui/`. Unchanged by this design.
- **Registry** — the coordinator's list of instances: identity, address, and credential.

## What the instance already gets right

Three existing decisions make this a bounded piece of work rather than a rewrite, and each is worth
protecting.

The published document is already a contract rather than an internal record. `src/operator/api.ts`
maps `OrchestratorSnapshot` to the snake_case wire shape at the HTTP boundary, and its header comment
argues explicitly for why the mapping lives there and not in the runtime. The coordinator consumes
`PublishedState`; it never sees a snapshot.

`PublishedState` (`src/operator/api.ts:101-134`) already carries the three fields identity and
freshness need: `generated_at`, `workflow_path`, and `effective_workflow.fingerprint`. A coordinator
can tell instances apart, and can measure how old a document is, without any new endpoint.

The classification logic is already pure and DOM-free. `buildWorkModel` in `src/operator/ui/model.ts`
is `(PublishedState, BacklogSnapshot, now) → WorkModel` — roughly 690 lines of attention, readiness
and ranking policy with no DOM access at all. That is the part of the console worth keeping, and it
is already in a shape that a second frontend can call.

## What blocks a coordinator today

Every one of these is a deliberate single-host decision, correctly made for the console that exists.
None of them extends.

| #   | Blocker                                                                                  | Where                                       |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| B1  | The server binds loopback unconditionally                                                | `src/operator/server.ts:16`                 |
| B2  | Any request whose `Host` header is not loopback is refused `421 invalid_host`            | `src/operator/server.ts:340-344`            |
| B3  | CSRF is a per-process token, obtainable only by loading that host's own HTML             | `src/operator/server.ts:161,355`            |
| B4  | There is no authentication of any kind — loopback binding _is_ the authorization model   | `src/operator/server.ts:112-119`            |
| B5  | `connect-src 'self'` means a page cannot fetch any origin but its own                    | `src/operator/server.ts:26-27`              |
| B6  | Nothing identifies an instance in a stable, operator-chosen way                          | `src/operator/api.ts:101-134`               |
| B7  | `buildWorkModel` is a classic script, not an importable module                           | `src/operator/ui/model.ts`                  |
| B8  | Elapsed time and stall countdowns are computed from `Date.now()` in the viewer's browser | `src/operator/ui/detail.ts:155-195,265,309` |

B8 is the one that is easy to miss and expensive to discover late. Those countdowns are correct today
because the browser and the host are the same machine. Across hosts with even a few seconds of clock
skew, a stall countdown renders wrong — and it renders wrong _confidently_, which is worse than
rendering nothing. D10 addresses it.

## Decisions

### D1 — The coordinator is a client of the published API, not a peer of the orchestrator

The coordinator composes no adapters, holds no tracker credentials, opens no worktrees, and links no
part of `packages/core`'s orchestration. Its only inputs are `GET /api/v1/state`,
`GET /api/v1/backlog`, and `GET /api/v1/agents/:identifier` from each registered instance; its only
outputs are the control endpoints those instances already publish.

This is what keeps an instance independently operable, and it means the coordinator cannot develop a
second, divergent opinion about what work is dispatchable.

Rejected: giving the coordinator direct access to instance state through a shared store or a
control socket. It would couple the coordinator to the runtime's internal record — precisely the
coupling `src/operator/api.ts` exists to prevent — and would make the coordinator a participant in
orchestration rather than an observer of it.

### D2 — The browser talks only to the coordinator; the coordinator talks to instances

The React app has exactly one origin: the coordinator. It never addresses an instance directly.

Four reasons, in order of weight. Instance credentials stay server-side rather than being handed to
every browser that loads the page. Each instance's CSP (`connect-src 'self'`, B5) stays as tight as it
is now, instead of being relaxed on every host to admit the coordinator's origin. Cross-origin CSRF
does not have to be solved once per instance. And partial failure becomes representable: the
coordinator knows an instance is unreachable and can say so, where a fanning-out browser would produce
N independent network errors with no shared vocabulary for them.

Rejected: browser-side fan-out. It is less code in the coordinator and considerably more everywhere
else, and it makes the security model N times larger for no gain.

### D3 — Identity is assigned by the registry and confirmed by the instance

An instance does not know what it should be called. Its own view of itself is a workflow path and a
fingerprint, neither of which is an operator-facing name. So the registry entry _is_ the identity:

```
{ id: "prod-api", label: "API service", baseUrl: "...", credential: "..." }
```

Every row in the aggregate is keyed by `(instanceId, issueIdentifier)`. Issue identifiers are only
unique within a tracker, and `#42` will exist in every repository an operator runs.

But an assigned identity that is never checked drifts silently: a host restarted against a different
workflow, or two registry entries pointing at one instance, should be visible rather than quietly
wrong. The coordinator therefore records `workflow_path` and `effective_workflow.fingerprint` from
each poll and surfaces a mismatch against what it last saw for that `id` as an operator-visible
condition. No new endpoint is needed for this — `PublishedState` already carries both.

Rejected: having instances self-report a configured name. It puts the same string in two places and
makes a duplicate name an instance-side configuration error discoverable only by the coordinator.

### D4 — Remote access is authenticated with a bearer credential; CSRF stays for the console

The current model is that loopback binding is the authorization: anything that can reach the port is
already on the machine, and CSRF (`src/operator/server.ts:112-119`) defends the operator's browser
session against a cross-site post. That model is correct and it cannot be stretched to authenticate a
remote caller, because there is no caller identity in it at all.

The instance gains two configuration keys and one rule:

- `server.bind` — the address to listen on, defaulting to `127.0.0.1` (unchanged behavior).
- `server.credential` — a shared secret, checked against `Authorization: Bearer …` with the existing
  constant-time comparison in `tokenMatches`.
- **A non-loopback `server.bind` without a credential is a startup error**, not a warning. The one
  thing this design must never permit is an unauthenticated control plane reachable from a network,
  arrived at by an operator changing one field.

The `Host` guard (B2) becomes a function of the configured bind rather than a constant.

Both mechanisms stay, because they defend different things. CSRF defends a browser session that
carries ambient credentials; bearer authenticates a machine caller that has none. A bearer-authorized
request skips the CSRF check, and safely: a cross-site request cannot set an `Authorization` header
without a CORS preflight the instance will not grant.

TLS is explicitly not the instance's job. Two supported deployments: an SSH tunnel, which the README
already documents at line 102 and which needs no instance change at all; or a reverse proxy
terminating TLS in front of the instance. The credential is what makes both safe against a caller who
reaches the port; it is not a substitute for transport encryption on an untrusted network, and the
documentation must say so plainly.

Rejected: mutual TLS. It is the better answer for a fleet and the wrong amount of ceremony for an
operator running four hosts. Rejected: reusing the CSRF token as a bearer credential. It rotates on
every process restart, so every restart would require re-registering the instance.

### D5 — Control actions are proxied, never reimplemented

`POST /issues/:n/start`, `/pause`, and `/refresh` on the coordinator resolve the owning instance,
forward to that instance's existing endpoint, and return the instance's own answer — including its
error codes. The coordinator adds no policy, no optimistic state, and no retry.

This keeps one definition of what pausing an issue means. The instance API stays the contract; the
coordinator is a router in front of it.

Rejected: batched or cross-instance actions ("pause everything") in v1. Each is a policy decision
about partial failure — three of five succeeded, now what — that deserves its own design rather than
being smuggled in as a convenience button.

### D6 — Staleness is per instance and always visible

This is the largest behavioral difference from the single-instance console, and the decision most
likely to be got wrong by default.

The instance console has one origin and one failure mode: either it is talking to its host or it is
not, and the operator can see which. An aggregate has N, and can be current for three instances and
four minutes stale for the fourth. Every instance therefore carries
`{ reachable, last_success_at, consecutive_failures, last_error }`, every row inherits its instance's
freshness, and rows from a stale instance are marked as stale in the UI — not merely dimmed.

The critical rule: **an unreachable instance's rows are retained and marked, never dropped**. Dropping
them makes "nothing needs attention" indistinguishable from "we cannot see whether anything needs
attention", which is the single most dangerous thing an operations dashboard can do. The instance
badge shows the age of the newest document the coordinator holds for it.

Note that the current console has a milder version of this bug already: `app.ts:850-861` swallows poll
failures with `.catch(() => undefined)`, so a backend that has been down for a minute looks exactly
like one that is idle. The coordinator must not inherit that.

### D7 — Classification runs in the coordinator, from the shared model

`buildWorkModel` moves into a package and the coordinator calls it once per instance, merging the
resulting `WorkModel`s into the aggregate. The React app receives work already classified into
attention / ready / blocked / progress / finished.

Two consequences worth stating. Classification cannot drift between the instance console and the
coordinator, because there is one implementation. And the browser never needs the raw instance
documents, so the wire stays proportional to the work rather than to N full `PublishedState`s.

The extraction runs into B7: `model.ts` is a classic script with no imports or exports, and the
instance console's whole delivery mechanism depends on that (`src/operator/ui-assets.ts` concatenates
four such files; `README.md:31-42` explains why). The proposal is to publish
`packages/operator-model` as a normal ESM module for the coordinator, and have the instance's asset
pipeline strip its export statements when inlining it — an extension of what
`scripts/copy-operator-ui.mjs` already does when it strips `export {};`. If that stripping ever
becomes fragile, the honest fix is to give the instance console a real bundler, and by then it will be
the secondary surface and the trade will look different.

Rejected: reimplementing classification in React. It is the product logic, it is 690 lines, and two
copies would diverge within a release. Rejected: shipping raw instance documents to the browser and
classifying there. It moves the N-way merge into the client and makes the payload N× larger for no
benefit.

### D8 — The aggregate is its own published document

The coordinator does not publish `Record<instanceId, PublishedState>`. It publishes a document shaped
around the question the coordinator exists to answer, which is not the question a single instance
answers:

```ts
type CoordinatorState = Readonly<{
  generated_at: string
  instances: readonly Readonly<{
    id: string
    label: string
    reachable: boolean
    last_success_at: string | null
    consecutive_failures: number
    last_error: string | null
    clock_skew_ms: number | null
    workflow_path: string | null
    workflow_fingerprint: string | null
    identity_drift: boolean
    capacity: Readonly<{ running: number; limit: number; full: boolean }> | null
  }>
  attention: readonly CoordinatorItem[]
  ready: readonly CoordinatorItem[]
  blocked: readonly CoordinatorItem[]
  progress: readonly CoordinatorItem[]
  finished: readonly CoordinatorItem[]
  alerts: readonly CoordinatorAlert[]
}>
```

where `CoordinatorItem` is the existing `WorkItem` plus `instance_id` and the freshness it inherited.
Alerts carry an `instance_id | null`, because a host-level exception now has to say which host.

Capacity does not aggregate into one number. `max_concurrent_agents` is per instance, and a global
"7 of 12 running" would imply a shared pool that does not exist. Capacity is reported per instance and
the UI presents it that way.

### D9 — There is no cross-instance priority

Within one instance, ranking is priority plus unlock count, and both are meaningful because they come
from one tracker. Across instances they are not comparable: priority 1 in a repository with three open
issues and priority 1 in one with two hundred are different claims, and nothing in the data says how
to weigh them.

So the coordinator does not invent a global priority. Attention items group by `AttentionKind` — the
severity class the model already assigns — and order within a class by how long the condition has
held. Ready items group by instance, each in that instance's own ranking. The UI states the grouping
rather than presenting a single ordered list that implies a comparison it cannot support.

Rejected: normalizing priorities across instances, and operator-assigned instance weights. Both
manufacture a total order out of data that does not contain one, and produce a ranking no one can
explain when asked why row four is above row five.

### D10 — Elapsed time is computed against instance time, not browser time

`generated_at` is the instance's own clock at the moment it produced the document. The coordinator
records, per instance, `clock_skew_ms` estimated as `generated_at − (received_at − rtt/2)`, and
publishes it. The React app applies the owning instance's skew when it renders any elapsed time,
countdown, or "how long ago".

This preserves the property that makes the current display good: the countdown ticks between fetches
because it is derived from absolute timestamps rather than waiting for the next poll.

Rejected: computing elapsed values in the coordinator at poll time. It is simpler, and it freezes
every timer between polls, which is a visible regression on the one screen an operator watches while
waiting. Rejected: ignoring skew and requiring NTP everywhere. It is true advice and it is not a
design; the failure it leaves is silent and wrong rather than loud.

### D11 — Polling first; streaming is a later, separate decision

The coordinator polls each instance independently, on the cadence the console already uses — state
every 3s, backlog every 15s — with jitter so N instances do not synchronize, and exponential backoff
on failure so an unreachable host is not hammered. The React app polls the coordinator through
TanStack Query.

Agent detail (`GET /api/v1/agents/:identifier`) is fetched **on demand only**, for the one issue whose
panel is open. It is the heaviest path at the shortest interval, and fanning it out across every
instance would multiply the load for data nobody is looking at.

Rejected, for now: SSE or WebSocket from coordinator to browser, and any push protocol from instance
to coordinator. Both are real improvements at a fleet size this design does not yet target, and both
are much easier to add once the aggregate document is settled than to design around before it is.

## Package layout

Three new units, all under `packages/` alongside the existing four:

- **`packages/operator-model`** — `buildWorkModel`, the `WorkItem`/`WorkModel` types, and the wire
  document types both surfaces read. No DOM, no Node, no orchestration. Consumed by the instance
  console (inlined, per D7) and by the coordinator (imported).
- **`packages/coordinator`** — the registry, the pollers, the aggregate document, and the control
  proxy. A server, following the repository's existing server conventions.
- **`packages/coordinator-ui`** — the React + Vite + TanStack Query app, built to static assets that
  `packages/coordinator` serves.

This is a departure from an accepted convention and should be recorded as one. `AGENTS.md` states
that the packages "are not built or released separately" and that they share "one deployable Symphony
executable". The coordinator is a second executable with its own lifecycle. That sentence needs
amending as part of this work rather than being quietly falsified.

The dependency direction extends cleanly:

```
core  <-  adapter-node  <-  adapters  <-  root application
operator-model  <-  coordinator  <-  coordinator-ui
operator-model  <-  root application (instance console)
```

`packages/operator-model` depends on nothing in the workspace, which is what lets both surfaces have
it. `test/package-boundaries.test.ts` should be extended to assert the new edges.

## What changes inside the instance

Deliberately small. Four things:

1. `server.bind` and `server.credential` configuration, with the rule from D4 that a non-loopback bind
   without a credential refuses to start.
2. Bearer authentication accepted alongside CSRF, and the `Host` guard (B2) made a function of the
   configured bind.
3. `buildWorkModel` sourced from `packages/operator-model` instead of living in
   `src/operator/ui/model.ts`, with the asset pipeline inlining it.
4. Nothing else. The console's markup, styles, routes, and behavior are untouched, and its test suite
   in `test/operator/` should pass unmodified through every phase below.

## Delivery phases

Each phase is independently valuable and independently revertible.

**Phase 0 — extract the model.** Move `buildWorkModel` into `packages/operator-model`; teach
`ui-assets.ts` and `copy-operator-ui.mjs` to inline it. Pure refactor, no behavior change, existing
console tests are the proof.

**Phase 1 — read-only aggregation over tunnels.** Registry, pollers, aggregate document, and a minimal
React app. Instances are reached through operator-established SSH tunnels, so no instance change is
needed yet; the coordinator obtains a CSRF token by reading the instance's own page, which is
serviceable precisely because it is temporary. Get D6 and D10 right here — freshness and skew are the
hard parts, and they are hard whether or not control exists.

**Phase 2 — authentication and remote binding.** The instance changes from D4. The coordinator's
instance client gains a credential strategy, and tunnel mode becomes one configuration of the same
code path rather than a special case.

**Phase 3 — control proxying.** Start, pause and refresh forwarded per D5. This is deliberately after
freshness, because a control plane over a view that might be silently stale is worse than no control
plane.

**Phase 4 — the console proper.** The full React surface: filtering, search, the detail panel,
per-instance capacity, keyboard navigation, and the accessibility contract the existing console holds
itself to in `test/operator/console-ux.test.ts`.

Read-only comes first even though the destination is a control plane. Aggregation and staleness are
where the design risk is; mutation is mostly plumbing once the view is trustworthy.

## Non-goals

- **Work routing.** The coordinator does not decide which instance picks up which issue. Each instance
  keeps its own backlog, its own dispatch policy, and its own concurrency limit. Turning instances into
  workers over a shared queue is a much larger design and is not this one.
- **Running agents.** The coordinator never launches a session, prepares a worktree, or holds a tracker
  credential.
- **Durable history.** v1 shows what instances currently publish. Retaining completed work across an
  instance restart means the coordinator acquires a store, and that is its own decision.
- **Multi-user access control.** One shared credential per instance, one operator. Per-user identity,
  roles, and an audit trail are a separate design if the coordinator ever leaves one operator's hands.
- **Replacing the instance console.** It remains the per-instance view and the reference implementation
  of the published document.

## Open questions

1. **Where the registry lives.** A YAML file beside the workflow definition, reloadable on change, is
   the closest fit to how this repository already handles configuration — but instance credentials in
   it means the same `$VAR` indirection the tracker configuration uses, not literals on disk.
2. **Version skew.** Two instances on different Sloppenheimer versions may publish different document
   shapes. The coordinator has to degrade — show what it can parse, mark the instance — rather than
   fail the whole aggregate. Whether instances should publish a version string for this, or whether
   structural tolerance is enough, is unsettled.
3. **Whether the coordinator should retain rows across an instance restart.** An instance loses its
   completed list when it restarts; a coordinator that remembers would be more useful and would need to
   decide what to do when the restarted instance disagrees with what it remembers.
4. **Whether `packages/coordinator-ui` belongs under `packages/`** at all, given it is an application
   rather than an architectural unit of the existing executable. An `apps/` root may be the more honest
   structure once there are two deployables.
