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

The `effect`, `@effect/platform`, and `@effect/platform-node` versions are pinned as a compatible
Effect 3 set. Update them together: Platform releases declare Effect-line peer ranges, and a partial
upgrade can produce incompatible HTTP runtime types or behavior.

## Run

```sh
pnpm build
GITHUB_TOKEN=github_pat_... pnpm start -- WORKFLOW.md
```

Tracker credentials in repository-owned workflow files must use `$VAR` references; literal tracker
tokens are rejected. The host retains the reference's environment-variable name as secret
provenance, without making another plaintext token copy, and removes that name plus the GitHub
fallback aliases `GITHUB_TOKEN` and `GH_TOKEN` from Codex subprocess environments. Codex's own
`OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` authentication sources are always preserved, and tracker
configuration may not reuse those names. Each eligible issue must carry the `symphony` label.
Workspaces live under `.symphony/workspaces` and are never treated as trusted paths until
containment checks pass.

The configured operator console is available at `http://127.0.0.1:3000`. It shows live and retrying
agents, session totals, and the open GitHub backlog. **Start** adds the configured orchestration label;
**Pause** removes it and reconciliation stops the worker. The browser never receives GitHub or
ChatGPT credentials. Override the workflow port with `--port 8080`, or use `--port 0` to select an
ephemeral port.

The server deliberately binds only to loopback. From another machine, reach an LXC deployment with
an SSH tunnel:

```sh
ssh -L 3000:127.0.0.1:3000 symphony-host
```

After a normal agent turn, Symphony looks for the expected `symphony/issue-<number>` branch. When
the branch exists, the host creates or reuses an open pull request and stops continuation turns.
Dispatch labels remain unchanged. Without a pushed branch, Symphony preserves the workspace and
continues the issue. Pull-request operations use only the host-side GitHub credential.

After handoff, Symphony persists the PR under the workspace root and monitors its exact head SHA,
CI checks, mergeability, review decision, and unresolved review threads. Failed checks, requested
changes, stale branches, and conflicts return to the coding agent with repair context. A clean PR is
squash-merged only through the repository protection rules with an expected-head guard. The
operator console shows each active handoff and its current blocker; no handoff or pause transition
removes the Symphony label.

## Configuration

`WORKFLOW.md` has YAML front matter followed by a strict Liquid template. Supported sections are
`tracker`, `polling`, `workspace`, `hooks`, `agent`, `codex`, and `server`. The current tracker
profile is GitHub Issues; the orchestration interfaces keep tracker and workspace concerns separate
so additional profiles can be implemented without weakening the domain types.

Unknown front-matter keys are preserved verbatim on `config.extensions` and otherwise ignored, so a
newer workflow file stays loadable on an older host without weakening required-field validation.

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

`codex.approval_policy` accepts `untrusted`, `on-request`, or `never`, and
`codex.thread_sandbox` accepts `read-only`, `workspace-write`, or `danger-full-access`; both are
Codex-owned values that must stay aligned with the generated App Server schemas.
`codex.turn_sandbox_policy` is an escape hatch: when set, the map is passed to `turn/start` as
`sandboxPolicy` verbatim instead of the host-derived workspace-write policy.

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

### Adapter-owned provider configuration

`tracker.provider` is kept as the exact JSON object that was authored and is handed to the adapter
selected by `tracker.kind`; the core configuration layer never decodes provider-specific fields.
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
| `dispatchable`            | `pull_request`                  | `false` when the record is a pull request                   |
| `createdAt` / `updatedAt` | `created_at` / `updated_at`     | Nullable; unparsable becomes `null`                         |

**Dispatchability.** State-list reads return every normalized record in scope, including
`dispatchable=false`; the orchestrator owns filtering. Dependency hydration is skipped for
non-dispatchable records, and the operator backlog filters them out for display.

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
`SYMPHONY_INTEGRATION_REPOSITORY`, `GITHUB_TOKEN`, and `OPENAI_API_KEY`/`CODEX_API_KEY` as skipped.
When a CI job explicitly sets `SYMPHONY_REAL_INTEGRATION=1`, missing credentials or integration
failures fail the job. The profile creates a uniquely named temporary workspace and removes it in a
`finally` block; its GitHub check is read-only and creates no tracker artifacts.

The complete bullet-to-test mapping is in
[the Section 17/18 conformance matrix](docs/conformance-matrix.md).

This project is independent of OpenAI and is not an official OpenAI distribution.
