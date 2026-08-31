# Utility and generics audit

A read of every `.ts` file under `src/`, `packages/`, and `test/` (18.8k lines of source, 22.1k of
test) looking for one thing: code that is already a utility in everything but name — repeated
verbatim, or written once per concrete type where one type parameter would do.

Findings are ordered by how much they remove and how safe the removal is. Each names the call sites
so the work can be scoped without re-deriving the search.

**Status.** Findings 1–8 are implemented; each is marked below, and the line numbers in those
sections refer to the code as it stood before the change. Findings 9, 10, and 11 remain open and are
tracked in [#215](https://github.com/Underzenith85/symphony-ts/issues/215).

Every proposed home respects the layering in `AGENTS.md`: `support/` is the bottom layer, `core/`
and the adapter packages may both reach it, and all three adapter packages already import from
`@symphony/core/support/` today.

---

## 1. The tagged settle idiom, written out 13 times

_Implemented: `asSettled` in `packages/core/src/support/settled.ts`, applied at all thirteen sites._

**Where.** `packages/core/src/core/dispatch.ts:98`, `:118`;
`packages/core/src/core/polling.ts:64`, `:121`, `:312`, `:460`, `:510`;
`packages/core/src/core/runtime.ts:655`, `:698`, `:725`, `:1084`;
`packages/core/src/core/handoff-reconciliation.ts:220`, `:369`.

Every one of the thirteen is this, character for character apart from one identifier:

```ts
Effect.match({
  onFailure: (error) => ({ _tag: 'Failed' as const, error }),
  onSuccess: (value) => ({ _tag: 'Succeeded' as const, value }),
}),
```

The only thing that varies is the name of the success payload: `value` (×3), `issues` (×3),
`observation` (×3), `result` (×2), `prompt`, `sha`. That variation buys nothing — every call site
reads the field back within ten lines of producing it — and it costs the reader, because
`refreshResult.issues` and `found.result` are the same shape wearing different clothes.

**Proposal.** One combinator in `packages/core/src/support/settled.ts`:

```ts
export type Settled<Value, Failure> =
  Readonly<{ _tag: 'Succeeded'; value: Value }> | Readonly<{ _tag: 'Failed'; error: Failure }>

export const settled = <Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Settled<Value, Failure>, never, Requirements> =>
  Effect.match(effect, {
    onFailure: (error) => ({ _tag: 'Failed' as const, error }),
    onSuccess: (value) => ({ _tag: 'Succeeded' as const, value }),
  })
```

Call sites become `yield* settled(capability.findExistingHandoff(issue))` and keep reading
`if (found._tag === 'Failed')` exactly as they do now; only the success field is renamed to `value`.
Roughly 52 lines of orchestration policy go away, and the type stops being re-declared structurally
at each site.

**Alternative worth weighing.** This is `Effect.either` with a domain-flavoured tag. Using
`Effect.either` outright would add no new vocabulary at all, at the cost of reading `.left`/`.right`
instead of `.error`/`.value` in scheduler code where the domain reading matters. `Settled` keeps the
call sites legible; `Effect.either` keeps the vocabulary smaller. Either beats thirteen copies.

---

## 2. Five generic collection helpers locked inside a policy module

_Implemented: `packages/core/src/support/collections.ts`._

**Where.** `packages/core/src/core/transitions.ts:41` (`withEntry`), `:47` (`withoutEntry`),
`:59` (`withMember`), `:62` (`withoutMember`), `:72` (`capped`).

These are already generic, already pure, and already correct — including the detail that
`withoutEntry` and `withoutMember` return the _original_ collection when there is nothing to remove,
so a no-op transition preserves reference equality. They are just private to a 763-line file about
orchestration state, which is not what they are about.

The cost shows up as soon as anything else needs one. `packages/core/src/telemetry.ts:910` hand-rolls
`withEntry`:

```ts
: new Map(record.changedPaths).set(path, Object.freeze({ ... }))
```

**Proposal.** Move all five to `packages/core/src/support/collections.ts` unchanged and re-export.
They import nothing, so the move is mechanical, and `support/` is reachable from `core/`, both
adapter layers, and the composition root. `telemetry.ts:910` becomes a `withEntry` call, and the
identical patterns in `packages/adapter-codex/src/codex.ts:1047`
(`new Set(state.startedTurns).add(turnId)`) and `packages/adapter-github/src/pagination.ts:59`
(`new Set([...visitedUrls, url])`) get a name.

---

## 3. Process-group control implemented three times — twice next to the copy that already exists

_Implemented: `signalChildGroup`, `childProcessGroupIsAlive`, `detachChildProcess`, and `resumeOnce` are exported from `support/subprocess.ts` and are now the only implementations._

This is the largest verbatim duplication in the repository, and the most surprising, because the
canonical implementations are already sitting in `packages/core/src/support/subprocess.ts` — just not
exported.

| What                                                      | Canonical (unexported)                         | Copy 1                                      | Copy 2                                |
| --------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------- | ------------------------------------- |
| Signal the whole process group, fall back to `child.kill` | `subprocess.ts:171` `signalChildGroup`         | `workspace-hooks.ts:126` `terminate`        | `codex.ts:766` `#terminate`           |
| "Does this child's group still hold a live member?"       | `subprocess.ts:187` `childProcessGroupIsAlive` | `workspace-hooks.ts:121` `hookGroupIsAlive` | `codex.ts:760` `#processGroupIsAlive` |

All three copies of each are identical down to the comment on the inner `catch`. All three files
already import `processGroupIsAlive` from that very module, so nothing about the layering or the
package graph is standing in the way — the two helpers simply were never exported.

**Two more duplicates in the same neighbourhood:**

- **`detach()`** — `packages/adapter-node/src/source-control.ts:140` and
  `packages/adapter-node/src/workspace-hooks.ts:158` are the same seven statements: strip the
  listeners off `stdout`, `stderr`, `error`, and `close`, then re-attach no-op `error` handlers so a
  late event cannot reach Node's uncaught-exception path. Both carry the same reasoning in different
  prose. One `detachChildProcess(child: ChildProcessByStdio<null, Readable, Readable>): void` in
  `support/subprocess.ts` states it once, with one comment explaining why.

- **The settle-once guard** — `source-control.ts:172`, `workspace-hooks.ts:173`, and structurally
  again in `subprocess.ts` (`finish`) and `codex.ts:536` (`#settle`). This one is genuinely generic:

  ```ts
  export const resumeOnce = <Value, Failure>(
    resume: (effect: Effect.Effect<Value, Failure>) => void,
    onSettle: () => void,
  ): ((effect: Effect.Effect<Value, Failure>) => void) => {
    let settled = false
    return (effect) => {
      if (settled) return
      settled = true
      onSettle()
      resume(effect)
    }
  }
  ```

  Two `Effect.async` registrations lose their mutable `settled` flag, and the "settles exactly once"
  guarantee both doc comments promise becomes something a reader can check in one place.

**Worth noting but larger.** The SIGTERM → grace → SIGKILL → poll-for-reap _policy_ also exists three
times: `subprocess.ts` `terminateChildProcess` (promise-based), `workspace-hooks.ts` (raw timers),
and `codex.ts:735` `#reapGroup` (Effect + `Clock`). The mechanics genuinely differ per runtime, so
this is not a copy-paste removal — but the three have independently chosen grace periods and poll
intervals, and a shared statement of the escalation _schedule_ would keep them from drifting further.

---

## 4. `Schema` → domain error: three bespoke wrappers and seven rethrow ternaries

_Implemented: `decodeTracker`, `decodeTrackerOrThrow`, and `trackerCause` in `client.ts`._

**Three wrappers, one shape.** All of these decode with a schema and map the parse failure onto
`trackerResponseError`:

- `packages/adapter-github/src/decode.ts:92` — `decodeOrThrow`, throws (used inside `Effect.try`).
- `packages/adapter-github/src/pull-requests.ts:49` — `decode`, returns `Effect`.
- `packages/adapter-github/src/code-review.ts:26` — `decodePullRequest`, returns `Effect`, but is
  monomorphic in its schema for no reason: it is `decode` with `pullRequestResponse` baked in.

The third should simply call the second. The first and second are the throwing and effectful faces of
one function and belong beside each other in `client.ts`, which already owns
`trackerResponseError`.

**Seven rethrow ternaries.** `packages/adapter-github/src/pagination.ts:51`,
`pull-requests.ts:206`, `issues.ts:190`, `issues.ts:401`, `code-review.ts:229`, `code-review.ts:256`,
and in `throw` form at `client.ts:270`:

```ts
catch: (cause: unknown) =>
  cause instanceof TrackerError ? cause : trackerResponseError('<message>', cause),
```

One helper — `const trackerCause = (message: string) => (cause: unknown): TrackerError =>
  cause instanceof TrackerError ? cause : trackerResponseError(message, cause)` — collapses all
seven to `catch: trackerCause('GitHub comment response is invalid')`. `pagination.ts` and
`client.ts:270` want the pagination category instead, which makes the wrapper the natural
parameter and the whole thing a two-line generic factory.

**Also.** `pull-requests.ts:83` `field` is `decode` with a different error constructor. If the
wrapper is a parameter, `field` and `decode` are one function.

---

## 5. Three parallel vocabularies for the same schema primitives

_Implemented for the adapter's copies: `safeInteger`, `positiveInteger`, and `unknownRecord` join `nonEmptyString` in `support/schema.ts`. The named-message family in the workflow loader is left as it stands._

The repository has invented "non-empty string" and "safe integer" three times, in three modules, in
three styles:

| Concept          | `packages/core/src/support/schema.ts` | `packages/adapter-github/src/decode.ts`              | `src/config/workflow.ts`                                              |
| ---------------- | ------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| non-empty string | `nonEmptyString` (`:92`)              | `nonEmpty` (`:59`)                                   | `nonEmptyString(name)` (`:54`)                                        |
| bounded integer  | `nonNegativeInteger` (`:98`)          | `safeInteger` (`:63`), `positiveSafeInteger` (`:60`) | `integer/positiveInteger/nonNegativeInteger/portNumber` (`:67`–`:82`) |
| loose record     | —                                     | `jsonRecord` (`:64`)                                 | `anyMap(name)` (`:98`)                                                |

`support/schema.ts:92`'s `nonEmptyString` and `decode.ts:59`'s `nonEmpty` are the identical
expression. `decode.ts:64`'s `jsonRecord` is duplicated again at `pull-requests.ts:23`.

The `src/config/workflow.ts` family is _not_ redundant — it takes a field name and attaches the
authored-key message at every refinement level, which is the whole point of that module and is
genuinely different work. But the shape of that work is itself a generic:

```ts
const named = <Value>(
  base: Schema.Schema<Value, Value>,
  name: string,
  message: string,
): Schema.Schema<Value, Value> => ...
```

which would let `integer`, `positiveInteger`, `nonNegativeInteger`, and `portNumber` be four
`filter` + message pairs over one combinator rather than four hand-written `.pipe().annotations()`
chains.

**Proposal.** Have `adapter-github` import the two primitives it duplicates from
`@symphony/core/support/schema.js` (it already imports `support/json.js`, so the path is proven),
add `safeInteger`/`positiveSafeInteger` there beside the existing `nonNegativeInteger`, and export a
single `jsonRecord`. Leave the named-message family in the loader, but factor its repeated
`.pipe(filter).annotations(message)` shape.

---

## 6. `isRecord` inlined at a call site that already imports the exported version

_Implemented: both copies now call `isJsonObject`._

`src/config/workflow.ts:390`:

```ts
typeof value === 'object' && value !== null && !Array.isArray(value)
```

The same file imports `isJsonObject` from `@symphony/core/support/json.js` at line 24, and
`isJsonObject` is exactly that expression. `packages/core/src/support/schema.ts:18` has a third copy
as a private `isRecord`. Three copies, one export, one importer that already has it in scope.

---

## 7. Host-tool executors: the same three-guard preamble twice

_Implemented: `githubHostToolExecutor` in `tools.ts`._

`packages/adapter-github/src/issues.ts:149` and `packages/adapter-github/src/code-review.ts:50` open
with the identical sixteen lines — same factory signature, then spec lookup, credential check, and
issue-number resolution:

```ts
if (!<specs>.some((spec) => spec.name === name)) return unsupportedHostTool(name)
if (Redacted.value(provider.token).length === 0)
  return toolFailure('missing_auth', 'GitHub credential is not configured')
const issueNumber = githubIssueNumber(provider, context)
if (issueNumber === null)
  return invalidToolArguments('Session issue context is invalid for this GitHub adapter')
```

`tools.ts` already exists for exactly this ("host-tool plumbing shared by the tracker's issue tools
and the code-review capability's pull-request tools") and already holds `toolFailure`,
`invalidToolArguments`, `exactObject`, and `githubIssueNumber` — the preamble that _composes_ them
is the one piece that did not move. A `hostToolExecutor(specs, provider, httpClient, run)` taking
`run: (name, args, issueNumber) => Effect.Effect<JsonValue, TrackerError>` would put both executors
on one guard chain, so a future guard is added once.

---

## 8. Scheduler policy predicates written once per configuration source

_Implemented, including the normalization fix and its regression test._

`packages/core/src/core/policy.ts` carries two pairs that differ only in where the same three fields
are read from — `Workflow` (`workflow.config.tracker.*`) or `ExecutionSnapshot` (flat):

- `issueIsActive:18` / `issueIsActiveInSnapshot:32`
- `issueIsRoutable:22` / `issueIsRoutableInSnapshot:35`

A third, inline copy of the routability check lives at `packages/core/src/core/runtime.ts:684`.

**This one is not only duplication — the copies have already drifted.** Both `policy.ts` versions
test `labels.has(label)` against a _pre-normalized_ required label; `runtime.ts:684` tests
`labels.has(label.trim().toLowerCase())`, normalizing at the point of use. They agree today only
because `src/config/workflow.ts:319` normalizes `requiredLabels` on the way in. A required label
that reaches `ExecutionSnapshot` by any other path would be matched by one copy and missed by the
other. That is worth fixing on its own merits, and the fix is the extraction.

**Proposal.** Name the three fields the predicates actually need and write each predicate once:

```ts
type EligibilityRules = Readonly<{
  requiredLabels: readonly string[]
  activeStates: readonly string[]
  terminalStates: readonly string[]
}>

export const eligibilityRules = (workflow: Workflow): EligibilityRules => ...
export const issueIsActive = (issue: Issue, rules: EligibilityRules): boolean => ...
export const issueIsRoutable = (issue: Issue, rules: EligibilityRules): boolean => ...
```

`ExecutionSnapshot` structurally satisfies `EligibilityRules` already, so the snapshot variants
disappear at the call site with no adapter at all, and `runtime.ts:684` calls the one
implementation.

While there: the label-normalizing set — `new Set(issue.labels.map((l) => l.trim().toLowerCase()))`
— appears at `policy.ts:26`, `policy.ts:39`, and `runtime.ts:684`, and again in different spelling in
`packages/adapter-github/src/decode.ts:193`. One `normalizedLabels(issue)` covers the first three.

---

## 9. Two byte-identical comparators, and a comparator shape repeated three times

`src/operator/ui/model.ts:196` `comparePriority` and `:209` `compareNumber` are the same eleven
lines; substituting the name makes `diff` report no difference at all. Both are "compare two
nullables, nulls last".

Three call sites then repeat the same rank-then-tie-break structure — `byAttention:532`,
`byProgress:568`, and `byReadiness:547` — each spelling out `indexOf`, compare, fall through.

**Proposal.** Two small generics, which is all the UI needs:

```ts
const nullsLast =
  <Value>(compare: (left: Value, right: Value) => number) =>
  (left: Value | null, right: Value | null): number =>
    left === right ? 0 : left === null ? 1 : right === null ? -1 : compare(left, right)

const byRank =
  <Value, Key>(order: readonly Key[], key: (value: Value) => Key) =>
  (left: Value, right: Value): number =>
    order.indexOf(key(left)) - order.indexOf(key(right))

const chain =
  <Value>(...comparators: readonly ((l: Value, r: Value) => number)[]) =>
  (left: Value, right: Value): number =>
    comparators.reduce((result, compare) => (result === 0 ? compare(left, right) : result), 0)
```

`byAttention` becomes `chain(byRank(attentionOrder, ...), byPriority, byIssueNumber)` and the four
comparators stop restating their fall-through by hand.

`packages/core/src/core/policy.ts:143` `sortIssues` is the same chained-comparator shape on the
server side, though it cannot share the browser helpers as things stand.

**Related.** `policy.ts:76` `identifierIssueNumber` and `src/operator/ui/model.ts:191`
`issueNumberOf` parse the same `/#(\d+)$/u` from the same identifiers, differing only in returning
`Option` versus `null` — which is exactly the boundary `AGENTS.md` describes, so this pair is
defensible. `src/operator/server.ts:75` holds a third, stricter reading of the same format. Worth a
shared regexp constant even if the three readings stay separate.

---

## 10. Test fixtures: the generic that would remove the most lines in the repository

83 distinct five-line blocks are duplicated across two or more test files. They are almost all object
literals restating a record's every field to vary one:

- The `makeGitSourceControl({ remoteUrl: fixture.remote, baseBranch: 'main', credential: Option.none() })`
  block appears at **9** sites across `test/source-control.test.ts`,
  `test/source-control-interruption.test.ts`, `test/subprocess-stream-errors.test.ts`, and
  `test/conformance/source-control.conformance.test.ts`. `test/harness/git-repository.ts` already
  builds the fixture it takes; it should build this too.
- `PullRequestObservation` literals (`mergeCommitSha`/`mergeable`/`mergeState`/`checks`/…) at 5 sites.
- `AgentDetailSnapshot` identity literals at 4 sites across three files.
- The codex config block (`approvalPolicy`/`threadSandbox`/`turnSandboxPolicy`/…) at 4 sites.
- The `unsupported_tool` failure literal at 4 sites — and `unsupportedHostTool` in
  `packages/core/src/domain/host-tools.js` already produces it.

**Proposal.** One generic builder in `test/harness/`, which is the shape every one of these wants:

```ts
export const fixture =
  <Value extends object>(base: Value) =>
  (overrides: Partial<Value> = {}): Value => ({ ...base, ...overrides })
```

Then `test/harness/console-fixtures.ts` — which already owns the console's shared records — grows
`pullRequestObservation()`, `agentDetail()`, `codexConfig()`, and the tests state only the field
under test. The type parameter is what makes it worth having: `Partial<Value>` keeps every override
checked against the real record, so a field renamed in `packages/core` still fails the build in the
tests rather than being silently ignored.

---

## 11. One naming hazard found on the way (not a generics finding)

`packages/core/src/core/polling.ts:36` and `packages/core/src/core/handoff-reconciliation.ts:70`
both define `writeHandoff` with the identical signature
`(context: OrchestratorContext, id: IssueId, handoff: HandoffEntry) => Effect.Effect<void>` — and
different behaviour. The polling one also runs `context.persistHandoffs`; the reconciliation one only
updates the `Ref`.

Whether that difference is intentional is a question for whoever owns the handoff lifecycle, but two
same-named, same-typed, differently-behaving functions one directory apart will eventually be
confused for each other. If both behaviours are wanted, the names should say which is which
(`writeHandoff` / `stageHandoff`); if only one is, they should be one function.

---

## Summary

| #   | Finding                                        | Sites                                   | Removes               | Risk                                            |
| --- | ---------------------------------------------- | --------------------------------------- | --------------------- | ----------------------------------------------- |
| 1   | Tagged settle idiom                            | 13                                      | ~52 lines             | Low — mechanical                                |
| 2   | Collection helpers private to `transitions.ts` | 5 helpers + 3 hand-rolls                | —                     | Low — pure move                                 |
| 3   | Process-group control triplicated              | 6 copies + 2 `detach` + 4 settle guards | ~60 lines             | Low — canonical copies exist                    |
| 4   | Schema→`TrackerError` wrappers and rethrows    | 3 + 7                                   | ~30 lines             | Low                                             |
| 5   | Schema primitive vocabulary                    | 3 modules                               | ~15 lines             | Low                                             |
| 6   | `isRecord` inlined beside its own import       | 3                                       | 2 lines               | Trivial                                         |
| 7   | Host-tool executor preamble                    | 2                                       | ~16 lines             | Medium — touches tool dispatch                  |
| 8   | Policy predicates per config source            | 5                                       | ~20 lines             | Medium — **fixes a latent normalization drift** |
| 9   | UI comparators                                 | 2 identical + 3 shapes                  | ~25 lines             | Low                                             |
| 10  | Test fixture literals                          | 83 dup blocks                           | Several hundred lines | Low — tests guard themselves                    |
| 11  | `writeHandoff` name collision                  | 2                                       | —                     | Needs an owner's decision                       |

The highest value per unit of risk is **1, 2, 3, and 6**: all four are moves or one-for-one
substitutions with the canonical implementation already written and already reachable under the
layering rules. **8** is the one finding that is a correctness fix as well as a cleanup, and should
not be left for later. **10** removes the most lines but touches the most files, so it is best done
per-record rather than in one pass.
