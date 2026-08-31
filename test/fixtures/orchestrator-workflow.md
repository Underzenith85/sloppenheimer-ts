---
tracker:
  kind: github
  provider:
    owner: example
    repository: symphony
    token: test-token
  required_labels: [ready]
  active_states: [open]
  terminal_states: [closed]
polling:
  interval_ms: 3600000
workspace:
  root: /tmp/symphony-orchestrator-test
agent:
  max_concurrent_agents: 1
  max_turns: 1
  max_retry_backoff_ms: 300000
codex:
  stall_timeout_ms: 30000
handoff:
  enabled: true
---

Work on {{ issue.identifier }} attempt {{ attempt }}.
