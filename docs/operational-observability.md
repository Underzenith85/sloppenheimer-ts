# Operational observability

Sloppenheimer emits Effect-native logs, spans, and metrics. Core records signals through Effect's
backend-neutral APIs; the CLI composition root owns the tracer/exporter binding. The built-in tracer
works without additional configuration, and an operator can install an Effect OpenTelemetry layer
at the composition root without changing orchestration policy. The root wraps the selected tracer
so a synchronous exporter failure cannot fail a tick or worker. Log and metric recording defects are
also contained locally.

## Spans

Every poll creates a `poll` parent span. Its child stages are:

- `poll.retirements`
- `poll.credential_revalidation`
- `poll.handoff_hydration`
- `poll.handoff_recovery`
- `poll.workflow_reload`
- `poll.handoff_reconciliation`
- `poll.issue_reconciliation`
- `poll.dispatch`

Dispatches create `dispatch` spans, agent workers create `agent.run` spans, completed-work handoff
requests create `handoff` spans, and adapter HTTP calls create `github.request` spans. Issue,
attempt, run/session, and handoff context is attached to spans or sanitized log annotations where it
helps correlate one operation. It is never attached to metrics.

## Metrics

| Metric                                    | Kind    | Meaning                                                    |
| ----------------------------------------- | ------- | ---------------------------------------------------------- |
| `sloppenheimer_poll_duration`             | timer   | Complete poll-pass latency                                 |
| `sloppenheimer_github_request_duration`   | timer   | GitHub HTTP latency                                        |
| `sloppenheimer_agent_duration`            | timer   | Agent worker latency                                       |
| `sloppenheimer_dispatch_total`            | counter | Started, duplicate, and validation/render refusal outcomes |
| `sloppenheimer_retry_total`               | counter | Scheduled and non-retryable decisions                      |
| `sloppenheimer_workflow_validation_total` | counter | Successful and refused validation passes                   |
| `sloppenheimer_handoff_total`             | counter | Handoff, merge, and intervention outcomes                  |
| `sloppenheimer_agent_total`               | counter | Normal, failed, cancelled, and stalled exits               |
| `sloppenheimer_running_agents`            | gauge   | Entries in the authoritative running map                   |
| `sloppenheimer_retrying_agents`           | gauge   | Entries in the authoritative retry map                     |

Effect timer metrics carry its standard `time_unit=milliseconds` tag. Counter outcomes come only
from closed TypeScript unions. Gauges are re-derived after each published runtime transition from
the same maps that drive scheduling; they do not maintain a second count.

## Cardinality and privacy policy

Metric dimensions must remain process-wide and low-cardinality. Never use issue IDs, identifiers,
titles, URLs, branch names, pull-request numbers, commit hashes, session IDs, run IDs, error messages,
or tracker payload values as metric labels. New outcome values require a closed
union in `packages/core/src/support/observability.ts` and a test.

Detailed correlation belongs in traces and logs. Structured log fields and propagated annotations
share the same recursive secret redaction, 1,024-character string bound, four-level depth bound,
20-element array bound, and 40-field object bound. Exporters must apply their own retention and
access controls to trace attributes.

## Useful alerts and dashboards

- Poll or GitHub duration growth points to tracker or network degradation.
- A rising `preflight_failed`, workflow-validation failure, or `not_retryable` frequency indicates
  configuration or credential trouble.
- Running agents pinned at the configured concurrency limit alongside retrying agents indicates
  worker saturation.
- Rising `stalled`, handoff `failed`, or `intervention` outcomes require operator attention.

Metric updates, logging, and span export are supplemental. Tests use Effect's test clock, custom
logger/tracer services, and direct metric values, so latency and failure-containment coverage does
not depend on wall time or an external collector.
