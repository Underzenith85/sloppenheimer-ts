# Repository conventions

## Architecture and ports

The following port boundary was accepted in the 2026-08-30 architecture review:

- `TrackerPort` contains only tracker-neutral issue operations: fetching normalized issues, adapter-supplied dispatch eligibility, dependency hydration, tracker credentials, and issue-state operations expressed in tracker-neutral terms.
- Pull-request handoff is an optional application capability exposed through `CodeReviewPort`. It owns completed-work handoff and discovery of an existing handoff, inspection of a proposed change, protected merge, and review-thread resolution. The port may use honest pull-request and code-review vocabulary.
- Repository preparation and publication are a tracker-neutral application capability exposed through `SourceControlPort`. The host owns Git metadata and credentials, prepares normal work from the protected base and repairs from an exact pull-request head, commits agent file changes, rebases under policy, and pushes with an expected-head lease. Agents edit only worktree files. Source control must not be folded into `TrackerPort`, and pull-request inspection and merge remain in `CodeReviewPort`.
- GitHub supplies both `TrackerPort` and `CodeReviewPort`; other tracker providers are not required to simulate code-review concepts that they do not support.
- When handoff is enabled, a provider that does not supply `CodeReviewPort` is an operator-visible configuration error. When handoff is disabled, no `CodeReviewPort` is required and the application follows the core continuation lifecycle. The workflow key that selects between the two is `handoff.enabled`, read once by the composition root at startup ([#73](https://github.com/Underzenith85/sloppenheimer-ts/issues/73)).
- `HandoffResult` belongs with `CodeReviewPort`, because its pull-request variant is a code-review concept rather than an issue-tracker concept.
- The composition root states that gate structurally: composing no code-review services at all is handoff disabled, and composing them is handoff enabled. The orchestrator therefore asks for `CurrentCodeReview` as an optional service, and reports the configuration error only when that service is present and the provider's factory supplies nothing.
- During implementation of this boundary, remove the unused `dispatchLabels` parameter from `handoffCompletedWork`; do not preserve it in either port.

This convention is the architecture record for the boundary. Do not create a separate ADR for it.

## Agent runners

The agent-runner boundary was completed in [#214](https://github.com/Underzenith85/sloppenheimer-ts/issues/214),
against the design in `docs/agent-runner-claude-code.md`. This section is the architecture record for
it; do not create a separate ADR.

- A workflow selects its coding agent with `runner: {kind, settings}`, the same shape `tracker` uses.
  `settings` is preserved exactly as authored and validated only by the adapter owning the kind.
- `AgentRunnerConfig` carries only what the core consumes — `command`, `turnTimeoutMs`,
  `readTimeoutMs`, `stallTimeoutMs` — plus the opaque validated `settings`. A second backend adds no
  field to it. Backend policy values (Codex's approval policy and sandbox modes) are validated in
  that backend's adapter, never in `packages/core`.
- Each `AgentEvent` states its own `lifecycle`. The orchestrator must never recognize a session
  transition by matching a runner's event names: that was the defect #214 removed, and it fails
  silently rather than loudly. `AgentEventSemantics` was deleted rather than extended, because an
  event that carries its own meaning cannot be consulted for the wrong runner.
- `packages/core` names no backend. `test/runner-neutrality.test.ts` enforces that, with the
  `@codex review` handoff vocabulary as the one listed carve-out — that names a code-review
  provider, not the agent that authored the change.
- Authentication environment names belong to the registered runner, not to a core constant. The
  loader refuses a tracker credential that names the _selected_ runner's own authentication, since
  the host would have to both strip and preserve it.
- `src/agent-runners.ts` is the only file outside the adapters that names a concrete runner kind.
  Adding a backend is one entry there and no change under `config/` or `core/`.
- The runner is bound once at startup and has no cell: it holds no per-workflow state, so everything
  that varies reaches it on the launch. A reload may change how it is configured, but a reload that
  changes `runner.kind` is refused with an operator-visible error and the last known good workflow
  stays in force. Do not add a runner cell to make that reload succeed without a deliberate design
  decision about what happens to a session already running under the previous kind.

## Repository structure

Sloppenheimer is a private pnpm workspace. `pnpm-workspace.yaml` declares `packages/*` beside the
`allowBuilds` policy that gates postinstall scripts.

- `packages/core` (`@sloppenheimer/core`) contains domain types, ports, and orchestration policy. It
  depends on no adapter package.
- `packages/adapter-node` (`@sloppenheimer/adapter-node`) contains the host-platform adapters: the
  filesystem questions `FileSystem` does not answer, Git source control, workspace hooks, and the
  workspace manager. Both provider adapters build on it, which is why it is a package of its own
  rather than a directory inside either of them.
- `packages/adapter-github` (`@sloppenheimer/adapter-github`) contains the GitHub tracker,
  issue-control, code-review, and source-control implementations.
- `packages/adapter-codex` (`@sloppenheimer/adapter-codex`) contains the Codex agent-runner
  implementation.
- The repository root is the composition root: the CLI, the operator server, the workflow-definition
  loader, and the single `sloppenheimer` executable. It is the only package that names a concrete
  adapter.

The dependency direction is:

```
core  <-  adapter-node  <-  adapter-github, adapter-codex  <-  root application
```

Each manifest declares only the packages beneath it, and `test/package-boundaries.test.ts` asserts
that graph so a widened manifest fails `pnpm check` rather than passing quietly. The check is worth
having because pnpm installs the composition root's own dependencies at the repository root, and
Node's directory walk reaches them from inside every package: the manifests are what encode the
boundary, and `.oxlintrc.json` denies the import by name beside them.

These packages are architectural units, not independently published products. They stay private and
share one lockfile, one CI pipeline, one versioning policy, and one deployable Sloppenheimer
executable. They are not built or released separately.

The build is a TypeScript project graph. Each package emits `dist/` from its own `tsconfig.json`,
and `tsconfig.build.json` at the root references all four, so `pnpm build` is a single `tsc -b` that
orders them and then compiles the composition root into the `dist/` the `sloppenheimer` bin points
at. A package's `exports` resolves types to its TypeScript sources and the runtime entry to its
built JavaScript, which is why `pnpm lint`, `pnpm typecheck`, and `pnpm test` need no prior build.
The Vitest configurations alias `@sloppenheimer/*` back to source through `vitest.shared.ts` for the
same reason.

The tests stay in the root `test/` tree and run once, against the whole workspace, from the root
`pnpm check`. The three Vitest configurations select by test path, so a package split does not
change which tests each profile runs.

## Module import direction

The directories under `packages/core/src/` are layers, and imports may only ever point downwards:

```
support/  <-  domain/  <-  ports/  <-  core/  <-  config/
```

- `support/` is the bottom layer. It may import only from `support/` itself and from third-party or
  Node packages.
- `domain/` may import from `support/` only. It holds the error vocabulary and the host-tool
  vocabulary as well as the domain records.
- `ports/` may import from `domain/` and `support/` only.
- `core/` holds orchestration policy. It may import from `config/`, `ports/`, `domain/`, and
  `support/`, and it may never name a concrete adapter — it depends on a port and lets the
  composition root bind the implementation.
- The adapter packages are restricted as an import target, never as a source, and the root
  application is unrestricted.

`.oxlintrc.json` enforces this with `no-restricted-imports` overrides, so `pnpm lint` — and
therefore `pnpm check` — fails on a violation. The groups match the import specifier as written
rather than its resolved target, so each layer takes two overrides:

- Every file in the layer, at any depth, is denied the sibling layers by name, and every layer is
  denied `@sloppenheimer/**`.
- Files directly in the layer are denied everything that leaves the layer, with the layers below
  re-admitted by negation. A directory added later is therefore forbidden until the rule names it.

The second rule cannot be extended to nested modules, because `../json.js` is a same-layer import
from `support/parsers/value.ts` and an escape to the package root from `support/json.ts`. Nested
modules keep the first rule only, which trades an undetected import of a package-root module for
never rejecting a compliant one. Prefer flat layers.

`test/import-boundaries.test.ts` lints a fixture tree with that same configuration, at both depths,
and asserts the rule still fires.

One module has not been placed in a layer yet: telemetry. `packages/core/src/telemetry.ts` is its
whole public surface and the only path anything imports; the parts it re-exports live beside it in
`packages/core/src/telemetry/`, which is one module split for size rather than a layer of its own.
`core/` and `ports/` reach it through migration allow-lists in `.oxlintrc.json`, where the entry
names [#98](https://github.com/Underzenith85/sloppenheimer-ts/issues/98), which converts the
telemetry record to pure reducers and removes it. `ports/` also reaches the workflow configuration
types [#88](https://github.com/Underzenith85/sloppenheimer-ts/issues/88) declared it against, until
[#105](https://github.com/Underzenith85/sloppenheimer-ts/issues/105) settles that type surface.

Both `ports/` allow-list entries are `import type` only, enforced through the rule's `paths` option.
An exemption that also admitted runtime values would let a port acquire a real dependency on
configuration or on package-root infrastructure under cover of the migration. The `core/` allow-list
is not so restricted: `core/` legitimately calls into telemetry today.

#109 retired the rest. The error and host-tool vocabulary moved into `domain/`, where every layer
above reaches them with no exemption; the handoff store moved into `core/` beside the runtime that
is its only caller; and the workflow configuration split, so that the model `ports/` and `core/` are
written against lives in `packages/core/src/config/workflow.ts` while the loader that reads a
definition off disk stays in the composition root.

Add to an allow-list only for a type that has not moved yet; never to admit an import of an adapter
package, which stays denied at every tier.

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
