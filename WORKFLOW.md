---
tracker:
  kind: github
  provider:
    owner: Underzenith85
    repository: symphony-ts
    token: $GITHUB_TOKEN
    base_branch: main
  required_labels: [symphony]
  active_states: [open]
  terminal_states: [closed]
polling:
  interval_ms: 10000
workspace:
  root: .symphony/workspaces
hooks:
  timeout_ms: 120000
agent:
  max_concurrent_agents: 1
  max_turns: 1
  max_retry_backoff_ms: 300000
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 3600000
  read_timeout_ms: 10000
  stall_timeout_ms: 600000
server:
  port: 3000
handoff:
  enabled: true
---

Implement GitHub issue {{ issue.identifier }} in this repository.

Title: {{ issue.title }}

Description:
{{ issue.description }}

Read `AGENTS.md` at the root of the prepared worktree before you start: it states the conventions
this repository holds, and a change that ignores them will not pass review. Implement and test the
requested change in the worktree, then run `pnpm check`. Do not create branches, commit, rebase,
push, or request GitHub credentials; Symphony publishes the worktree through its host credential.

When the description contains a `Pull request repair` section, edit the prepared existing PR head
instead of opening a replacement. Symphony rebases and publishes the resulting diff with an exact
expected-head lease, then submits `@codex review` after observing the published head. Do not resolve
review threads yourself or merge the pull request; Symphony will do those only after CI passes and
the latest-head review is verified.
