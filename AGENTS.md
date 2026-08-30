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

## Module import direction

The directories under `src/` are layers, and imports may only ever point downwards:

```
support/  <-  domain/  <-  ports/  <-  core/  <-  config/, operator/, adapters/, src/ root
```

- `support/` is the bottom layer. It may import only from `support/` itself and from third-party or
  Node packages.
- `domain/` may import from `support/` only.
- `ports/` may import from `domain/` and `support/` only.
- `core/` holds orchestration policy. It may import from `config/`, `ports/`, `domain/`, and
  `support/`, and it may never name a concrete adapter — it depends on a port and lets the
  composition root bind the implementation.
- `adapters/` is restricted as an import target, never as a source.
- The `src/` root is the composition root. It binds the concrete adapters and is unrestricted.

`.oxlintrc.json` enforces this with `no-restricted-imports` overrides, so `pnpm lint` — and
therefore `pnpm check` — fails on a violation. The groups match the import specifier as written
rather than its resolved target, so each layer takes two overrides:

- Every file in the layer, at any depth, is denied the sibling layers by name.
- Files directly in the layer are denied everything that leaves the layer, with the layers below
  re-admitted by negation. A directory added later is therefore forbidden until the rule names it.

The second rule cannot be extended to nested modules, because `../json.js` is a same-layer import
from `src/support/parsers/value.ts` and an escape to the `src/` root from `src/support/json.ts`.
Nested modules keep the first rule only, which trades an undetected import of a root module for
never rejecting a compliant one. Prefer flat layers.

`test/import-boundaries.test.ts` lints a fixture tree with that same configuration, at both depths,
and asserts the rule still fires.

Modules that #84 left at the `src/` root are adapters and infrastructure that have not moved into a
layer yet. `core/` reaches them through a migration allow-list in `.oxlintrc.json`, where each entry
names the issue under [#76](https://github.com/Underzenith85/symphony-ts/issues/76) that removes it.
Add to that allow-list only when a module has not moved yet; never to admit an import of
`adapters/`.
