# Linear tracker adapter design

Status: proposed. This document is the design record for a second tracker profile beside GitHub
Issues. It changes no code; it states what the adapter must supply, which decisions it forces, and
which of them require a change under `packages/core/`.

The port boundary in [`AGENTS.md`](../AGENTS.md) is the constraint this design works inside, not a
constraint it proposes to move. Where a decision below would move it, that is said explicitly.

## 1. Why Linear is the useful second profile

The tracker ports were extracted against one provider, so nothing yet proves they are provider
neutral rather than GitHub-shaped with the GitHub parts renamed. Linear is the profile that tests
that claim hardest, because it disagrees with GitHub on all four axes the ports abstract over:

| Axis            | GitHub                                     | Linear                                                  |
| --------------- | ------------------------------------------ | ------------------------------------------------------- |
| Transport       | REST, `Link`-header pagination             | GraphQL, Relay cursor connections                       |
| Failure channel | HTTP status                                | `errors[]` inside an HTTP 200 body                      |
| State model     | two fixed states, `open` and `closed`      | arbitrary per-team workflow states with a coarse `type` |
| Code review     | supplies `CodeReviewPort` from same config | supplies none; the code host is a different system      |

The first three are adapter-local: they are why `packages/adapter-linear` is a real package rather
than a parameterization of the GitHub one, and none of them reaches `packages/core/`. The fourth is
not adapter-local, and it is the whole of section 4.

The parts that turn out to need nothing are as informative as the parts that do. `Issue.branchName`
and `Issue.priority` exist in the domain record because the upstream specification was written
against Linear; both are dead weight under GitHub (`branchName` is always `null`, `priority` is
recovered from a `priority:N` label convention) and both are populated natively here. In particular
Linear's `priority` — `0` none, `1` urgent through `4` low — is already exactly the ordering
`sortIssues` in `packages/core/src/core/policy.ts:143` implements, including its treatment of `0`
as unprioritized. It is copied through unchanged. And `workspaceKey` in
`packages/core/src/domain/workspace-containment.ts:26` sanitizes `ENG-123` to itself, where it has
to hash GitHub's `owner/repo#123`, so Linear workspace directories are the readable case rather
than the degraded one.

## 2. Phase 1 — Linear as a standalone tracker

Phase 1 changes no file under `packages/core/` and no file under `packages/adapter-github/`. It
adds one package and one entry in the composition root's registry list.

### 2.1 Package placement

```
core  <-  adapter-node  <-  adapter-github, adapter-codex, adapter-linear  <-  root application
```

`packages/adapter-linear` (`@symphony/adapter-linear`) sits beside `adapter-github` at the same
tier, depends on `@symphony/core` and `@symphony/adapter-node`, and names `@symphony/adapter-github`
nowhere. `test/package-boundaries.test.ts:20` holds the permitted-dependency map that has to gain
the entry:

```ts
'@symphony/adapter-linear': ['@symphony/adapter-node', '@symphony/core'],
```

`tsconfig.build.json` gains a project reference and `pnpm-workspace.yaml` needs no change
(`packages/*` already covers it).

### 2.2 Provider configuration

`tracker.provider` reaches the adapter as the exact authored JSON object, and the adapter owns its
validation, as `packages/adapter-github/src/provider.ts` does for GitHub.

| Key            | Required | Default                          | Notes                                        |
| -------------- | -------- | -------------------------------- | -------------------------------------------- |
| `api_key`      | yes      | —                                | Must be a `$VAR` reference                   |
| `team_key`     | yes      | —                                | The provider scope, e.g. `ENG`               |
| `api_base_url` | no       | `https://api.linear.app/graphql` | Absolute `http(s)` URL; trailing slash trimmed |
| `repository`   | no       | —                                | Git remote URL; see §2.8                     |
| `base_branch`  | no       | `main`                           | Only meaningful with `repository`            |

Rejected with `invalid_config`: a missing or empty `api_key`/`team_key`, a literal (non-`$VAR`)
`api_key`, an `api_key` that reuses `OPENAI_API_KEY` or `CODEX_ACCESS_TOKEN`, a `$VAR` whose
variable is unset or empty, a non-absolute `api_base_url`, and a `base_branch` without a
`repository`. Unknown provider keys are preserved and ignored. The credential is held as
`Redacted.Redacted<string>` from the moment it leaves the environment and unwrapped only in the
`Authorization` header, exactly as the GitHub token is.

**Secret environment names.** The GitHub adapter strips its configured variable plus the
`GITHUB_TOKEN` and `GH_TOKEN` aliases that GitHub tooling reads without being told to. Linear's CLI
and SDK read `LINEAR_API_KEY`, so `linearSecretEnvironmentNames` returns the configured variable
plus that alias. Under a composite configuration (§4) the two adapters' lists are unioned, because
the child environment is one environment.

**Scope is one team.** `team_key` rather than a workspace-wide read: Linear's issue graph is a
workspace, and an unscoped `issues` query over a large workspace is a paginated read with no
bound that an operator authored. One team is the analogue of one repository, it is what the state
names in §2.5 are unique within, and multi-team scope can be added later as a list without
invalidating any decision here.

### 2.3 Transport

Linear is GraphQL-only, so `packages/adapter-github/src/client.ts` and `pagination.ts` are not
reusable as written — they are shaped around a URL per resource, a `Link` header, and an HTTP
status that carries the failure. What is genuinely shared is smaller than it looks: the request
deadline, the rate-limit delay arithmetic (`parseRetryAfterMs`), and the JSON-body guard.

**Recommendation: duplicate, do not extract.** Roughly 60 lines are common and the two clients
disagree about the thing the surrounding code is organized around. A shared `adapter-http` package
would be a fifth architectural unit carrying a handful of parsers, and `AGENTS.md` is explicit that
`adapter-node` is for host-platform concerns, which HTTP is not. Revisit if a third HTTP-speaking
provider adapter arrives; two is not yet a pattern.

The Linear client exposes one operation, `linearGraphQL(provider, document, variables)`, returning
the decoded `data` field or failing with a `TrackerError`. Every query is a named document constant
in the adapter; no query text is ever assembled from model-authored input.

**Pagination.** Relay connections: `first: 100`, `after: $cursor`, following
`pageInfo { hasNextPage endCursor }`. The two integrity bounds the GitHub `paginate` enforces carry
over unchanged and for the same reasons — a repeated cursor is a cycle, and more than 100 pages for
one scoped read is a runaway list; both are `tracker_pagination` failures rather than a silently
truncated read. There is no off-origin risk to check for, because a cursor is not a URL: the
endpoint is fixed at `api_base_url` for every page. That is the one GitHub pagination rule with no
Linear equivalent, and it should be *absent* rather than simulated.

### 2.4 Failure mapping

This is the mapping that carries the most risk of being got wrong, because Linear reports most
application-level failures as `errors[]` inside an HTTP 200 body. A client that switches on status
alone reads an authentication failure as a successful empty response.

| Condition                                              | Category               | Retryable |
| ------------------------------------------------------ | ---------------------- | --------- |
| Transport failure or the 30 s deadline                 | `tracker_request`      | yes       |
| `429`, or an `errors[]` entry coded as rate limiting   | `tracker_rate_limited` | yes       |
| `5xx`, `408`                                           | `tracker_status`       | yes       |
| `401`/`403`, or an `errors[]` authentication code      | `tracker_status`       | no        |
| Other non-success status                               | `tracker_status`       | no        |
| Non-JSON body, or `data` absent with no `errors[]`     | `tracker_response`     | no        |
| `errors[]` present with any other code                 | `tracker_response`     | no        |
| Cyclic or unbounded cursor pagination                  | `tracker_pagination`   | no        |

Two properties this table has to preserve, because the orchestrator's retry policy depends on them
and neither is provider-specific: a rate-limit failure carries `retryAfterMs` when the provider
advertised a delay, and a partial GraphQL response — `data` present *and* `errors[]` present — is a
`tracker_response` failure rather than a partial success. Symphony reads whole scoped lists and
dispatches against them; half a backlog is not a backlog.

Linear also enforces a query-complexity budget separately from a request-count budget. Both are
rate limiting as far as this table is concerned, but the complexity budget is why §2.5 selects
fields explicitly rather than over-fetching a convenient superset.

### 2.5 Normalization

The GitHub profile calls this Section 11.3 normalization; the same table for Linear:

| Field                     | Source                            | Rule                                                   |
| ------------------------- | --------------------------------- | ------------------------------------------------------ |
| `id`                      | `id`                              | Required UUID, opaque to the core                      |
| `nativeRef`               | `{ id, identifier, team_id, team_key }` | Required                                         |
| `identifier`              | `identifier`                      | `ENG-123`, verbatim                                    |
| `title`                   | `title`                           | Required, non-empty                                    |
| `description`             | `description`                     | Nullable; empty becomes `null`                         |
| `priority`                | `priority`                        | Copied through; `0` and absent both sort last          |
| `state`                   | `state.name`                      | Trimmed, lowercased — see below                        |
| `branchName`              | `branchName`                      | Populated natively                                     |
| `url`                     | `url`                             | Nullable                                               |
| `assigneeId`              | `assignee.id`                     | Nullable                                               |
| `labels`                  | `labels.nodes[].name`             | Trimmed, lowercased, deduplicated                      |
| `blockedBy`               | inverse `blocks` relations        | See §2.6                                               |
| `dispatchable`            | provider eligibility              | `false` for open blockers or cycle members             |
| `createdAt` / `updatedAt` | `createdAt` / `updatedAt`         | Nullable; unparsable becomes `null`                    |

**Decision: `state` is the workflow state's name, not its type.** Linear gives every state both a
team-authored `name` ("In Review") and one of six fixed `type` values (`triage`, `backlog`,
`unstarted`, `started`, `completed`, `canceled`). Either could fill `Issue.state`.

The name wins, for three reasons. `tracker.active_states` and `tracker.terminal_states` are strings
an operator writes in `WORKFLOW.md`, and an operator who wants Symphony to pick up "Ready for Agent"
means that state and not every state of type `unstarted`. `agent.max_concurrent_agents_by_state`
keys on the same vocabulary and is only useful at the resolution the team actually works in. And
`state.type` is a six-way funnel that would make several distinct states indistinguishable to the
scheduler, which is a loss of information the configuration cannot recover.

The cost is that state names are per-team free text, so a renamed Linear state silently stops
matching a workflow file. That cost is paid where it is visible: `state.type` is carried in
`nativeRef` for diagnostics, and a state-list read whose configured states match no state in the
team logs a warning naming the configured states and the states the team actually has. This is the
one place the adapter is more talkative than the GitHub one, and it is warranted — GitHub's two
states cannot be misspelled in a way that looks like an empty backlog.

`normalizeState` in `packages/core/src/domain/domain.ts:58` already trims and lowercases on both
sides of every comparison, so `In Review` in Linear and `in review` in `WORKFLOW.md` match without
any adapter-side aliasing.

**Reading by state.** `fetchIssuesByStates(states, …)` filters server-side:

```graphql
issues(
  filter: { team: { key: { eq: $teamKey } }, state: { name: { in: $states } } }
  first: 100
  after: $cursor
)
```

Names are matched case-insensitively by re-reading the team's states once per tracker instance and
resolving each configured state to its exact Linear spelling; the resolution is what the warning
above is derived from. It is cached for the life of the tracker instance, which a workflow reload or
a credential rotation replaces anyway.

### 2.6 Dependencies

`blockedBy` for issue X is X's inverse relations of type `blocks` — the issues that block it. Each
becomes a `BlockerRef` of `{ id, identifier, title, state: state.name, url }`, with `state`
normalized the same way as the issue's own, because `unresolvedBlockers` in
`packages/core/src/domain/dependencies.ts:8` compares blocker states against the configured
terminal states.

**Decision: hydrate in the list query, not in a second pass.** The GitHub adapter must fetch
`dependencies/blocked_by` per issue at concurrency 4 and cache the result for 60 s keyed on the
issue's `updated_at`, because REST gives it no way to ask for the backlog and its blockers at once.
GraphQL does. Selecting the inverse relations inside the same connection removes the N+1, and with
it the entire dependency cache — no `Ref`, no `HashMap`, no TTL, no staleness window.

That trades request count for query complexity, which is metered (§2.4). The exchange is favorable
at Symphony's scale: one moderately complex query against a per-team backlog, versus one list
request plus one request per dispatch candidate. `IssueFetchOptions.hydrateDependencies: false`
remains meaningful — it drops the relation selection from the query, which is exactly what the
startup terminal sweep wants and what keeps that sweep cheap.

`dependencyLabels` keeps its documented meaning (`null` hydrates every candidate, a list hydrates
only candidates carrying all of those labels, an empty list hydrates none), implemented as a filter
on which issues' relations are selected. Cycle detection is unchanged: `cyclicIssueIdentifiers`
from `packages/core/src/domain/dependencies.ts` runs over the normalized set, as it does for GitHub.

Linear has no pull-request records mixed into its issue list, so the `isPullRequest` exclusion that
gates GitHub's `dispatchable` has no analogue and must not be invented. Linear's `dispatchable` is
open blockers and cycle membership only.

### 2.7 Host tools

Two tools, mirroring the GitHub tracker's two. Names are provider-prefixed for the same reason
GitHub's are: a session advertises exactly one adapter's tools, and the prefix keeps a transcript
honest about which system was mutated.

| Tool                   | Accepted arguments                                     | Host mutation                                    |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| `linear_add_comment`   | exactly `{ body }`                                     | `commentCreate` on the current issue             |
| `linear_handoff_issue` | one or more of `state`, `add_labels`, `remove_labels`  | `issueUpdate` with resolved state and label ids  |

The session's issue is taken from `HostToolContext.nativeRef`, never from arguments, and the
context is checked against the configured team before any mutation — the analogue of
`githubIssueNumber` in `packages/adapter-github/src/tools.ts:43`, and the check that makes these
tools unable to reach an issue outside provider scope.

Linear forces one difference in kind from GitHub. `issueUpdate` takes state and label **ids**, not
names, so `linear_handoff_issue` must resolve names before mutating. Resolution is host-side against
the configured team, reusing the state cache from §2.5, and a name that does not resolve is
`invalid_arguments` — never a created state or a created label. The model can move an issue between
states the team already has and apply labels the team already has, and can bring neither into
existence. That is a narrower authority than the GitHub tool has, where `POST /labels` creates a
missing label as a side effect, and the narrowing is deliberate.

Ordering and atomicity match the documented GitHub behavior: state, then adds, then removes, not
transactional, an earlier mutation can remain applied if a later one is rejected, and removing an
absent label succeeds. The failure vocabulary is unchanged —
`invalid_arguments`, `missing_auth`, `authorization_failed`, `rate_limited`, `transport_error`,
`provider_error`, `unsupported_tool` — mapped from the categories in §2.4.

No tool exposes arbitrary GraphQL, issue selection, team selection, issue creation, comment
deletion, or state/label creation.

### 2.8 Source control

Linear does not host code, so it cannot derive a Git remote the way
`packages/adapter-github/src/source-control.ts` derives one from `owner`/`repository`. The provider
config declares it (`repository`, `base_branch`), and the adapter passes it to the same generic
`makeGitSourceControl` in `packages/adapter-node`. This is why those keys are in the table in §2.2.

**Decision: credentials for that remote are the ambient Git environment's, not the adapter's.** The
GitHub adapter injects `x-access-token:<token>` because it holds a credential that is valid for the
remote it also derived. Linear's API key authenticates nothing on GitHub. Passing
`credential: Option.none()` and letting the host's existing Git credential configuration serve the
push is the honest representation; inventing a second `repository_token` provider field would be a
credential the tracker adapter has no other use for and would duplicate what Phase 2 supplies
properly.

The consequence is that Phase 1 standalone Linear requires the host to have push access to the
declared remote configured out of band. When `repository` is omitted the adapter supplies no
`SourceControlPort` at all, which the composition root already handles (`Effect.succeed(null)`).

### 2.9 Issue control

`listOpenIssues` reads the team's non-completed, non-canceled states with dependencies hydrated and
retains blocked and cyclic issues for readiness diagnostics, as the GitHub one does.

`addLabel(issueNumber: number, label: string)` is the problem. Its first parameter is a `number`,
and Linear issue identity is a UUID. This signature in
`packages/core/src/ports/issue-control.ts:15` is GitHub's issue number leaking through a port that
is supposed to be tracker-neutral — the one place in the port layer where that is true.

**Decision: change the signature to `addLabel(issueId: IssueId, label: string)`.** `IssueId` is
already the core's opaque dispatch identity, it is what `Issue.id` carries, and the operator console
has an `Issue` in hand when it calls this. The GitHub adapter parses it back to a number at its own
boundary, which is where the parse belongs, and its existing positive-safe-integer validation moves
there unchanged. This touches `packages/core/src/ports/issue-control.ts`, the GitHub adapter, and
the console server in `src/operator/`; it is small, and doing it in Phase 1 is what keeps the port
neutral rather than accumulating a second adapter's workaround around it.

### 2.10 Handoff is disabled

Linear supplies no `CodeReviewPort`. Per `AGENTS.md`, that is a legitimate configuration expressed
by composing no code-review services, and the registry entry simply omits `codeReview` — which
`makeTrackerPortFactories` in `src/tracker-adapters.ts:98` already turns into
`Effect.succeed(null)`. A standalone Linear deployment runs the core continuation lifecycle: agents
work issues, publish branches, and move issues between Linear states through
`linear_handoff_issue`. Nothing opens or merges a pull request.

That is a real limitation and not a temporary one — it is what Phase 2 exists to lift.

### 2.11 Two tests break by name

`linear` is currently the canonical *unsupported* tracker kind in
`test/config/workflow.test.ts:710` and `test/domain/tracker-provider.test.ts:34`, and one of those
asserts the exact message `unsupported tracker.kind: linear (supported: github)`. Registering the
kind makes both assertions wrong in a way that is correct behavior. They should move to a name that
will not become real — `test/harness/stub-tracker-provider.ts` already establishes the convention
for a deliberately synthetic kind.

## 3. Worked configuration

```yaml
tracker:
  kind: linear
  provider:
    api_key: $LINEAR_API_KEY
    team_key: ENG
    repository: https://github.com/acme/service.git
    base_branch: main
  required_labels: [agent]
  active_states: [todo, in progress]
  terminal_states: [done, canceled]
```

## 4. Phase 2 — Linear issues with GitHub code review

Phase 1's standalone profile is honest but incomplete: the configuration people actually run is
issues in Linear and code in GitHub. Supporting it is a change to the composition model, so it is
specified here and built separately.

### 4.1 The obstacle

`ValidatedTrackerProvider` is one selection, and every capability is constructed from it:
`layerCurrentTracker`, `layerCurrentCodeReview`, and `layerCurrentSourceControl` each take the same
provider, and `RegisteredTrackerProvider` hangs all four factories off one `kind`. There is no way
to say "tracker from this selection, code review from that one".

The wrong fix is a nested `code_review` block inside `tracker.provider` that the Linear adapter
validates and delegates to the GitHub one. It would make `adapter-linear` depend on
`adapter-github`, which `test/package-boundaries.test.ts` denies and `AGENTS.md` states as an
invariant — the two provider adapters name each other nowhere.

### 4.2 The change

Add a sibling front-matter section, validated through the same registry:

```yaml
tracker:
  kind: linear
  provider: { api_key: $LINEAR_API_KEY, team_key: ENG }

code_review:
  kind: github
  provider:
    owner: acme
    repository: service
    token: $GITHUB_TOKEN
    base_branch: main
```

`EffectiveConfig` gains `codeReview: TrackerConfig | null` and `Workflow` gains
`codeReview: ValidatedTrackerProvider | null`. `layerCurrentCodeReview` and
`layerCurrentSourceControl` take *that* selection when it is present and the tracker selection when
it is not — so today's GitHub-only workflows, where the two are the same provider, behave
identically and need no edit. The composition root remains the only place that names two concrete
adapters, which is exactly what it is for.

Revalidation and reload follow: `validateWorkflowCredentials` revalidates both selections, and a
rotated credential on either rebuilds only the cells constructed from it. Handoff enabled against a
selection that supplies no `CodeReviewPort` stays the operator-visible configuration error it
already is; it now names which of the two sections failed to supply one.

### 4.3 Three things break, and they are the interesting part

The composite is what proves whether `CodeReviewPort` is genuinely independent of the tracker. Three
places in the GitHub code-review implementation quietly assume the tracker is also GitHub:

**`Closes #${issue.id}`** — `packages/adapter-github/src/code-review.ts:175` builds the pull-request
body from the issue's dispatch id. Under GitHub that id *is* the issue number and the reference
auto-closes; under a Linear tracker it renders `Closes #` followed by a UUID, which is meaningless
on both sides. The body must be built from tracker-neutral fields, `issue.identifier` and
`issue.url`, with the `Closes #id` line emitted only when the code-review selection is the same
selection as the tracker (`sameTrackerProvider` answers this, and the composition root already has
both). Linear closes its own issue when it sees the identifier in a linked pull request, so the
neutral form is not a downgrade.

**`github_link_pull_request`** — this tool resolves the session's issue through
`githubIssueNumber(provider, context)`, which reads `nativeRef.owner`, `nativeRef.repository`, and
`nativeRef.issue_number`. Under a composite, `nativeRef` is Linear's and none of those keys exist,
so the tool would refuse every call with `invalid_arguments`. It must be *absent* from the
advertised tool set when the code-review selection is not the tracker selection — there is no GitHub
issue to comment on — and the Linear tracker's own comment tool serves the linking need.
`CodeReviewPort.toolSpecs` is already the seam for this; the specs become a function of whether the
selections match.

**`issueBranchName`** — `packages/core/src/domain/handoff.ts:160` returns
`symphony/issue-${issue.id}` and ignores `Issue.branchName` entirely, which is defensible while
`branchName` is always `null`. Under Linear it is populated, and it is the branch name Linear's own
GitHub integration matches to link a pull request back to the issue and advance its state.
Preferring it — `issue.branchName ?? symphony/issue-${issue.id}` — is what makes the two systems
close the loop without Symphony brokering it, and it changes nothing for GitHub, where the left
operand is always
`null`. It does mean the branch name comes from provider data rather than a host-controlled
template, so it must be validated as a Git ref before it reaches a command line.

The first two are adapter-local. The third is a three-line change in `domain/` with a validation
obligation attached, and it is the only core change Phase 2 needs beyond the wiring in §4.2.

## 5. Test plan

The suite is deterministic and runs against a fake transport, as the GitHub tests do; no test needs
a Linear credential.

| Area                  | What is asserted                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Provider validation   | Every `invalid_config` row in §2.2; `$VAR` resolution through a test `ConfigProvider`; equality across a rotated key |
| Transport             | `errors[]` in an HTTP 200 maps per §2.4; a partial response fails; a rate-limit code carries `retryAfterMs` |
| Pagination            | Cursor following; a repeated cursor is a cycle; the page bound fails rather than truncating          |
| Normalization         | The §2.5 table field by field; `priority` `0` sorts last; a malformed record in a list is skipped with a warning naming it, while one in an id refresh fails the call |
| States                | Case-insensitive matching; a configured state with no team match warns and names both sets            |
| Dependencies          | Relations become `blockedBy`; blockers in terminal states resolve; cycles are undispatchable; `hydrateDependencies: false` drops the selection |
| Host tools            | Exact argument schemas; out-of-team `nativeRef` refused; an unresolvable state or label name is `invalid_arguments` and creates nothing; mutation order and non-atomicity |
| Secret hygiene        | The key appears in no tool schema, argument, result, log line, or serialized provider record; `LINEAR_API_KEY` is stripped from the child environment |
| Boundaries            | `test/package-boundaries.test.ts` gains the entry; the adapter imports no sibling adapter             |
| Phase 2               | A composite workflow builds a Linear tracker with a GitHub code review; the pull-request body carries no `Closes #uuid`; `github_link_pull_request` is unadvertised; `issue.branchName` is preferred and ref-validated |

`test/harness/fake-tracker.ts` and `test/harness/stub-tracker-provider.ts` already cover what a
second adapter needs from the harness. A `docs/conformance-matrix.md` column for the Linear profile
should follow the adapter, not precede it.

## 6. Decisions requiring sign-off

| # | Decision                                                                | Section |
| - | ----------------------------------------------------------------------- | ------- |
| 1 | `Issue.state` is the workflow state's name, not its type                | §2.5    |
| 2 | Dependencies hydrate in the list query; no per-issue cache              | §2.6    |
| 3 | Host tools resolve state and label names but never create either        | §2.7    |
| 4 | Standalone Linear uses ambient Git credentials, not a provider field    | §2.8    |
| 5 | `IssueControlPort.addLabel` takes an `IssueId` rather than a `number`   | §2.9    |
| 6 | The GraphQL client is duplicated rather than extracted to a new package | §2.3    |
| 7 | Composite selection is a sibling `code_review:` section                 | §4.2    |
| 8 | `issueBranchName` prefers a tracker-supplied `branchName`               | §4.3    |

## 7. External facts to confirm before implementation

This design was written against the Linear API's documented shape. Each of these determines code
that is otherwise fully specified above, and each should be checked against the current API
reference rather than trusted from here:

- The `Authorization` header form for a personal API key versus an OAuth token.
- The maximum `first:` page size on issue connections.
- The exact rate-limit response header names, and the `extensions` code for a rate-limited error.
- Whether authentication failures arrive as an HTTP status, an `errors[]` entry, or both.
- The precise relation direction that yields "issues blocking this one" (`inverseRelations` filtered
  to type `blocks`), and whether `blocks` is the only relation type that should count as blocking.
