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

### GitHub Issues adapter profile

The supported `tracker.kind` is exactly `github`. `tracker.provider` requires `owner`, `repository`,
and `token`; `api_base_url` defaults to `https://api.github.com` and `base_branch` defaults to
`main`. `token` must be a `$VARIABLE` reference. Its resolved variable, plus the GitHub fallback
aliases `GITHUB_TOKEN` and `GH_TOKEN`, is removed from agent subprocesses. Missing keys, wrong value
types, literal credentials, missing referenced variables, Codex authentication variables used as
tracker credentials, and unsupported tracker kinds are `WorkflowError` values with category
`invalid_config` and a message naming the invalid key.

Scope is the single configured `owner/repository`. State reads call GitHub's repository Issues API
once per requested state and include both issues and pull requests; pull requests normalize with
`dispatchable=false` and remain visible to the orchestrator. Empty state and ID sets make no GitHub
requests. List and dependency endpoints request the maximum 100 records per page and follow
same-origin `Link: rel="next"` URLs until exhausted; cycles, invalid links, and cross-origin links
fail the whole operation. States are read sequentially, ID refreshes and dependency reads use at
most four concurrent requests, duplicate requested IDs and duplicate returned dispatch IDs are
collapsed, and a scoped `404` during ID refresh is omitted.

The dispatch `id` is the issue number encoded as an opaque string. `identifier` is
`owner/repository#number`. `native_ref` records the scoped `owner`, `repository`, and numeric
`issue_number`, plus GitHub's distinct `node_id` when usable; it contains no credential. Provider
state and title spelling is preserved. Description, URL, assignee login, and parsed RFC 3339
timestamps fall back to `null`; labels fall back to `[]`, and usable labels are trimmed,
lowercased, deduplicated, and stripped of blanks. `priority:1` through `priority:4` labels map to the
corresponding integer, otherwise priority is `null`. Branch name is `null` on reads. Native blocked
dependencies are best-effort metadata and default to `[]`; dependency hydration is limited to
dispatchable candidates selected by the caller's dependency labels. A GitHub pull-request-shaped
record is explicitly non-dispatchable; other issue records are dispatchable. State lists log and
omit records missing the required number, nonblank title, or nonblank state while preserving valid
records. ID refresh fails if a requested visible record is malformed.

Public runtime failures are `TrackerError` values. Their portable mappings are:

| `category`             | GitHub condition and message behavior                                                                    | Retry metadata                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `tracker_request`      | Fetch/transport failure; message says the GitHub request failed                                          | `retryable=true`                                                                                     |
| `tracker_status`       | Non-success HTTP response, including authentication/authorization failures; message includes the status  | `status`; retryable for `408` and `5xx`                                                              |
| `tracker_response`     | Invalid JSON, wrong payload shape, or malformed required record; message identifies the invalid response | not retryable                                                                                        |
| `tracker_pagination`   | Invalid, cyclic, or cross-origin next link; message identifies the integrity failure                     | not retryable                                                                                        |
| `tracker_rate_limited` | `429`, or `403` with GitHub rate-limit headers; message includes the status                              | `retryable=true`, `status`, and `retryAfterMs` from `Retry-After` or `X-RateLimit-Reset` when usable |

The host-side branch lookup, pull-request create/inspect/merge, review-thread resolution, and
operator label mutation extensions are scoped to the same repository and credential. They are not
advertised as generic tracker CRUD or agent-native tools; their failures use the same
`TrackerError` category/message convention.

This project is independent of OpenAI and is not an official OpenAI distribution.
