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

Unknown top-level keys are retained as JSON-safe extension data and ignored by the core. Likewise,
`tracker.provider` is retained exactly as written and handed to the selected adapter; the core does
not resolve, discard, or interpret adapter-owned keys. `$VAR` resolution is limited to declared
secret and path fields. In core configuration that means `workspace.root`; hook bodies and
`codex.command` remain shell strings. `workspace.root` also expands `~`, and relative roots resolve
from the directory containing `WORKFLOW.md`.

### GitHub tracker adapter

The GitHub adapter supports these `tracker.provider` keys:

| Key            | Requirement and default                                                                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`        | Required non-empty repository owner.                                                                                                                                                                |
| `repository`   | Required non-empty repository name.                                                                                                                                                                 |
| `token`        | Optional `$VAR` secret reference. If omitted, the adapter uses the first non-empty value from `GITHUB_TOKEN`, then `GH_TOKEN`. Literal credentials and Codex authentication variables are rejected. |
| `api_base_url` | Optional absolute HTTP(S) URL; defaults to `https://api.github.com`.                                                                                                                                |
| `base_branch`  | Optional non-empty branch; defaults to `main`.                                                                                                                                                      |

Unknown provider keys are preserved by the loader and ignored by this adapter. The adapter defaults
`active_states` to `[open]` and `terminal_states` to `[closed]`. Startup or dispatch preflight fails
for a missing/blank owner or repository, a non-string or literal token, an empty/missing referenced
secret, a non-HTTP(S) API URL, or blank optional string. Adapter secret environment names—including
the configured name and both fallback aliases—are removed from Codex child environments.

### Codex policy

The default Codex command is `codex app-server`; blank commands fail startup and dispatch
preflight. This implementation defaults `approval_policy` to `never` and `thread_sandbox` to
`workspace-write`. When `turn_sandbox_policy` is omitted, each turn receives a `workspaceWrite`
policy with the issue workspace as its writable root and network access enabled. An explicit
`turn_sandbox_policy` map is passed through unchanged.

Policy shapes track the generated schema for the targeted Codex App Server: `approval_policy`
accepts `untrusted`, `on-request`, `never`, or the generated granular object;
`thread_sandbox` accepts `read-only`, `workspace-write`, or `danger-full-access`; and turn policies
accept the generated `dangerFullAccess`, `readOnly`, `externalSandbox`, and `workspaceWrite` map
variants. When upgrading Codex, regenerate schemas with
`codex app-server generate-json-schema --out <directory>` and compare `v2/ThreadStartParams.json`
and `v2/TurnStartParams.json`.

This project is independent of OpenAI and is not an official OpenAI distribution.
