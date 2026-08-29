# Symphony for TypeScript

A Node.js 24 and native TypeScript 7 implementation of the
[OpenAI Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md).

This repository contains a working orchestration core: strict workflow loading and Liquid prompt
rendering, a GitHub Issues tracker adapter, isolated workspaces and lifecycle hooks, a typed Codex
App Server JSONL client, polling and hot reload, concurrency limits, reconciliation, stall detection,
and bounded exponential retries. `WORKFLOW.md` is configured so this implementation can dispatch
Codex to improve itself from labeled GitHub issues.

## Requirements

- Node.js 24
- Git
- Codex CLI, authenticated for `codex app-server`
- A GitHub token in `GITHUB_TOKEN`

## Development

```sh
npm ci
npm run check
```

The codebase uses TypeScript 7's native compiler directly. Oxlint runs its native type-aware engine,
and Oxfmt enforces no-semicolon formatting. Strict compiler options, `no-explicit-any`, the
type-aware unsafe-operation rules, and mandatory braces are CI errors.

## Run

```sh
npm run build
GITHUB_TOKEN=github_pat_... npm start -- WORKFLOW.md
```

The workflow token is resolved by the host and removed from agent subprocess environments. Each
eligible issue must carry the `symphony` label. Workspaces live under `.symphony/workspaces` and are
never treated as trusted paths until containment checks pass.

## Configuration

`WORKFLOW.md` has YAML front matter followed by a strict Liquid template. Supported sections are
`tracker`, `polling`, `workspace`, `hooks`, `agent`, `codex`, and `server`. The current tracker
profile is GitHub Issues; the orchestration interfaces keep tracker and workspace concerns separate
so additional profiles can be implemented without weakening the domain types.

This project is independent of OpenAI and is not an official OpenAI distribution.
