# Repository conventions

## Architecture and ports

The following port boundary was accepted in the 2026-08-30 architecture review:

- `TrackerPort` contains only tracker-neutral issue operations: fetching normalized issues, adapter-supplied dispatch eligibility, dependency hydration, tracker credentials, and issue-state operations expressed in tracker-neutral terms.
- Pull-request handoff is an optional application capability exposed through `CodeReviewPort`. It owns completed-work handoff and discovery of an existing handoff, inspection of a proposed change, protected merge, and review-thread resolution. The port may use honest pull-request and code-review vocabulary.
- Repository preparation and publication are a tracker-neutral application capability exposed through `SourceControlPort`. The host owns Git metadata and credentials, prepares normal work from the protected base and repairs from an exact pull-request head, commits agent file changes, rebases under policy, and pushes with an expected-head lease. Agents edit only worktree files. Source control must not be folded into `TrackerPort`, and pull-request inspection and merge remain in `CodeReviewPort`.
- GitHub supplies both `TrackerPort` and `CodeReviewPort`; other tracker providers are not required to simulate code-review concepts that they do not support.
- When handoff is enabled, a provider that does not supply `CodeReviewPort` is an operator-visible configuration error. When handoff is disabled, no `CodeReviewPort` is required and the application follows the core continuation lifecycle. This is the port-level convention for the configuration gate tracked in [#73](https://github.com/Underzenith85/symphony-ts/issues/73).
- `HandoffResult` belongs with `CodeReviewPort`, because its pull-request variant is a code-review concept rather than an issue-tracker concept.
- The composition root states that gate structurally: composing no code-review services at all is handoff disabled, and composing them is handoff enabled. The orchestrator therefore asks for `CurrentCodeReview` as an optional service, and reports the configuration error only when that service is present and the provider's factory supplies nothing.
- During implementation of this boundary, remove the unused `dispatchLabels` parameter from `handoffCompletedWork`; do not preserve it in either port.

This convention is the architecture record for the boundary. Do not create a separate ADR for it.

## Process-tree liveness

Accepted 2026-08-31, closing [#158](https://github.com/Underzenith85/symphony-ts/issues/158): the
`/proc` residual in `processGroupIsAlive` is accepted as it stands. No containment strategy is
adopted, and `src/support/subprocess.ts` remains the record of how the probe behaves.

The bound being accepted: `processGroupIsAlive` reads the group's membership from `/proc`, and a
dead verdict requires two consecutive passes that agree on the members they saw. The residual is a
member that forks and then dies inside the window between a pass's listing and its reads, in both
passes running, in a tree that has already been signalled to death. It is one-directional — the
probe never reports a live tree dead through any other path, and it never reports unknown
indefinitely, because passes that cannot agree within their bound read as alive and every caller
re-probes on a poll. The consequence if it ever fired is workspace cleanup proceeding, or a hook's
forceful escalation being cancelled, while a descendant still runs.

This is accepted rather than closed because the probe is strictly better than the signal probe it
replaced, the failure needs a fork-and-die inside a roughly 2 ms window twice consecutively, and
every remedy costs a host requirement Symphony does not otherwise have. Do not reopen this as a
`/proc` refinement: requiring each pass to have read every process it listed was measured in #153
and fails, because roughly a fifth of passes on a busy host see an unrelated process exit mid-pass,
the passes never agree, and the escalation timer is never cleared.

If it is revisited, the direction is recorded in #158 and is not another probe. Preferred: a
per-session transient systemd service (`systemd-run --pipe --wait --collect`), where
`KillMode=control-group` means the unit going inactive already implies an emptied cgroup, so the
question is removed rather than answered, and `RuntimeMaxSec` with `TimeoutStopSec` replaces the
hand-rolled escalation. Second: a per-tree cgroup v2 cgroup read through `cgroup.events`, where a
delegated writable subtree is available — an LXC system container with `Delegate=yes` supplies one,
Docker does not without `--privileged` or a bind-mount recipe, and Kubernetes and Fargate cannot.
Either way the seam belongs at spawn rather than at an `isAlive(pid)` probe, because a cgroup or a
unit has a lifetime that a query signature cannot express.

Two strategies from #158 are rejected outright. Stopping the group with `SIGSTOP` and `SIGCONT`
turns a read into a mutation at poll cadence, a crash between the two strands a stopped tree that no
longer answers `SIGTERM`, and it does not close the window anyway: a member mid-`fork` when the group
stop is delivered produces a child that was never a member at signal time and starts with an empty
pending set. The netlink proc connector needs elevated privileges, drops messages under load —
unsound exactly when the host is busy — and supplies events from which membership must be
reconstructed, with a race at subscribe time.

Independently of the verdict, workspace removal is safe against a straggler. `remove` renames the
workspace into a reserved trash root inside the workspace root and then sweeps that root, so the
canonical path is free the moment the rename returns and a process that survived termination is
writing somewhere the next attempt will never read. Deleting its files is no longer something that
has to succeed for the workspace to be gone, which is what makes the residual above cost disk
rather than correctness.

- The trash root is named so that no workspace key can collide with it. `workspaceKey` replaces
  every character outside `[A-Za-z0-9._-]`, so a name containing `@` is reserved by construction
  and needs no exclusion rule kept in step with the sanitizer.
- The sweep runs on every removal, including one that found no workspace, which is what clears an
  entry stranded by a host that died between the rename and the delete. Its failure is invisible:
  it costs disk until the next removal, never a caller that only asked for a workspace to go away.
- A rename that cannot be done falls back to deleting in place, so this is never worse than the
  direct removal it replaced.

## Repository structure

Symphony is intended to be a private pnpm workspace with these architectural package boundaries:

- `packages/core` contains domain types, ports, and orchestration policy. It must not depend on
  concrete adapters.
- `packages/adapter-github` contains the GitHub tracker and code-review implementations.
- `packages/adapter-codex` contains the Codex agent-runner implementation.
- The root application is the composition root for the CLI, operator server, configuration, and the
  single Symphony executable.

Package manifests must encode the dependency direction so that `packages/core` cannot import either
adapter package. These packages are architectural units, not independently published products. They
remain private and share one lockfile, CI pipeline, versioning policy, and deployable Symphony
executable.

Issues #84 and #86 establish the source layout and import rules first. Issue #109 then performs the
package migration without reopening those boundaries. If that migration is too large for one safe
pull request, split it into independently buildable steps; do not land a half-migrated workspace.

## Module import direction

The directories under `src/` are layers, and imports may only ever point downwards:

```
support/  <-  domain/  <-  ports/  <-  core/  <-  config/, operator/, adapters/, src/ root
```

- `support/` is the bottom layer. It may import only from `support/` itself and from third-party or
  Node packages.
- `domain/` may import from `support/` only.
- `ports/` may import from `domain/` and `support/` only.
- `core/` holds orchestration policy. It may import from `config/`, `ports/`, `domain/`, and
  `support/`, and it may never name a concrete adapter — it depends on a port and lets the
  composition root bind the implementation.
- `adapters/` is restricted as an import target, never as a source.
- The `src/` root is the composition root. It binds the concrete adapters and is unrestricted.

`.oxlintrc.json` enforces this with `no-restricted-imports` overrides, so `pnpm lint` — and
therefore `pnpm check` — fails on a violation. The groups match the import specifier as written
rather than its resolved target, so each layer takes two overrides:

- Every file in the layer, at any depth, is denied the sibling layers by name.
- Files directly in the layer are denied everything that leaves the layer, with the layers below
  re-admitted by negation. A directory added later is therefore forbidden until the rule names it.

The second rule cannot be extended to nested modules, because `../json.js` is a same-layer import
from `src/support/parsers/value.ts` and an escape to the `src/` root from `src/support/json.ts`.
Nested modules keep the first rule only, which trades an undetected import of a root module for
never rejecting a compliant one. Prefer flat layers.

`test/import-boundaries.test.ts` lints a fixture tree with that same configuration, at both depths,
and asserts the rule still fires.

Some vocabulary has not been placed in a layer yet: the modules #84 left at the `src/` root, and the
workflow configuration types that #88 declared the ports against. `core/`, `ports/`, and `domain/`
reach them through migration allow-lists in `.oxlintrc.json`, where each entry names the issue under
[#76](https://github.com/Underzenith85/symphony-ts/issues/76) that removes it. The entries name
files rather than directories, so the rest of each directory stays denied.

The `ports/` allow-list is `import type` only, enforced through the rule's `paths` option. #88
declared the ports as types, and an exemption that also admitted runtime values would let a port
acquire a real dependency on configuration or on root infrastructure under cover of the migration.
The `core/` allow-list is not so restricted: `core/` legitimately calls into those modules today.
The exemption covers the flat modules that exist now — a nested port has none.

The `domain/` allow-list is a single entry, `../errors.js`. #91 moved the workspace containment
rules into `domain/`, and they reject by constructing a `WorkspaceError`, so this one cannot be held
to `import type`. The error vocabulary is domain vocabulary that has not moved yet rather than root
infrastructure a domain module has no business calling; #109 removes the entry with the file.

Add to an allow-list only for a type that has not moved yet; never to admit an import of
`adapters/`, which stays denied at every tier.

## TypeScript and Effect

### Absence: `Option` versus `null`

Accepted 2026-08-30: use `null` at data boundaries and `Option` for internal control-flow absence.

- Use `null` in values that are serialized, persisted, logged, returned by the HTTP API, received
  from an external protocol, or represented as domain or wire records. Keep these values as
  ordinary JSON-shaped data.
- Use Effect's `Option` in internal service APIs, lookups, and partial computations when absence
  determines the next control-flow branch.
- Convert once at the architectural boundary. Do not carry `Option` into JSON-facing records, and
  do not carry a nullable result deeper into Effect-based orchestration when it represents a
  branch.
- Keep native `undefined` where JavaScript APIs inherently produce it, such as `Map.get` or an
  omitted optional property. Convert it to `Option` when it crosses into an internal service
  contract.

For example, `findPullRequest(...): Effect.Effect<string | null, TrackerError>` and
`refreshIssue: () => Effect.Effect<Issue | null, AgentError>` should use `Option<string>` and
`Option<Issue>` respectively. In contrast, wire-shaped `Issue` fields including `description`,
`branchName`, `url`, `createdAt`, and `updatedAt` should remain nullable, as should telemetry and
snapshot fields such as `AgentEvent.message`, `sessionId`, `HandoffSnapshot.headSha`, and `reason`.

This mixed style is intentional. It costs one explicit conversion at each architectural boundary,
but keeps serialized types honest and naturally JSON-compatible while making internal absence
composable with Effect.

### Time: read the clock, do not read the ambient one

Accepted 2026-08-31: an effect that needs the current instant reads it through Effect's `Clock`,
never through `Date.now()` or `new Date()`.

- `src/support/clock.ts` exports `currentInstant`, the `Clock.currentTimeMillis` read wrapped as a
  `Date`. Use it wherever the instant is carried as a `Date`, and `Clock.currentTimeMillis` directly
  wherever it is compared or added to as a number.
- Pure functions keep taking the instant as a parameter — `createSnapshot`, and the transitions in
  `src/core/transitions.ts`. The caller reads the clock; the function stays a function of its
  inputs, and none of them acquires a `Clock` dependency.
- `new Date(value)` stays where the instant comes from a value already in hand: a parsed wire
  timestamp, a restored snapshot, or a deadline derived from a recorded instant.
- `src/operator/ui/` is browser code with no Effect runtime and is outside this convention.

Tests therefore drive the whole orchestrator from `TestClock` — the clock `Effect.sleep` and
`Schedule` already run against — instead of waiting on the wall clock.
