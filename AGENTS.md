# Repository conventions

## Architecture and ports

The following port boundary was accepted in the 2026-08-30 architecture review:

- `TrackerPort` contains only tracker-neutral issue operations: fetching normalized issues, adapter-supplied dispatch eligibility, dependency hydration, tracker credentials, and issue-state operations expressed in tracker-neutral terms.
- Pull-request handoff is an optional application capability exposed through `CodeReviewPort`. It owns completed-work handoff and discovery of an existing handoff, inspection of a proposed change, protected merge, and review-thread resolution. The port may use honest pull-request and code-review vocabulary.
- GitHub supplies both `TrackerPort` and `CodeReviewPort`; other tracker providers are not required to simulate code-review concepts that they do not support.
- When handoff is enabled, a provider that does not supply `CodeReviewPort` is an operator-visible configuration error. When handoff is disabled, no `CodeReviewPort` is required and the application follows the core continuation lifecycle. This is the port-level convention for the configuration gate tracked in [#73](https://github.com/Underzenith85/symphony-ts/issues/73).
- `HandoffResult` belongs with `CodeReviewPort`, because its pull-request variant is a code-review concept rather than an issue-tracker concept.
- During implementation of this boundary, remove the unused `dispatchLabels` parameter from `handoffCompletedWork`; do not preserve it in either port.

This convention is the architecture record for the boundary. Do not create a separate ADR for it.

## Repository structure

Symphony is intended to be a private pnpm workspace with these architectural package boundaries:

- `packages/core` contains domain types, ports, and orchestration policy. It must not depend on
  concrete adapters.
- `packages/adapter-github` contains the GitHub tracker and code-review implementations.
- `packages/adapter-codex` contains the Codex agent-runner implementation.
- The root application is the composition root for the CLI, operator server, configuration, and the
  single Symphony executable.

Package manifests must encode the dependency direction so that `packages/core` cannot import either
adapter package. These packages are architectural units, not independently published products. They
remain private and share one lockfile, CI pipeline, versioning policy, and deployable Symphony
executable.

Issues #84 and #86 establish the source layout and import rules first. Issue #109 then performs the
package migration without reopening those boundaries. If that migration is too large for one safe
pull request, split it into independently buildable steps; do not land a half-migrated workspace.
