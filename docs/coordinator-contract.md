# Coordinator v1 wire and interaction decisions (#303)

The schemas and fixtures in `packages/coordinator-contracts/src/` are the executable contract.
All envelopes carry `version: 1`. This package defines transport and presentation ordering, not
classification or dispatch. #302 is not present in this worktree; its operator-model extraction
will supply classification. No instance API types are copied here and no existing console changes.

Detail routes encode each opaque identifier as `encodeURIComponent(JSON.stringify(identifier))`.
Route consumers URI-decode each segment once, then JSON-decode and validate it with `Identifier`.
JSON quoting prevents `.` and `..` from becoming URL dot segments and preserves lone UTF-16
surrogates without throwing or replacing identity characters.

## State and interaction table

| Concern                                    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                                   | Registry `instance_id` plus opaque `issue_identifier` everywhere: keys, detail routes, blockers and action feedback. Numbers are display/ranking data, never identity. Use `workKey` and `detailRoute`; query keys include both fields plus resource scope.                                                                                                                                                                         |
| Process versus workflow                    | `process_id` changes on restart; `session_id` identifies the agent session and may be null. Workflow fingerprint changes on reload without implying either identity changed. Retained work keeps its work identity across all three. Reject out-of-order responses from replaced processes; invalidate detail and action capabilities on fingerprint change.                                                                        |
| State/backlog observations                 | Each source has its own coordinator receipt time, optional source timestamp/provenance, last attempt and condition. A successful state fetch does not refresh backlog. Missing observations never imply zero work/capacity. Keep last valid data on failure with its original times.                                                                                                                                                |
| Never observed                             | No validated observation yet. First attempt starts the unreachable deadline; no attempt means never-observed indefinitely.                                                                                                                                                                                                                                                                                                          |
| Current/stale/unreachable                  | Age since last valid observation: current below 30s, stale at 30s, unreachable at 120s. Without an observation, unreachable at 120s after first attempt. A transient error retains age-based status; record attempt time. These deadlines do not move with backoff or repeated failures.                                                                                                                                            |
| Incompatible                               | Unsupported version, invalid payload or mismatched registry identity quarantines that instance/source immediately. Preserve last valid observations as historical only; disable controls. Other instances remain usable.                                                                                                                                                                                                            |
| Recovery                                   | A valid compatible observation immediately restores that source to current; update receipt/provenance together. A successful HTTP response with invalid data does not recover. Restart does not clear retained delivery, handoff or completion facts.                                                                                                                                                                               |
| Browser connection                         | Browser freshness is separate from all instance conditions. Snapshot age plus monotonic elapsed time is current below 15s, stale at 15s, unreachable at 60s. No successful aggregate is never-observed. A cache hit or 304 does not reset generated age. Incompatible aggregate is a connection error and never replaces the last valid snapshot.                                                                                   |
| Empty states                               | No registered instances: setup empty state. No matching rows: retain filters and offer clear filters. No work: only claim this for complete current coverage. Missing/stale/incompatible sources show partial coverage and retained rows. `noMatchingRows` fixture uses a Ready filter against Finished data.                                                                                                                       |
| Capabilities                               | Server publishes Start/Queue/Pause/Resume availability with a reason when disabled. Capability is advisory; server revalidates. Start means request eligibility/reselection, not guaranteed running; Queue means eligible while capacity is constrained. Pause changes eligibility, not cancellation. Resume retries retained recovery when applicable. No control inferred from a bucket alone.                                    |
| Idle → submitting                          | Allocate request ID and capture process/fingerprint and composite identity; suppress duplicate submission.                                                                                                                                                                                                                                                                                                                          |
| Submitting → accepted-awaiting-observation | Only explicit server acceptance. Do not move rows optimistically or label this confirmed.                                                                                                                                                                                                                                                                                                                                           |
| Confirmed                                  | A strictly later compatible observation from the expected process/fingerprint supplies action-specific evidence: Start/Queue eligibility/reselection acknowledgement; Pause paused eligibility; Resume recovery advancement. Running is not required for Start confirmation. Do not attribute unrelated movement to a request without evidence.                                                                                     |
| Rejected                                   | Explicit server refusal with a safe reason; retain row. A new deliberate action may start a new request.                                                                                                                                                                                                                                                                                                                            |
| Unknown                                    | Timeout, connection loss or identity change after submission, or no confirmation within 30s of acceptance. The action may have happened. Never automatically replay; refresh observation, show uncertainty, allow deliberate retry only after reconciling. A later matching observation can confirm an unknown outcome.                                                                                                             |
| Refresh scopes                             | Aggregate reread, instance-state observation, instance-backlog observation and issue-detail fetch are separate named scopes. A refresh is not dispatch, and a detail fetch does not make backlog current.                                                                                                                                                                                                                           |
| Compact row budget                         | At most two text lines: instance + issue identifier + title (two-line truncation with accessible full name), then phase + attention/eligibility + one reason/ranking/age. One primary action, detail link, and explicit stale/unknown indicator. Put labels, full blocker list, telemetry, timestamps and secondary controls in detail. Safety information updates immediately even if placement is temporarily stable under focus. |
| Blocked navigation                         | Blocked is the fifth bucket, reachable via the Ready waiting-count link and a shareable `bucket=blocked` filter; never hidden behind a disabled Start. Blocker links retain composite identity. Unregistered external blockers require tracker navigation rather than invented local rows.                                                                                                                                          |
| Detail                                     | Use a route-backed side panel on wide layouts and a full-page route on narrow layouts. Fetch on demand. Back/Escape closes and restores invoking-row focus (nearest surviving row if removed). No per-row modal or eager timeline fetching. Unretained detail states why and never invents an agent session for recovered work.                                                                                                     |

## Time and ordering

All wire timestamps are finite nonnegative integer UTC Unix milliseconds. `observed_at`,
`first_observed_at`, `generated_at`, and action receipt times use the coordinator clock. Source
instants name instance/provider/coordinator provenance. Calibration offset means **coordinator minus
source**; corrected time is source time plus offset. Sample at the request midpoint and use half
round-trip duration plus source clock error as uncertainty. Expire calibration after 60s or process
change. `finished_at` accepts only provider provenance or null; never substitute discovery time
for merge time. Confirmed action evidence must contain at least one character and is bounded by
the shared text limit.

Browser calibration uses the same midpoint convention between coordinator and browser, with
monotonic elapsed time after receipt. Snapshot age at receipt includes uncertainty. Without a valid
calibration, use a conservative stale age (at least 15s), label elapsed times approximate and avoid
exact cross-clock durations. Clamp negative elapsed time to zero; clock jumps require recalibration.
Never extend freshness by observing a future source timestamp: source freshness uses receipt time.

Attention onset is the actual condition timestamp when known; first-observed is when the coordinator
first saw this episode. Do not label first-observed as onset. Preserve both through stale periods,
reconnects and workflow reloads while the same condition persists; a validated resolution followed
by recurrence creates a new episode. Unknown onset displays “first observed”, not “waiting since”.
Neither timestamp silently changes severity ranking.

Bucket order is attention, ready, blocked, progress, finished. Within buckets:

| Bucket    | Ordering                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| Attention | stalled, intervention_required, repair_needed, recovery_failed, cycle, blocked_priority; then priority ascending |
| Ready     | Priority ascending, unlock count descending                                                                      |
| Blocked   | Priority ascending, unlock count descending                                                                      |
| Progress  | starting, running, retrying, delivering, handing_off, awaiting_checks, rebasing, ready_to_merge, merging         |
| Finished  | Provider completion time descending; unknown last; retained window is 24 hours, independent of restart           |

All orders then use issue number ascending (unknown last), instance ID and issue identifier in
code-unit lexical order, independent of locale. Unknown phase/attention strings are displayed as
unknown, rank after known values and never grant capabilities. These extensible strings do not
weaken closed bucket/action/version enums. Unknown additive object fields are discarded recursively;
missing or malformed known coordinator-owned fields fail decoding. Raw malformed input must not be
reflected into alerts or browser error messages. Instance decoding returns a bounded reason code.

Fixture builders use fixed time and fresh containers, take typed overrides, and import no test,
React, DOM, Node or server code. Tests live under `test/coordinator-contracts/` and the same builders
are available to future browser and backend suites.
