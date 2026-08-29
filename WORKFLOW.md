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
  after_create: git clone git@github.com:Underzenith85/symphony-ts.git .
  before_run: |
    if test -z "$(git status --porcelain)"; then
      git fetch origin main
      git checkout --detach origin/main
    fi
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
---

Implement GitHub issue {{ issue.identifier }} in this repository.

Title: {{ issue.title }}

Description:
{{ issue.description }}

Follow the repository's TypeScript 7 conventions. Never use `any`, never omit braces around a
control-flow body, and do not add TypeScript 6 compatibility. Create a branch named
`symphony/issue-{{ issue.id }}`, run `pnpm check`, commit the implementation, and push the branch.
