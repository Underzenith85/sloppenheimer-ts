# Repository conventions

This file describes how the code is written. `README.md` describes what the service does; the two
answer different questions, and neither substitutes for the other.

Every rule here is one the tree already follows. Where a rule is enforced, the enforcement is named,
so a reader knows which are checked and which are conventions held by hand.

This file is also the repository's decision record. The accepted decisions from the 2026-08-30
architecture review live in the sections below rather than in an ADR directory: the port boundary
([#81](https://github.com/Underzenith85/symphony-ts/issues/81)) under _Architecture and ports_, the
workspace package structure ([#82](https://github.com/Underzenith85/symphony-ts/issues/82)) under
_Repository structure_, the layering rule
([#86](https://github.com/Underzenith85/symphony-ts/issues/86)) under _Module import direction_, and
the `Option`-versus-`null` boundary
([#80](https://github.com/Underzenith85/symphony-ts/issues/80)) under _TypeScript and Effect_. Do
not add a parallel ADR tree; extend the section that owns the decision.

The prompt in `WORKFLOW.md` used to restate three of these rules inline. It now tells the dispatched
agent to read this file in the worktree it was given instead: three rules out of the dozens here is
an arbitrary privilege, the copy drifts from the original as soon as either moves, and the agent is
working in a checkout that contains this file.

## Toolchain

Node 24 and native TypeScript 7 only. `package.json` declares `engines.node >= 24` and pins
`typescript@7`, and nothing in the tree carries a TypeScript 6 compatibility shim: do not add one,
and do not reintroduce a construct only to keep an older compiler happy.

`tsconfig.base.json` is strict beyond `strict: true` — among others `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noImplicitReturns`,
`useUnknownInCatchVariables`, and `verbatimModuleSyntax`. An optional property therefore means
absent, not `undefined`, and an index read is `T | undefined` until it is narrowed. Write to the
compiler rather than around it: a cast that defeats one of these flags is the defect the flag exists
to find.

## How the code is written

- **Arrow consts, not `function` declarations.** Every top-level binding is an arrow const with an
  explicit type. The tree contains no `function` declaration at all; the keyword appears only as
  the generator `Effect.gen(function* () {...})` takes, which has no arrow form. `class` is
  reserved for the two places Effect asks for one — `Context.Tag` service tags and
  `Data.TaggedError` — plus the Codex connection, which owns a live subprocess and its pending
  requests.
- **Explicit return types on everything**, enforced by `typescript/explicit-function-return-type`.
  The signature is the contract; inference is for call sites, not for exports.
- **`Readonly<{...}>` on exported object types, `readonly` on their array members.** A domain value
  is a value: it is replaced, never mutated. `packages/core/src/support/json.ts` deep-freezes JSON
  conversion for the same reason, so a wire payload cannot be edited after it is built.
- **Tagged errors, never a bare `Error` for a domain failure.** Every failure is a
  `Data.TaggedError` in `packages/core/src/domain/errors.ts` carrying a closed `category` string
  union, and often a `retryable` flag. The closed union is what lets a caller match every case and
  the compiler notice when a new one appears; a `string` category would make that silent. The one
  `extends Error` in the tree, `JsonConversionError`, is not a counter-example: it marks a value the
  code should never have tried to convert, which is a defect rather than a typed failure.
- **Branded primitives for identifiers.** `IssueId` and `IssueIdentifier` are
  `Brand<string, ...>` and are constructed only through `issueId` and `issueIdentifier` in
  `packages/core/src/domain/domain.ts`. Do not cast a raw string into one anywhere else — the smart
  constructor is the only place the assertion is allowed to be made.
- **No `any`, braces around every control-flow body, `===`, no non-null assertion, exhaustive
  `switch`.** All five are oxlint errors, so `pnpm check` fails on them rather than a reviewer
  catching them.
- **Module and function size limits.** `max-lines` 500 and `max-lines-per-function` 100, on
  `src/**` and `packages/*/src/**`. The threshold is 100 rather than ESLint's default 50 because an
  `Effect.gen` pipeline is vertically expensive: each `Effect.matchEffect` branch costs six to eight
  lines of structure around one decision. `test/` is exempt, because the rule counts a `describe`
  callback as a function and would flag suite structure instead of complexity. Files that predate
  the rule are exempted one at a time in `.oxlintrc.json`, each entry naming the issue that removes
  it; new code is expected to comply.

## Tests

- **Real in-memory fakes, not mocking frameworks.** `test/harness/` holds fakes that implement the
  production interface — `fake-tracker.ts`, `fake-app-server.ts`, `fake-workspace-process.ts`, and
  the rest — and record the calls they receive so a test can assert against them. A fake that
  implements the port is checked by the compiler when the port changes; a mock is not.
- The two exceptions are honest ones: `test/subprocess-stream-errors.test.ts` and
  `test/adapters/codex/codex.test.ts` wrap `node:child_process` to inject a stream fault or observe
  a spawn, and both still call through to the real implementation. Reach for that only where a
  fault cannot be produced through the interface.
- **Effect tests run through `@effect/vitest`** — `it.effect` and `TestClock` — so a test drives the
  clock the orchestrator's `Effect.sleep` and `Schedule` already run against rather than waiting on
  the wall clock.
- Three profiles select by test path against one suite: `pnpm test` (everything but
  `test/real-integration/`), `pnpm test:conformance` (the SPEC subset), and
  `pnpm test:real-integration`. The tests live in the root `test/` tree and run once against the
  whole workspace, so a package split does not change which tests a profile runs.

## The `pnpm check` gate

`pnpm check` is `format:check && lint && typecheck && test && build`:

- `oxfmt --check .` — formatting is not a review topic; run `pnpm format` and move on.
- `oxlint --type-aware --deny-warnings` — a single warning fails the gate, so a rule cannot be
  added before the code complies with it.
- `tsc --noEmit` for the workspace, and again for `tsconfig.browser.json`, which typechecks the
  operator console's classic scripts as one program.
- `vitest run`.
- `tsc -b tsconfig.build.json`, the browser build, and the operator-console copy.

It is the whole gate: a change is finished when `pnpm check` passes, and CI runs the same command.

## Architecture and ports

The following port boundary was accepted in the 2026-08-30 architecture review:

- `TrackerPort` contains only tracker-neutral issue operations: fetching normalized issues, adapter-supplied dispatch eligibility, dependency hydration, tracker credentials, and issue-state operations expressed in tracker-neutral terms.
- Pull-request handoff is an optional application capability exposed through `CodeReviewPort`. It owns completed-work handoff and discovery of an existing handoff, inspection of a proposed change, protected merge, and review-thread resolution. The port may use honest pull-request and code-review vocabulary.
- Repository preparation and publication are a tracker-neutral application capability exposed through `SourceControlPort`. The host owns Git metadata and credentials, prepares normal work from the protected base and repairs from an exact pull-request head, commits agent file changes, rebases under policy, and pushes with an expected-head lease. Agents edit only worktree files. Source control must not be folded into `TrackerPort`, and pull-request inspection and merge remain in `CodeReviewPort`.
- GitHub supplies both `TrackerPort` and `CodeReviewPort`; other tracker providers are not required to simulate code-review concepts that they do not support.
- When handoff is enabled, a provider that does not supply `CodeReviewPort` is an operator-visible configuration error. When handoff is disabled, no `CodeReviewPort` is required and the application follows the core continuation lifecycle. The workflow key that selects between the two is `handoff.enabled`, read once by the composition root at startup ([#73](https://github.com/Underzenith85/symphony-ts/issues/73)).
- `HandoffResult` belongs with `CodeReviewPort`, because its pull-request variant is a code-review concept rather than an issue-tracker concept.
- The composition root states that gate structurally: composing no code-review services at all is handoff disabled, and composing them is handoff enabled. The orchestrator therefore asks for `CurrentCodeReview` as an optional service, and reports the configuration error only when that service is present and the provider's factory supplies nothing.
- During implementation of this boundary, remove the unused `dispatchLabels` parameter from `handoffCompletedWork`; do not preserve it in either port.

This convention is the architecture record for the boundary. Do not create a separate ADR for it.

## Agent runners

The agent-runner boundary was completed in [#214](https://github.com/Underzenith85/symphony-ts/issues/214),
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

Symphony is a private pnpm workspace. `pnpm-workspace.yaml` declares `packages/*` beside the
`allowBuilds` policy that gates postinstall scripts.

- `packages/core` (`@symphony/core`) contains domain types, ports, and orchestration policy. It
  depends on no adapter package.
- `packages/adapter-node` (`@symphony/adapter-node`) contains the host-platform adapters: the
  filesystem questions `FileSystem` does not answer, Git source control, workspace hooks, and the
  workspace manager. Both provider adapters build on it, which is why it is a package of its own
  rather than a directory inside either of them.
- `packages/adapter-github` (`@symphony/adapter-github`) contains the GitHub tracker, issue-control,
  code-review, and source-control implementations.
- `packages/adapter-codex` (`@symphony/adapter-codex`) contains the Codex agent-runner
  implementation.
- The repository root is the composition root: the CLI, the operator server, the workflow-definition
  loader, and the single `symphony` executable. It is the only package that names a concrete
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
share one lockfile, one CI pipeline, one versioning policy, and one deployable Symphony executable.
They are not built or released separately.

The build is a TypeScript project graph. Each package emits `dist/` from its own `tsconfig.json`,
and `tsconfig.build.json` at the root references all four, so `pnpm build` is a single `tsc -b` that
orders them and then compiles the composition root into the `dist/` the `symphony` bin points at. A
package's `exports` resolves types to its TypeScript sources and the runtime entry to its built
JavaScript, which is why `pnpm lint`, `pnpm typecheck`, and `pnpm test` need no prior build. The
Vitest configurations alias `@symphony/*` back to source through `vitest.shared.ts` for the same
reason.

The tests stay in the root `test/` tree and run once, against the whole workspace, from the root
`pnpm check`. The three Vitest configurations select by test path, so a package split does not
change which tests each profile runs.

## Module import direction

The directories under `packages/core/src/` are layers, and imports may only ever point downwards:

```
support/  <-  domain/  <-  ports/  <-  core/  <-  config/
```

- `support/` is the bottom layer: JSON, logging, redaction, collections, the clock read, schema
  combinators. It may import only from `support/` itself and from third-party or Node packages, and
  it knows nothing about issues, trackers, or agents.
- `domain/` may import from `support/` only. It holds the domain records and the vocabulary
  everything above is written in: the tagged errors, the branded identifiers, the handoff snapshot,
  the host-tool and provider vocabulary. No effects that reach the world.
- `ports/` may import from `domain/` and `support/` only. A port is a record-of-functions type plus
  the `Context.Tag` that names it, and nothing else: the interface the core depends on and an
  adapter satisfies.
- `core/` holds orchestration policy — the runtime, the event loop, dispatch, the transitions, the
  handoff lifecycle. It may import from `config/`, `ports/`, `domain/`, and `support/`, and it may
  never name a concrete adapter: it depends on a port and lets the composition root bind the
  implementation. That single rule is the drift this whole programme removed, and it is one careless
  import away from coming back.
- `config/` holds the workflow model the layers below are written against.

Above the core package, the same direction holds between packages rather than directories. The
adapter packages — `adapter-node`, `adapter-github`, `adapter-codex` — implement ports and are
restricted as an import target, never as a source: nothing in `packages/core` may name one. The
repository root is the composition root and is unrestricted, because binding a port to an
implementation is exactly its job. Under it, `src/config/` loads a workflow definition off disk,
`src/operator/` serves the console and its HTTP API, `src/composition.ts` and the two adapter
registries build the layers, and `src/cli.ts` runs them.

`.oxlintrc.json` enforces this with `no-restricted-imports` overrides, so `pnpm lint` — and
therefore `pnpm check` — fails on a violation. The groups match the import specifier as written
rather than its resolved target, so each layer takes two overrides:

- Every file in the layer, at any depth, is denied the sibling layers by name, and every layer is
  denied `@symphony/**`.
- Files directly in the layer are denied everything that leaves the layer, with the layers below
  re-admitted by negation. A directory added later is therefore forbidden until the rule names it.

The second rule cannot be extended to nested modules, because `../json.js` is a same-layer import
from `support/parsers/value.ts` and an escape to the package root from `support/json.ts`. Nested
modules keep the first rule only, which trades an undetected import of a package-root module for
never rejecting a compliant one. Prefer flat layers.

`test/import-boundaries.test.ts` lints a fixture tree with that same configuration, at both depths,
and asserts the rule still fires.

One module has not been placed in a layer yet: `packages/core/src/telemetry.ts`. `core/` and
`ports/` reach it through migration allow-lists in `.oxlintrc.json`, where the entry names
[#98](https://github.com/Underzenith85/symphony-ts/issues/98), which converts the telemetry record
to pure reducers and removes it. `ports/` also reaches the workflow configuration types
[#88](https://github.com/Underzenith85/symphony-ts/issues/88) declared it against, until
[#105](https://github.com/Underzenith85/symphony-ts/issues/105) settles that type surface.

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

### Dependency injection: `Context` and `Layer`

A service is acquired from the Effect context, never handed down as a parameter. The dependency
record the orchestrator once took — `OrchestratorDependencies` — is gone, and so is injection
through a default parameter. Neither may come back: both let a caller pass one implementation while
the rest of the tree reads another, and neither is visible in a type.

- Every port declares a `Context.Tag` beside its interface in `packages/core/src/ports/`, and the
  code that needs it writes `yield* CurrentTracker`. What an effect requires shows up in its `R`,
  so a module that quietly acquires a new dependency cannot typecheck without saying so.
- The composition root builds the layers. `src/composition.ts` merges the adapter services,
  `src/tracker-adapters.ts` and `src/agent-runners.ts` are the only files that name a concrete kind,
  and `src/cli.ts` provides the result — plus `NodeFileSystem.layer` and the GitHub HTTP client —
  around the whole program.
- A capability that may be absent is asked for with `Effect.serviceOption`. The orchestrator takes
  `CurrentCodeReview` that way, so composing no code-review services at all _is_ handoff disabled;
  there is no separate flag for the core to consult.
- The environment is read through `Config` against whatever `ConfigProvider` the fiber carries.
  `Effect.withConfigProvider(ConfigProvider.fromEnv())` in `src/cli.ts` is the one line that says
  "the process environment", and the one line a test replaces.
- Tests provide test layers rather than patching modules: a fake from `test/harness/` is composed in
  where the adapter would be, and the suite runs the same wiring the host does.

### State: a `Ref` with pure transitions

Actor-owned state lives in one `Ref` holding one immutable value, and every change to it is a pure
function applied through `Ref.update` or `Ref.modify`.

- `packages/core/src/core/state.ts` declares `RuntimeState`; `transitions.ts` holds the transitions
  as ordinary functions of `(state, ...) => state`. They read no clock and perform no effect: the
  caller reads the instant and passes it in.
- Telemetry recorders are the same shape — `recordAttemptStarted`, `recordHandoff`, and the rest
  return a new record rather than mutating the one they were given.
- A reader therefore sees one coherent value. Do not introduce a record of mutable containers, and
  do not export a mutable type. The one `MutableRef` in the tree is `sessionPorts` on a running
  entry, which a host tool reads synchronously from a callback that has no fiber to suspend in; it
  is written only by the transition that adopts new ports.

### Decoding: `Schema`, not `throw`

External input is decoded with `effect/Schema` at the boundary it arrives on, and a rejection is a
typed failure rather than a thrown value or a defect.

- Workflow definitions, GitHub payloads, the persisted handoff snapshot, and the Codex protocol and
  telemetry payloads each have a schema; `packages/core/src/support/schema.ts` holds the combinators
  the protocol formats share.
- A `ParseError` is mapped onto the tagged error the caller already handles — `WorkflowError` with
  category `invalid_config`, a `TrackerError`, a `HandoffStoreError` — using
  `ParseResult.ArrayFormatter` to state which field was wrong. A decode never reaches a caller as a
  `ParseError`.
- Configuration and protocol are decoded with different tolerances, deliberately. A configuration
  document is Symphony's own and is rejected outright when it is wrong. A protocol payload comes
  from another program at a version Symphony does not pin: a record that is not a record fails, but
  a field that is missing or malformed reads as absent, so one unexpected field does not fail the
  turn that carried it.

### Runtime entry: one place leaves Effect

`Effect.runPromiseExit` in `src/cli.ts` is the only place the application enters the Effect runtime.
`runSync`, `runPromise`, or a fork from an arbitrary module is a defect: it starts a second runtime
with none of the host's context, outside the scope that would interrupt it on shutdown.

Three call sites cross back from a foreign boundary, and each runs on a runtime it was handed rather
than a fresh one:

- `packages/core/src/core/startup.ts` captures `Effect.runtime` and the orchestrator's scope once,
  and hands `runFromCallback` to the code that must apply an agent runner's synchronous progress
  report. The effect it takes must settle without suspending.
- `packages/adapter-codex/src/codex.ts` forks its line reader the same way, into the scope that owns
  the subprocess.
- `packages/adapter-github/src/tools.ts` runs one host-tool request, because the host-tool port
  answers with a `Promise` that the tool protocol requires.

A new one of these needs a reason of the same kind — a callback or promise boundary that cannot be
expressed as an effect — and it carries the runtime and scope in, rather than starting its own.

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
