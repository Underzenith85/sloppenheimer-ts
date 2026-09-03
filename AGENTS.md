# Repository conventions

This file is the standing brief for anyone — human or agent — writing code in this repository. It
states the conventions the existing code already follows, so a change reads like the code around it
rather than like a second dialect. Where a convention was a deliberate architectural decision, this
file is also the record of that decision: do not open a separate ADR for something written down
here.

Read it as rules with reasons. When a rule and its reason disagree in a case it did not anticipate,
say so in the change rather than quietly taking the exception.

## Verification

`pnpm check` is the gate: it runs `format:check`, `lint`, `typecheck`, `test`, and `build`, in that
order, and CI runs the same command. Run it before handing work off, and treat every one of its
stages as an error rather than a warning — `oxlint` runs with `--deny-warnings`, so there is no such
thing as a tolerated lint.

- `pnpm format` rewrites files with Oxfmt. Never hand-format around it.
- `pnpm lint` is Oxlint with its native type-aware engine.
- `pnpm typecheck` covers the workspace and, separately, the browser sources under
  `src/operator/ui/`.
- `pnpm test` is the default Vitest profile. `pnpm test <path>` narrows it; `pnpm test:conformance`
  and `pnpm test:real-integration` are the other two profiles, selected by test path.
  Do not add a dependency, a script, or a lint exemption to make a check pass. If a rule is genuinely
  wrong for a case, take the exemption in `.oxlintrc.json` with a comment naming the issue that
  removes it — that is the form every existing exemption takes.

## Language baseline

TypeScript 7's native compiler, Node 24, ESM only. The strictness in `tsconfig.base.json` is part of
the design, not a starting point to negotiate down: `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noImplicitReturns`,
`useUnknownInCatchVariables`, and `verbatimModuleSyntax` are all on, and no file may weaken them.

- Never `any`, never a non-null assertion, never an unchecked cast. If a value's type is not known,
  narrow it with a predicate or decode it with a schema — an `as` that asserts what was never
  checked is the defect these settings exist to prevent.
- Every declaration states its return type — `explicit-function-return-type` is an error. It
  permits a contextually typed function expression, and the code takes that: a callback whose type
  the combinator already fixes (`Option.flatMap(..., (entry) => ...)`) is left unannotated, while
  anything bound to a name carries one. `curly` is `all` and `eqeqeq` is on; a `switch` over a
  union must be exhaustive.
- `import type` for types, and `.js` specifiers on every relative import and every workspace
  _subpath_ — `@sloppenheimer/core/support/logging.js` — because `verbatimModuleSyntax` and NodeNext
  resolution both require it. A package-root import is the bare specifier, `@sloppenheimer/core`,
  which is the `.` entry each manifest exports; appending `.js` there names nothing.
- Prefer `type` aliases of `Readonly<{ ... }>` over `interface`. In the sources, classes appear
  only as `Data.TaggedError` subclasses, `Context.Tag` subclasses, and two documented carve-outs
  (`CodexConnection`, which is a session's identity, and `JsonConversionError`, which is thrown and
  caught inside one module); a new one there needs a reason of that kind. `test/harness/` is not
  under that rule — `FakeTracker` and `FakeWorkspaceProcess` are plain stateful classes
  implementing a port, which is the harness pattern to follow.
- Formatting is Oxfmt's: no semicolons, single quotes, 100-column width, trailing commas. Numeric
  literals over four digits take separators (`10_000`).
- Names are whole words: `argumentsValue`, `secretEnvironmentNames`, `retirePrevious`, not `envs`
  or `prev`. A name that needs a comment to expand it is the wrong name. The exception is a term of
  art the platform itself uses — `args` for a process argument vector, as in
  `packages/adapter-node/src/git-process.ts`, reads as the thing being spawned rather than as an
  abbreviation.
- Modules cap at 500 lines and functions at 100, enforced everywhere with no exemption. **Module
  and function size** below has the thresholds and what to do when one is in the way; the way past
  a limit is extraction, never a raised threshold.

## Effect is the default vocabulary

`effect`, `@effect/platform`, and `@effect/platform-node` are pinned as one compatible Effect 3 set
and are upgraded together — Platform releases declare Effect-line peer ranges, and a partial upgrade
produces incompatible runtime types.

Anything that can fail, needs a resource, reads the clock or the environment, or performs I/O is an
`Effect`. Ports are described as records of functions returning `Effect`s; a bare `Promise` in a
port surface is a design statement, made only where the boundary is deliberately total (see
**Errors**).

### `Effect.gen` or `pipe`

Use `Effect.gen` where a computation sequences steps, branches on what it observed, or writes state:
`yield*` reads like the order things happen, and the failure channel stays typed throughout. Use
`.pipe(...)` for a single value being transformed — a decode mapped onto an error, a schedule being
built, a layer being assembled. Do not mix both for the same expression, and do not wrap a one-line
`pipe` in `Effect.gen`.

Neither style may hide a nested runtime: an `Effect` is returned to its caller, not run inside
another effect.

### Errors: the failure channel, not exceptions

The error vocabulary lives in `packages/core/src/domain/errors.ts` as `Data.TaggedError` classes —
`WorkflowError`, `TrackerError`, `WorkspaceError`, `SourceControlError`, `AgentError`,
`HandoffStoreError`, `CompletionStoreError`, `ServerError`. Each carries a human `message`, an
optional `cause`, a
discriminator its callers branch on, and whatever else they need to decide — `retryable` and
`retryAfterMs` on `TrackerError`, `worktreePreserved` on `SourceControlError`. The discriminator is
a `category` union in every one of them except the two store errors, `HandoffStoreError` and
`CompletionStoreError`, which distinguish only the `operation: 'read' | 'write'` that failed.

- Extend an existing discriminator before adding an error class. A new class is warranted only when
  a new port needs a failure that no existing port's callers can handle.
- In Effect-returning code the failure channel is how a function reports failure. Do not throw to
  signal one, do not reject a promise to signal one, and do not return a sentinel value (`null`,
  `-1`, an empty string) that a caller has to know to check.
- Failures are the expected outcomes; defects are the bugs. Do not `Effect.die` for something an
  operator could cause, and do not catch defects to keep a fiber alive — a defect that reaches the
  runtime is information.
- Preserve `cause` when converting between layers. `Effect.mapError` at the boundary is how an
  adapter's failure becomes a port's failure; a rewritten message that drops the cause loses the
  only record of what actually happened.
- No error message may carry a credential. Secrets are `Redacted` and messages are built from field
  names, not field values.

Two shapes of `throw` are sanctioned, and in neither is the throw a signal that crosses an Effect
boundary.

The first is a local implementation detail: **inside the `try` thunk of `Effect.try` /
`Effect.tryPromise`, or inside a helper documented as being for a caller already inside one.** The
surrounding combinator catches it and puts a typed error back on the failure channel, so nothing
escapes as a defect. `authoredFields` in
`packages/adapter-github/src/provider.ts` is the model: a run of small validators that throw a
`WorkflowError`, wrapped once in `Effect.try` that maps the caught value back. `decodeTrackerOrThrow`
in `packages/adapter-github/src/client.ts` is the same idea factored out, and its doc comment says so.

Keep the wrapping `Effect.try` in view of the throw wherever you can: a helper that throws in the
middle of a module, for a wrapper at its edge, is easy to read and hard to misuse.

One helper is deliberately not local to its wrapper. `trackerProviderOf` in
`packages/core/src/domain/tracker-provider.ts` — and `githubProviderOf`, which re-exports it —
throws a `WorkflowError` when a validated selection is not the kind an adapter registered for, and
each factory in `src/tracker-adapters.ts` calls it inside its own `Effect.try`. It is shared by
every capability of every registered provider, so it is written once and its callers supply the
boundary. If you export a throwing helper, say so in its doc comment as that one does, and make
every call site wrap it.

The second is the process boundary that runs before there is a runtime to fail into:
`parseCliArguments` in `src/config/cli-options.ts` throws on a malformed argument, and its caller
in `src/cli.ts` catches it and returns an exit code. Argument parsing decides whether the
program starts at all, so it has no failure channel to use; that is what makes it an exception
rather than a precedent. Everything downstream of it is Effect-returning code, where the rules above
hold.

`try`/`catch` is for JavaScript APIs that throw as their only failure mode — `new URL(value)` is the
recurring one — and converts to a typed value immediately, in the same expression. `Effect.tryPromise`
is how a promise-returning API is admitted. A floating promise is a lint error, and a promise
created outside the runtime is an interruption leak.

Where a boundary must be total, say so and make it so. `TrackerPort.executeTool` returns a
`Promise<HostToolResult>` because the agent runner calls it as a host tool: every invocation resolves
to a JSON-safe success or failure, and a rejection would be a protocol violation rather than a
reportable outcome. That totality is the boundary's contract — enforced where the effect is run out,
in `packages/adapter-github/src/tools.ts` — not a licence to swallow failures anywhere else.

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

`findPullRequest` in `packages/adapter-github/src/code-review.ts` is the worked example on the
`Option` side: absence decides the next branch in both handoff paths, so it answers
`Effect.Effect<Option.Option<string>, TrackerError>` rather than carrying a `null` deeper. One
signature still predates this record — `refreshIssue: () => Effect.Effect<Issue | null, AgentError>`
in `packages/core/src/ports/agent-runner.ts` — and should become `Option<Issue>` for the same
reason. In contrast, wire-shaped `Issue` fields including `description`, `branchName`, `url`,
`createdAt`, and `updatedAt` remain nullable, as do telemetry and snapshot fields such as
`AgentEvent.message`, `sessionId`, `HandoffSnapshot.headSha`, and `reason`.

An optional _capability_ shows the conversion working. `CurrentCodeReview` reads
`CodeReviewPort | null`, because at that seam the absence is a composition fact — the provider
supplied none. The orchestrator converts once, when it records the ports a session runs against:
`ExecutionSnapshot.codeReview` is `Option<CodeReviewPort>`, and every handoff decision below it
branches with `Option.match` rather than re-testing for `null`.

This mixed style is intentional. It costs one explicit conversion at each architectural boundary,
but keeps serialized types honest and naturally JSON-compatible while making internal absence
composable with Effect.

### Immutable state

The scheduler's whole world is one immutable value, `RuntimeState` in
`packages/core/src/core/state.ts`, held in a `Ref` and advanced by pure transitions. Everything
below follows from that shape.

- Records are `Readonly<{ ... }>`; collections are `readonly T[]`, `ReadonlyMap`, `ReadonlySet`. A
  mutable container in a state or domain record is a defect, not a shortcut.
- Never mutate an argument. A single entry or member edit goes through
  `packages/core/src/support/collections.ts` — `withEntry`, `withoutEntry`, `withMember`,
  `withoutMember`, and the bounded variants — each of which answers with a new collection and leaves
  its argument untouched. The removal and membership helpers go one step further and return the
  _original_ collection when there was nothing to remove or the member was already there, so a no-op
  transition preserves reference equality and a caller may compare by identity. `withEntry` does
  not: it always copies, because a write of the same value is still a write.
- A transition that rebuilds a whole collection builds a fresh one locally instead, which is the
  same discipline at a different scale: `publishDetails` in `core/transitions/details.ts` fills a
  new `Map` as it walks the records, and `pruneSupersededPorts` in `core/transitions/ports.ts`
  copies, deletes from the copy, and returns the original when it dropped nothing. Neither touches
  the collection it was given.
- Every write is one atomic `Ref.modify` or `Ref.update` of a transition function — never a read,
  then a decision, then a write spread across several effects. Most of them happen in the mailbox
  loop, which is what orders event-driven work, but the loop is not the only writer: a runner
  callback buffers telemetry through `runFromCallback` in `core/dispatch.ts`, and `requestRefresh`
  in `core/runtime/scheduling.ts` registers its waiter before offering the tick. Each of those is a single
  atomic transition, which is what lets it run beside the loop. (The doc comment on `RuntimeState`
  still calls the loop the single writer; this section is the accurate one.)
- Transitions are pure functions of the state and what happened, living in
  `packages/core/src/core/transitions/`. They take no fibers, ports, or clock. A transition whose
  caller must then act returns `[value, nextState]`, in the order `Ref.modify` consumes — which is
  how a call site hands one straight to the cell (`Ref.modify(context.state, Transitions.takeRunId)`).
- A lookup that may find nothing answers with `Option`, because what it found decides the caller's
  next branch.
- Local mutation is fine when it never escapes: a function building a fresh object or array may fill
  it with a loop before returning it (`withCamelCasedKeys` in `support/schema.ts` does exactly that).
  What is forbidden is a mutation observable by anyone else.
- Prefer an expression to a reassigned `let`. A `let` that exists to accumulate a result is usually
  a `map`, a `reduce`, or a fold over a state record.
- Freeze what is published across a boundary. `makeHostToolSession` hands out `Object.freeze`d specs
  and context because the value goes to another program's session.
- `MutableRef` is a deliberate, documented carve-out, used only for `SessionPorts` in
  `core/dispatch.ts` and `core/workflow-reload.ts`: a running session must observe a port that a
  reload replaced under it, and the alternative is threading a `Ref` read through every callback. A
  new `MutableRef` needs that kind of justification in a comment.

Immutability is what makes those writes expressible as pure functions, and what lets a reader — the
snapshot path above all — observe one coherent instant rather than a set of containers mid-edit.
Adding a writer therefore means adding a transition, not reaching into the record.

### Time: read the clock, do not read the ambient one

Accepted 2026-08-31: an effect that needs the current instant reads it through Effect's `Clock`,
never through `Date.now()` or `new Date()`.

- `packages/core/src/support/clock.ts` exports `currentInstant`, the `Clock.currentTimeMillis` read
  wrapped as a `Date`. Use it wherever the instant is carried as a `Date`, and
  `Clock.currentTimeMillis` directly wherever it is compared or added to as a number.
- Pure functions keep taking the instant as a parameter — `createSnapshot`, and the transitions in
  `core/transitions/`. The caller reads the clock; the function stays a function of its inputs, and
  none of them acquires a `Clock` dependency.
- `new Date(value)` stays where the instant comes from a value already in hand: a parsed wire
  timestamp, a restored snapshot, or a deadline derived from a recorded instant.
- Delays and repetition in orchestration are `Effect.sleep` and `Schedule`. Process-lifecycle code
  is the standing exception, wrapped in an effect or not: where the thing being timed is a real
  child process or the host itself, a test clock would never advance it, so a native timer is
  correct there. That covers the hook deadline and its kill grace period in
  `packages/adapter-node/src/workspace-hooks.ts` (inside `Effect.async`, the shape that bridges such
  a callback), the force, bound, and reap timers of `terminateChildProcess` in
  `packages/core/src/support/subprocess.ts`, and the CLI's shutdown watchdog. Each says why. Reach
  for one only when a real process is what you are waiting on.
- `src/operator/ui/` is browser code with no Effect runtime and is outside this convention.

Tests therefore drive the whole orchestrator from `TestClock` — the clock `Effect.sleep` and
`Schedule` already run against — instead of waiting on the wall clock.

### Environment and secrets

- A declared environment reference is read as an Effect `Config`, through whatever `ConfigProvider`
  the fiber carries: `packages/core/src/config/env-reference.ts` is the one place that resolves
  `$VAR` indirection, and a test supplies a provider instead of mutating `process.env`.
- Credentials are `Redacted` from the moment they are resolved, so a log line, a serialized config
  record, or a stack trace cannot echo them by printing the object that carries them. Unwrap with
  `Redacted.value` at the call that needs the bytes, never earlier.
- A workflow file may not carry a literal credential; only a `$VAR` reference is accepted.
- Reading `process.env` directly is reserved for assembling a child process's whole environment,
  where the point is the set of names rather than one value — and the selected runner's own
  authentication names are stripped there.
- Retained telemetry is redacted and bounded at ingest, in `support/redaction.ts`, not at
  serialization: redacting on the way out would leave the secret resident in memory and depend on
  every response path remembering to apply it.

### Wire boundaries: decode, do not assert

Everything arriving from another program — a GitHub payload, an App Server notification, a stored
snapshot, a workflow file — enters as `unknown` and is checked before it is used. No cast, ever: the
question is only which of the two checks fits.

Payloads are decoded with a `Schema`, which is the default and what every field read should sit
behind. The exception is envelope routing, where the shape being tested is which kind of message
arrived rather than what it contains: `receiveLine` in `packages/adapter-codex/src/inbound.ts`
narrows the parsed line with the `support/json.ts` predicates, reports an unusable line as a
`malformed` event rather than failing the session, and hands the payload on — where the schemas in
`protocol.ts` and `payload.ts` do decode it. Route with predicates, read fields with a schema.

- `packages/core/src/support/schema.ts` holds the tolerance protocol payloads need: a _record_ that
  is not a record fails, because there is nothing to read; a _field_ that is missing or malformed
  reads as `null`, because the rest of the record is still worth having. Use `protocolStruct` and
  `tolerant` for a format Sloppenheimer reads but does not define.
- Formats Sloppenheimer _does_ define — its own persisted handoff store, its workflow schema — are
  decoded strictly. Tolerance there would hide a bug in our own writer.
- `support/json.ts` holds the JSON vocabulary (`JsonValue`, `JsonObject`, `isJsonObject`) that every
  JSON-facing record is expressed in. `isJsonObject` is the repository's one structural record test;
  do not hand-roll `typeof value === 'object'`, which accepts arrays and `null`.

### Resources, services, and layers

- A port is a `Context.Tag` over a record of functions. `core/` depends on the tag and never names a
  concrete adapter; the composition root in `src/` binds implementations with `Layer`.
- Anything acquired is acquired in a `Scope` — `Effect.acquireRelease`, `Effect.addFinalizer`,
  `Layer.scoped` — never a `try`/`finally` around an effect. A finalizer is visible to the runtime,
  so it also runs on interruption, which a `finally` does not. (`finally` is still right for a
  synchronous restore outside the runtime, as in `src/operator/ui-assets.ts`.)
- A port whose instance is not a singleton — rebuilt by a workflow reload or a credential rotation —
  goes through the `AdapterCell` in `packages/core/src/ports/cell.ts`. Consumers resolve the tag
  once and read through `get`; the reload path calls `rebuild` and runs the returned
  `retirePrevious` when no in-flight work still holds the replaced instance. Each instance gets its
  own child scope, so its resources are released when _it_ is retired rather than accumulating
  finalizers for the life of the process.
- Construction that allocates a resource is an `Effect`, so the acquisition is a step the runtime
  can see, interrupt, and pair with a release. `CodexConnection` is the exception and shows what it
  costs: its constructor spawns the child process, so it is safe only because `openConnection` in
  `packages/adapter-codex/src/codex.ts` is the one thing that builds it and does so inside
  `Effect.acquireRelease`. Do not copy the shape; if you change that class, keep the construction
  inside that acquisition.

### Concurrency and interruption

- Concurrent work is forked into a scope (`Effect.fork`, or a `FiberMap`/`FiberSet` opened in one),
  never left as a dangling promise.
- Every long-lived fiber the orchestrator forks is owned by one keyed collection,
  `packages/core/src/core/runtime/execution.ts`, opened in the orchestrator's own scope. A fiber is
  keyed by what it is doing and which issue it is doing it for — `worker`, `retry` and `delivery`
  per issue, and the one poll timer — so replacement is the collection's job rather than a step
  each call site remembers: arming a key interrupts what it held, a fiber that ends takes itself
  out, and closing the scope interrupts everything left and waits for their finalizers. Ownership
  is the collection's; what is running, retrying or waiting to be delivered stays `RuntimeState`'s
  to say, and no fiber handle is stored in a state record. Add a long-lived fiber by giving it a
  key there, never by keeping a `Fiber` in a transition's value.
- The orchestrator is a mailbox actor: an unbounded `Queue` of events, one loop applying pure
  transitions to the state. Offering an event is how work gets ordered, and it is the default. A
  callback outside the runtime bridges in through `runFromCallback`, and may — as `runSession`'s
  `onEvent` does in `core/dispatch.ts` — write its own atomic transition first and then offer, so
  that what it recorded cannot be overtaken by the session's exit. Anything more than one atomic
  transition belongs in the mailbox.
- Mutual exclusion between fibers is `Effect.Semaphore` — the adapter cells and the Codex session's
  lifecycle each take one, so two rebuilds cannot drop an instance unreleased. The scheduler's `tickQueued`
  and `pollRunning` are not that: they are fields of the state record that coalesce work, reached
  only through transitions.
- A protocol read is a `Stream`: the Codex reader lifts the child's stdout with
  `NodeStream.fromReadable` and frames it in `packages/adapter-codex/src/readers.ts`, so
  backpressure and interruption are the runtime's problem. Draining a subprocess pipe for its
  diagnostics is not that, and does not pretend to be — `runProcess` in
  `packages/adapter-node/src/git-process.ts` and `captureStream` in its `workspace-hooks.ts` attach
  `data` and `error` listeners inside the `Effect.async` that owns the child, bounding what they
  keep. Use a `Stream` when the bytes are a protocol; use the listeners when you are draining a
  process you are already holding.
- Write interruption-safe code: assume any effect can be interrupted between two steps, and put the
  cleanup in a finalizer.

### Retry

Retry policy is a `Schedule` value in `packages/core/src/core/retry.ts`, not a loop with a counter.
Retryability is a property the error carries (`TrackerError.retryable`, `retryAfterMs`) and a
recurrence condition of the schedule, rather than a decision each call site repeats. Retry is what a
provider's refusal earns; not asking for the refusal in the first place is a separate concern, and
**Architecture record: provider-scoped rate limiting** below is where that lives.

### Logging and telemetry

Structured logging goes through `logInfo`, `logWarning`, and `logError` in
`packages/core/src/support/logging.ts`, which sanitize fields, redact secret-named keys, and bound
strings before anything is emitted, and default every record to an `action` and an `outcome`. New
logging uses those. One caller predates the rule and logs through Effect's own
`Effect.logInfo` / `Effect.logWarning` directly — the hook lifecycle in
`packages/adapter-node/src/workspace-hooks.ts`, whose records therefore carry neither the defaults
nor the sanitizing, including the `stderr` excerpt it reports on a failed hook. Read it as the
exception it is rather than as a pattern to copy.

Telemetry events state their own `lifecycle`; nothing infers a session transition by matching a
runner's event names.

### Where the runtime is entered

`Effect.runPromiseExit` in `src/cli.ts` is the process boundary, and there are three other runs in
the whole repository, each with a stated reason. `Effect.runPromise` in
`packages/adapter-github/src/tools.ts` serves the total host-tool boundary described under
**Errors**. `Runtime.runFork` in `packages/adapter-codex/src/codex.ts` starts long-lived work from
a callback that is not itself an effect, and passes an explicit scope so the fiber is still owned
by something. The orchestrator's own callback bridge — `runFromCallback` in
`packages/core/src/core/runtime.ts`, which an agent runner's progress report enters through — is
the run function `FiberSet.makeRuntime` hands back: it captures the runtime once and owns each
fork in a set the orchestrator's scope closes, so a report in flight is interrupted with the
orchestrator and a report that has landed leaves the set. Do not add another: a function that needs
a runtime is a function that should have returned an `Effect`.

## Packaging

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

### Working within the packaging

- **Adding a module.** Put it in the lowest layer that can hold it, and export it from that layer's
  own subpath rather than widening a package's barrel. `packages/core/src/index.ts` is deliberately
  only the composition root's view — the ports and the orchestrator — so every other importer names
  the layer it depends on (`@sloppenheimer/core/domain/domain.js`).
- **Adding a package** is a last resort, justified the way `adapter-node` is: two packages above it
  need it and neither should depend on the other. It copies the existing manifest shape exactly —
  `private`, `type: module`, the two-entry `exports` map, a `build` script of `tsc -b tsconfig.json`
  — extends `tsconfig.package.json`, declares `@types/node` itself, is added to
  `tsconfig.build.json`'s references and to the root `tsconfig.json` `paths`, and is asserted in
  `test/package-boundaries.test.ts`.
- **Dependencies** on an external package are pinned to an exact version, never a range. A new one
  needs a reason that survives the question "what does this do that Effect or Node does not". The
  Effect trio moves as a set. A dependency on another package in this workspace is `workspace:*`,
  which is not a range: there is one version of each, in this repository.
- **Adding an adapter** of an existing kind is one entry in the registry beside the composition root
  — `src/tracker-adapters.ts` or `src/agent-runners.ts` — and no change under `config/` or `core/`.
  Backend-specific settings are validated in that backend's adapter, never in `packages/core`.

## Module and function size

[#211](https://github.com/Underzenith85/sloppenheimer-ts/issues/211) set the bar: **500 lines a
module, 100 lines a function**, counting blank lines and comments. `.oxlintrc.json` configures
`max-lines` and `max-lines-per-function` at those thresholds for every source directory in the
workspace, so `pnpm lint` — and therefore `pnpm check` — fails on a module or function that grows
past one.

- 100 rather than ESLint's default 50, because `Effect.gen` pipelines are vertically expensive: an
  `Effect.matchEffect` branch costs six to eight lines of structure, so a 50-line bar flags
  idiomatic Effect code that is not complex.
- The rules are scoped to sources, never to `test/`, where `max-lines-per-function` would count a
  `describe` callback and flag suite structure rather than complexity.
- There is no exemption anywhere today. A module that genuinely has to exceed one of these takes an
  `overrides` entry of its own naming the issue that removes it again — the same convention the
  import allow-lists use. Never raise a threshold to accommodate a file.

The orchestrator is the worked example. `packages/core/src/core/runtime.ts` is assembly and nothing
else; every operation the running host performs lives in a module under `core/runtime/` and takes
the cells it needs — the state `Ref`, the mailbox, the handoff store — as a parameter rather than
closing over the factory's scope. `OrchestratorContext` is those module-level functions bound to
one set of cells, built by `core/runtime/context.ts`. Add an operation as a module beside them, not
as a closure inside the factory.

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

## Architecture record: ports and the handoff boundary

The following port boundary was accepted in the 2026-08-30 architecture review:

- `TrackerPort` contains only tracker-neutral issue operations: fetching normalized issues, adapter-supplied dispatch eligibility, dependency hydration, tracker credentials, and issue-state operations expressed in tracker-neutral terms.
- Pull-request handoff is an optional application capability exposed through `CodeReviewPort`. It owns completed-work handoff and discovery of an existing handoff, inspection of a proposed change, protected merge, and review-thread resolution. The port may use honest pull-request and code-review vocabulary.
- Repository preparation and publication are a tracker-neutral application capability exposed through `SourceControlPort`. The host owns Git metadata and credentials, prepares normal work from the branch's published head or, where it has none, the protected base, and repairs from an exact pull-request head, commits agent file changes, rebases under policy, and pushes with an expected-head lease. Agents edit only worktree files. Source control must not be folded into `TrackerPort`, and pull-request inspection and merge remain in `CodeReviewPort`.
- GitHub supplies both `TrackerPort` and `CodeReviewPort`; other tracker providers are not required to simulate code-review concepts that they do not support.
- When handoff is enabled, a provider that does not supply `CodeReviewPort` is an operator-visible configuration error. When handoff is disabled, no `CodeReviewPort` is required and the application follows the core continuation lifecycle. The workflow key that selects between the two is `handoff.enabled`, read once by the composition root at startup ([#73](https://github.com/Underzenith85/sloppenheimer-ts/issues/73)).
- `HandoffResult` belongs with `CodeReviewPort`, because its pull-request variant is a code-review concept rather than an issue-tracker concept.
- The composition root states that gate structurally: composing no code-review services at all is handoff disabled, and composing them is handoff enabled. The orchestrator therefore asks for `CurrentCodeReview` as an optional service, and reports the configuration error only when that service is present and the provider's factory supplies nothing.

This convention is the architecture record for the boundary. Do not create a separate ADR for it.

## Architecture record: turn completion and publication

Accepted 2026-09-01, implementing [#167](https://github.com/Underzenith85/sloppenheimer-ts/issues/167).
This section is the architecture record for it; do not create a separate ADR.

A successful agent turn is an agent-protocol fact and nothing else. Turn completion, workspace
change, publication and handoff are four outcomes, and Sloppenheimer used to collapse all four into
one: a `completed` turn was treated as delivered work, and the only evidence consulted afterwards
was the remote head. On [#149](https://github.com/Underzenith85/sloppenheimer-ts/issues/149) that
lost a whole implementation — the agent made the change and passed `pnpm check`, Git delivery was
blocked by read-only `.git` metadata, and the unchanged remote SHA was reported to operators as a
repair agent that had achieved nothing.

- After every successful turn the host runs a postflight (`packages/core/src/core/postflight.ts`):
  inspect the worktree against the baseline the preparation recorded, then publish what the
  inspection found. It answers with one of `NotPerformed`, `NoChanges`, `Published` or
  `DeliveryFailed`, and it cannot fail — raising a publication problem as a worker failure is what
  turned a delivery problem into an agent retry.
- The agent stall timer does not run over a postflight. It measures silence on the agent protocol,
  and a postflight is silent on it by construction: no agent is running. A run records when the host
  took it over, and the stall sweep leaves those alone — otherwise an inspection or a push that
  outlasts the timeout is retired as a stalled agent and the coding agent runs again on work it had
  already finished, which is the confusion this whole record exists to end. A publication that
  cannot finish is the source control's to fail, and it fails as a delivery. The surfaces say the same
  thing: the run's snapshot publishes no stall deadline once the host has taken over, and its detail
  moves to the `publishing` phase — a deadline nothing will act on is what has a console reporting a
  stalled agent for a run whose stall detection is off. The takeover is recorded before the first git
  call, and the worker waits for it to be recorded rather than merely sent: enqueueing the event and
  publishing anyway leaves a poll already in flight reading a run nothing had marked, which retires
  the publication as a stalled agent — the one thing the marker exists to prevent. The wait is on the
  handler because runtime state changes go through the mailbox; the worker does not write the state
  itself. All of this is a marker on the agent's session standing in for a phase of the run; the
  phase becomes explicit, and the marker and its handshake go, under
  [#260](https://github.com/Underzenith85/sloppenheimer-ts/issues/260).
- The agent's final message is never parsed to decide any of this. Worktree state, baseline SHA,
  published SHA and expected remote SHA are authoritative.
- A clean worktree is not published. `SourceControlPort.inspect` exists so that "there was nothing
  to deliver" and "the delivery failed" are separate readings rather than one absent branch.
- `DeliveryFailed` retains the workspace and queues a **delivery**, not a retry: a delivery holds
  the issue's claim with no worker behind it, and what comes due is one more `publish` of the same
  preparation. It is bounded by `deliveryAttemptLimit` in `core/retry.ts`; when the failure did not
  preserve the worktree, or those attempts are spent, the work goes back to the coding agent as an
  ordinary retry. `deliveryAttemptLimit` counts publications, the turn's own included. A retained
  delivery keeps calling the tracker and the code-review port after the run that produced it has
  ended, so a workflow reload or a credential rotation adopts it exactly as it adopts a running run
  and a handoff.
- A retained delivery holds its issue's claim, which is what `dispatchAdmission` refuses on. It is
  in that list for the same reason a running run and a queued retry are: an agent admitted while a
  publication is queued would be editing the very worktree that publication is about to push. The
  reconciliation pass releases the claim of every handoff nothing is acting on, and a delivery is
  something acting on it.
- Retirement waits for a retained delivery exactly as it waits for a running run and a handoff. A
  delivery holds the workspace manager it will open the workspace through again — to publish the
  change or, on the terminal path, to remove it — so releasing that manager's scope from under a
  reload would take the only copy of the work with it.
- "Repair agent completed without changing the pull request head" is reachable only when the
  inspected worktree was clean. The repair identity carries the postflight verdict for exactly this
  reason: an unchanged head alone cannot tell a no-op turn from a push that failed.
- A restart does not recover a retained delivery. A delivery is in-memory intent; the workspace it
  would republish from is the run's own, and what becomes of that directory once the process is
  gone is the workspace record's decision ([#166](https://github.com/Underzenith85/sloppenheimer-ts/issues/166),
  retry continuity (b)): it stays as a retained recovery artifact naming why, no later run adopts
  it, and it goes when the issue reaches a terminal state. This record once carried an in-process
  sweep that reopened an issue's workspace on restart and published what it found; that depended
  on `prepare` preserving a dirty worktree and on a workspace belonging to an issue, and both were
  removed by #166. Republishing retained artifacts on restart is a revision of that decision and a
  new port surface, not something to reintroduce here.
- Retained workspaces of an issue that is still open are capped
  ([#273](https://github.com/Underzenith85/sloppenheimer-ts/issues/273)). Once a run has let go of
  its workspace the worker's own fiber — off the loop, because a pass over whole checkouts has no
  bounded size — asks the workspace manager to `prune` the issue to the newest
  `workspace.retained_limit` retained workspaces, and reports what stayed through the mailbox as a
  `RetainedWorkspacesObserved` event, which is what the snapshot's `retainedWorkspaces` rows are.
  Which workspaces go is `domain/workspace-retention.ts`'s rule: never a protected key — the
  retained delivery's workspace read from the state, and the workspace of the run being pruned
  for, which the manager names from the run identity rather than the caller from the lease, so an
  ending that never reached the session keeps its directory too — never one a lease still holds,
  and never a retained workspace of a host that is running or unobservable, because a live peer's retained delivery is in-memory intent nothing
  here can see; gone is read as `ownerIsGone` reads it for a held lease, so a process that
  inherited the owner's id is a successor rather than the owner. A cancellation runs no prune,
  since what follows it may be removing the issue's workspaces altogether. Every removal site
  forgets the issue's row and records the run counter, and the loop refuses an observation from a
  run older than that removal: the count is taken off the loop, so a terminal cleanup can overtake
  it and the count would otherwise re-add a row for directories that are gone. There is no age-based sweep: a lease's reason is a string written for a human,
  and a failed run's directory may still hold edits no inspection ever read, so the cap is the only
  rule that deletes.
- A delivery's publication runs off the event loop. Everything else a handler does is memory and a
  bounded call; a publication is git, and a push waits on a child process that may never close — so
  running it inside the loop let one hung delivery stop every issue the host was running, ticks,
  worker exits and the operator pause that would have called it off included. The attempt is forked
  and reports back as an event, because the state it settles is still the loop's to write. The entry
  stays in the state for the duration rather than being taken out and put back: claimed and
  published as a `delivering` row, so a poll interleaving with the publication finds an issue
  something is demonstrably doing rather than a workspace nobody owns. A settlement is applied only while the entry is the one that attempt was publishing;
  anything that superseded, held or dropped it meanwhile has already decided what becomes of the
  work. Nothing ever waits on an interrupt of a publication for the same reason nothing runs one on
  the loop. The same rule is not yet true of every handler — terminal cleanup runs an operator's
  `before_remove` hook on the loop, and reconciliation re-reads the tracker once per running run —
  which is [#259](https://github.com/Underzenith85/sloppenheimer-ts/issues/259).
- An operator pause does not interrupt a publication already under way. Cutting off a push mid-flight
  is what leaves the remote in a state nobody can name, and the pause is not lost: the attempt
  settles, and whatever is scheduled next re-reads the pause before publishing anything. That
  includes the continuation a published attempt schedules: a retry that comes due against a pause
  ends the way the pause ends a retry it finds queued — claim released, cancellation recorded — and
  the dispatch itself refuses a paused issue as its last word
  ([#263](https://github.com/Underzenith85/sloppenheimer-ts/issues/263)).
- A publication asks whether the branch already carries its commit before rebasing, not after. The
  rebase is what makes the question unanswerable: a protected base that moved since the accepted
  push rewrites the very commit the branch holds, so the comparison could only ever answer that the
  work is undelivered — and then every attempt fails the stale lease, spends the delivery budget,
  and hands the agent back what is already on the remote. Containment rather than equality, because
  a branch the push landed on may since have had commits built on top of it.
- A cancellation lands on whatever the run had reached — an uncommitted edit, a commit that was
  never pushed, a publication cut off midway — and the fiber that would have settled the postflight
  is gone. The workspace is released as retained under the lease, with the interruption as its
  reason, and nothing in this process reads it again: it is the run's own, and the next run gets
  its own. What a cancellation owes a postflight that had already reached the remote is an open
  question ([#257](https://github.com/Underzenith85/sloppenheimer-ts/issues/257) item 1), and it
  becomes answerable once the postflight is an explicit phase of the run rather than a marker on
  the agent's session ([#260](https://github.com/Underzenith85/sloppenheimer-ts/issues/260)).
- A normal target starts from its branch's published head, and from the protected base only when
  the branch does not exist yet; a repair starts from the exact pull-request head. That is the
  workspace record's `fetchBaseline`, and the reasoning lives there. Publication still rebases onto
  protected main, which keeps the branch on top of the base and is a different thing from choosing
  what the branch starts from.
- A publication whose branch already carries the commit it would push answers `Published` rather
  than consulting the lease. The likeliest way to arrive there is a push the remote accepted and
  the client did not see succeed, and a delivery retry has to be idempotent: rejecting it against a
  tip that is this very commit would spend the delivery budget and hand the agent back work already
  on the remote.
- Shutdown preserves it as the run's retained workspace, and nothing is deleted. The next process
  does not rediscover it; see the restart bullet above.
- A cancellation that keeps the workspace preserves it: a stall, a workflow reload, a tracker that
  stopped reporting the issue.
- An operator pause **suspends** a delivery rather than dropping it. A queued retry is dropped on a
  pause, because an agent that has not run has produced nothing to keep; a delivery holds a change
  that exists, and a pause is a decision to stop rather than to discard. The timer is called off,
  the entry stays, and a resume arms it again from the attempt it was suspended on.
- A cancellation that removes the workspace discards it, and drops the retained delivery in the
  same step, so a delivery can never come due against a directory that no longer exists. That is
  the terminal-issue path, and only it.
- A discard is only true once the workspace is gone, so the removal happens before anything records
  one — and it happens once, in the attempt that reports it. The settlement records what the
  attempt did; it does not remove again, because a second removal that failed would report files
  remaining that the first deleted, retain the claim, and spend the delivery budget on work that no
  longer exists. A removal that failed leaves the files where they were, so the delivery has not settled: it
  is retained for another attempt, which is what keeps alive the one manager that can remove that
  workspace — a reload may have moved the workspace root out from under everything else. When the
  attempts are spent the files stay put as the run's retained workspace, the claim is released, and
  the reason is in the detail.
- A delivery that comes due re-reads its issue immediately before publishing. An issue that has
  since gone terminal or left its active states has its work discarded rather than pushed: putting
  a branch and a pull request on the remote for work nobody asked for any more is the one thing
  worse than losing a diff.

### Known limits and follow-ups

- No git invocation is bounded: `runProcess` in `packages/adapter-node/src/git-process.ts` waits on
  `close` with no deadline, so a hung `fetch` or `push` waits forever. A delivery's publication is
  off the loop, so the host keeps answering; the operation itself does not end. One subprocess
  primitive with a deadline, and a fake for lifecycle tests, is
  [#258](https://github.com/Underzenith85/sloppenheimer-ts/issues/258).
- Handlers still yield on ports that block: `before_remove` hooks from terminal cleanup, and the
  tracker from reconciliation, retry-due and the poll. The rule that a handler handles messages only
  is [#259](https://github.com/Underzenith85/sloppenheimer-ts/issues/259).
- The run entry is the claim, the phase and the agent session in one record, which is why the stall
  timer has had to be taught about the postflight. Splitting it is
  [#260](https://github.com/Underzenith85/sloppenheimer-ts/issues/260).

## Architecture record: a branch that is behind is the host's to rebase

Accepted 2026-09-03, implementing
[#274](https://github.com/Underzenith85/sloppenheimer-ts/issues/274). This section is the
architecture record for it; do not create a separate ADR.

A pull request whose only fault is that protected main has moved used to classify as
`repair_needed`. The repair agent it earned had nothing to change, its clean worktree read as a
repair that achieved nothing, and the handoff ended in `intervention_required` for a state the host
already knew how to fix -- `publishRepository` rebases and force-pushes with a lease on every
publication, and was skipped precisely because there was nothing to publish.

- `mergeable_state: 'behind'` classifies as `rebase_needed`, a disposition of its own in
  `packages/core/src/domain/handoff.ts`, and the decision it produces is a `Rebase` action rather
  than a `Repair`. Everything else wrong with a head still comes first: a failing check or an
  unresolved thread on a behind branch is the agent's to fix, and its publication rebases anyway.
- `SourceControlPort.rebase` is the host action: the preparation a repair gets -- the exact
  pull-request head, under its lease -- followed by the rebase and leased push a publication ends
  with, without the commit a publication begins with. It answers `NoChanges` when the base is
  already behind HEAD, asked by containment _before_ the rebase: `--committer-date-is-author-date`
  rewrites every commit it replays whether or not the base moved, so comparing heads afterwards
  would push an unchanged branch under a new head and cost the pull request a review of the same
  change.
- No agent runs, no slot is taken, no repair permission is asked and no repair attempt is spent.
  Like the merge, it is the host acting on a change that already exists, so it is not gated on the
  issue's eligibility either. An operator pause still holds it, because the pass skips a paused
  handoff before it decides anything.
- The attempt is git, so like a delivery it runs off the event loop under the issue's `rebase`
  execution key and settles as a `RebaseAttempted` event. While it runs the handoff carries a
  `RebaseEntry`: the pass skips the handoff -- the branch is about to move under a lease this pass
  did not take -- and keeps the issue's claim, so no continuation is admitted to start from the
  head the push is replacing. The identity is in-memory only: a restart finds the branch either
  still behind, and rebases it again, or already moved, and observes the new head.
- A published rebase keeps its identity, with the head it pushed, until the provider reports that
  head. The observation in between is stale -- it carries the head the rebase replaced -- and
  acting on it would rebase the branch a second time against a lease the push has already moved.
  The rebased head is then a new head like any other: reviewed once, then judged.
- The identity records the execution the attempt was forked with, and the retirement drain holds
  those instances until the attempt settles, as it holds a run's superseded ports and a retained
  delivery's execution: a reload moves the handoff onto the replacements while the attempt is still
  preparing and pushing through what it captured.
- A rebase the rebase itself refuses (`rebase_conflict`) is `intervention_required`: the provider
  said the branch was merely behind, so what refused is the one thing the host can do about it, and
  a repair agent is given no more than a rebase has. The git reader reserves that category for a
  content conflict git reports as one; a rebase git refused to start or finish -- a stale
  `rebase-merge` directory, a lock, a spawn failure -- keeps the publication category. That and
  every other failure -- the lease, the remote, the workspace -- is recorded on the handoff and
  retried by the next observation from wherever the branch is, exactly as a refused merge is.
- The workspace a rebase leases is released as completed whatever happened. Nothing in it is
  anyone's work, and a retained directory per attempt would be nothing a later run could adopt.
- A repair dispatched for `behind` before this change -- restored from the store, or in flight
  across the upgrade -- comes back with a clean worktree and an unchanged head. That is no longer
  read as "achieved nothing": the unchanged head classifies as `rebase_needed`, the repair identity
  is released, and the same pass rebases.

## Architecture record: agent runners

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

## Architecture record: workspaces

[#166](https://github.com/Underzenith85/sloppenheimer-ts/issues/166) settled the workspace
lifecycle. This section is the architecture record for it; do not create a separate ADR.

- A workspace belongs to one dispatched run or repair attempt, never to an issue. The path is
  `<root>/<issue key>/<run key>`, where the run key names the run number and the host that allocated
  it: the run number restarts with the process that counts it, so the host is what keeps two hosts —
  and a host and its own predecessor — from ever naming one directory.
- Ownership is an exclusive lease, not orchestrator memory, and `WorkspaceManagerPort` hands a
  workspace out only for the length of a use: `withLeasedWorkspace` is a bracket rather than an
  acquire and a release a caller pairs up itself, because an interruption in the gap between them
  would leave a lease that nobody holds and nobody will release. Publishing the lease is the claim —
  the record is hard-linked into place, which is atomic and refuses an existing name — and the run
  directory follows it, so a duplicate dispatch fails before a process is launched and cleanup
  elsewhere never finds a workspace without a lease. A lease is released on success, failure,
  cancellation and shutdown alike, and it outlives the host that wrote it, so a restart and a second
  host reading the same root both see who owns what.
- **A lease is given up or observed to be free — never waited out.** The record names the host
  process that holds it, when that process started, and the process namespace its id belongs to, and
  those are the only things that can take one back: the owner released it, or its process is gone in
  a namespace this host shares. A record naming _this_ process is claimed while this process still
  has it, which it knows rather than reads: a release rewrites the record, and a release whose write
  did not land would otherwise leave `held` beside a live id for a run that ended, and nothing in
  the process could ever take it back. A host restarted into its predecessor's process id — the ordinary
  case for a container's PID 1 — is caught by the start marker rather than by any clock. An owner
  probed at all only where both sides name the same namespace: two containers can share a kernel and
  a root while each sees only its own ids, so anything weaker, the machine's boot identifier
  included, would read a stranger's process as the owner.
  The deliberate limit is that an owner this host cannot place is claimed for good, and its
  workspace stays a retained artifact that cleanup reports and never takes. Do not replace that with
  an expiry, a renewal, or an age. Two hosts do not share a wall clock, a run has no upper bound —
  `turn_timeout_ms` and `stall_timeout_ms` are idle timeouts, restarted by every turn and every
  event — and a workspace deleted from under a live run is unrecoverable where a workspace left
  behind is merely untidy. This was built once with a renewable lease and taken out again: every
  clock it introduced was a way for one host to delete another's work.
  Every step that names a path resolves it through whatever its parents are at that instant, so a
  directory is held still while it is being acted through: opened, which pins its inode, and
  confirmed by device and inode again immediately before each step that creates, renames, executes
  in or removes. Acquisition holds the issue directory that way across the link that publishes the
  claim, the run directory it creates and the `after_create` hook; the release holds it again across
  its own hook and removals; cleanup holds it across the record it takes, the `before_remove` hook
  and each removal; the staged-record sweep holds its own the same way. A directory moved aside and
  replaced under its name stops the caller rather than being followed there.
- **What that does and does not defend, so it is not extended without a reason.** It defends against
  the substitutions this host can produce for itself and stumble into: a workspace path that
  resolves outside the root, a symlink anywhere in the tree, a directory removed and recreated under
  a name that was inspected earlier, and one host's cleanup crossing another's live run. It does not
  defend against a process with write access to the workspace root that is actively racing this one.
  It cannot: Node exposes no `openat`, `renameat` or `unlinkat`, so a confirmation and the step it
  guards are always two syscalls, and every check narrows a window it can never close — while an
  attacker with that access could write into the run directory the agent is already using and need
  win no race at all. The workspace root is the host's own directory, and that is the boundary. Add
  a confirmation where a step gained a genuinely wide gap — an operator's hook, a recursive
  removal — and not to shorten a gap that is already two adjacent statements.
  Cleanup still fences what it does take. Deciding a workspace is free and removing it are two
  steps with an operator's `before_remove` hook between them, so the record is moved aside in one
  rename first and the decision made again on what was actually taken. Moving it aside frees the
  name, so an acquisition may claim it in that instant: a record goes back by `link`, which refuses
  an occupied name, and cleanup removes only the directory it decided on and the record it took —
  never whatever now sits at that name.
- **Retry continuity is (b): unpublished work does not carry over.** A run that published leaves
  nothing behind; every other ending — including a composition with no `SourceControlPort` to
  publish through — keeps its workspace as a retained recovery artifact naming why, which no later
  run adopts. `SourceControlPort.prepare` agrees with that and no longer preserves a dirty worktree:
  a normal run starts from its branch's published head when the branch exists, and from the
  protected base when it does not, so an attempt that ran out of turns is continued by what it
  published rather than by what a shared directory happened to hold. A repair still starts from the
  exact pull-request head. Do not reintroduce a preserve branch in `prepare` without revisiting this
  decision — the two contradicted each other before #166, which is the defect it removed.
- Cleanup never removes a workspace whose lease is still held by a running owner. An issue's
  retained workspaces go when the issue reaches a terminal state.
- The remote executors under #21-#24 inherit this contract: whatever allocates the workspace, every
  run gets its own refs, index, worktree and lifecycle, and holds a lease for as long as it runs.

## Architecture record: provider-scoped rate limiting

Accepted 2026-09-02, implementing
[#250](https://github.com/Underzenith85/sloppenheimer-ts/issues/250). This section is the
architecture record for it; do not create a separate ADR.

Mapping GitHub's primary and secondary rate-limit responses onto retryable `TrackerError`s only
reacts after a request has been refused. Concurrent agents, host tools, reconciliation and handoff
inspection all speak to one credential, so the burst they make together is what has to be bounded —
before the request rather than after it.

- The limiter lives in `packages/adapter-github/src/rate-limit.ts` and is applied in `githubJson`,
  which is the one transport every GitHub read and mutation goes through. Core ports stay
  provider-neutral: nothing under `core/` or `ports/` knows a limiter exists.
- It is scoped to a **provider generation** — one owner, repository, API base and credential —
  rather than to a constructed adapter. The tracker, the issue control and the code review of one
  credential are built into three independent cells, at different instants; a limiter per instance
  would bound each of them separately and the credential not at all. Source control is on the list
  by credential but not by traffic: it speaks Git over HTTPS rather than the REST API, so it makes
  no request for the limiter to admit.
- Generations are matched by **traffic**, not by object identity or by whole-provider equality. A
  validated selection is a new record every time — the console revalidates the workflow on every
  request and a reload revalidates it on every file change — so an identity key would mint a fresh
  limiter, and with it a fresh burst allowance, for a credential that had not changed. The key is
  `githubTrafficKey`: owner, repository, API base and a digest of the credential, which is what
  shares a budget at GitHub. A base branch reaches no endpoint and a credential moved to another
  variable name is the same credential, so neither is a second claim on that budget. A rotation is
  different traffic, so it gets a limiter of its own, and the superseded one stays in force for
  whatever still holds it: an adapter keeps the limiter it was constructed with until its in-flight
  work retires it.
- The registry that keys them is module-level state, which is the deliberate exception to
  **Resources, services, and layers**. There is no scope that outlives every holder and no parameter
  every constructor already carries, so the sharing point has to be reachable without either. It is
  affordable because the limiter acquires nothing — no fiber, no handle, no socket — which is also
  why `makeGitHubRateLimit` is a plain function rather than an `Effect`: there is nothing for a
  scope to release. Pacing is a booked instant advanced by one atomic `Ref.modify`, not a bucket a
  background fiber refills.
- Nothing is evicted from that registry. A count-based bound cannot tell a generation nothing holds
  from one an in-flight adapter is still pacing against, and evicting the latter and then meeting
  its credential again builds a second limiter beside the first, spending an independent burst
  allowance against one budget. What is retained is made cheap instead: a digest and a number per
  generation, never the credential — the key hashes it precisely so the registry, which outlives
  the generations it keys, does not keep a rotated token resident. The outer map is weak on the
  clock, so a clock that goes away takes its generations with it.
- A limiter books its admissions on **one** clock, passed in at construction and part of the
  generation key. A booking is an instant and means nothing measured against a different clock, and
  the calling fiber is not always the one that built the limiter: the host-tool boundary runs its
  request through `Effect.runPromise`, on a fresh runtime carrying the default clock. A process has
  one clock, so this changes nothing in production; a test on `TestClock` gets a limiter that books
  on its own clock, which is what keeps the pacing out of unrelated adapter tests and what stops a
  live-clock booking from stranding a test-clock reader behind a wait of decades.
- The in-flight permit is taken **before** the emission slot is booked, so pacing stays adjacent to
  issuance. The other order lets a request spend its slot and then sit on the semaphore behind a
  slow holder: when the permit frees, every request queued that way starts at once, a burst larger
  than the settings describe made of slots paid for minutes earlier. Holding a permit across the
  wait costs nothing, because a request waiting for capacity has not been issued either way.
- Capacity waits are interruptible. An interrupted in-flight permit is released by
  `Effect.Semaphore`, and an interrupted pacing wait gives its emission slot back when it is still
  the last booking — when it is not, a later reservation has already been handed out against it and
  the slot is forfeited, which errs towards asking GitHub for less.
- Defaults are conservative, fixed, and documented beside the code: 120 requests per 90 seconds
  (4,800 an hour against a 5,000-an-hour token) at 8 in flight. The burst is deliberately larger
  than `githubMaxPages`, so one scoped list read is never throttled against itself. They are not
  configurable — a workflow that could raise them could exhaust the credential every other host
  shares.
- `Retry-After` and `X-RateLimit-Reset` remain authoritative for a request GitHub did reject. The
  limiter is upstream of that and changes nothing about it.
- The wait is observable and never carries a credential: `sloppenheimer_github_rate_limit_delay`
  records it, deliberately apart from `sloppenheimer_github_request_duration` so that local pacing
  cannot read as a slow tracker, and a wait past a second is logged by provider scope. It covers
  the whole wait, the permit as well as the emission slot: request latency begins once a request is
  issued, so a queue behind several slow requests is time no other signal accounts for. That is why
  it is measured from an instant the caller reads before the permit rather than by timing an
  effect — the two acquisitions are not one effect to wrap.

## Testing

Tests live in the root `test/` tree, mirroring the source they cover, and run against workspace
sources rather than builds.

- `@effect/vitest` supplies the test constructors. `it.effect` is the default and runs on
  `TestClock`, so a test advances time instead of waiting on it. `it.scoped` is for a test whose own
  effect requires `Scope.Scope`; where only part of a test owns a resource, the established pattern
  is to stay on `it.effect` and wrap that part in `Effect.scoped`, and `test/orchestrator.test.ts`
  runs roughly half its cases each way on exactly that distinction. `it.live` is reserved for what
  genuinely needs the wall clock or a real subprocess, and choosing it should be a considered
  decision rather than a way past a hanging test.
- Fakes live in `test/harness/` and are ports implemented honestly — a fake tracker, a fake App
  Server, a real temporary Git repository. Prefer one of those to a mocked module; a stubbed global
  (`vi.stubGlobal` for `fetch`) is acceptable at an adapter's HTTP edge and is unstubbed in
  `afterEach`.
- Test the pure transition where the behavior is a pure transition. That is the point of
  `core/transitions/`: `test/core/transitions.test.ts` exercises the scheduler's decisions without
  booting an orchestrator.
- Architectural rules are tests, not just documentation: `test/package-boundaries.test.ts`,
  `test/import-boundaries.test.ts`, and `test/runner-neutrality.test.ts` each fail `pnpm check` when
  a boundary in this file is crossed. A new structural rule earns a test of the same kind.
- The size limits do not apply to `test/`, where a `describe` callback would be counted as a
  function.

## Writing it down

Comments in this repository explain _why_, at the top of a module and at the decision that needed
one. Match that: a module doc comment saying what the module is for and what it deliberately does
not do, and inline comments only where the reason is not visible in the code.

Record a decision here, in the section it belongs to, rather than in a new ADR file. Reference
issues as full Markdown links to `https://github.com/Underzenith85/sloppenheimer-ts/issues/<number>`,
and when a rule is temporary, name the issue that removes it.
