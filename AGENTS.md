# Contributor Conventions

## TypeScript and Effect

### Absence: `Option` versus `null`

Accepted 2026-08-30: use `null` at data boundaries and `Option` for internal control-flow absence.

- Use `null` in values that are serialized, persisted, logged, returned by the HTTP API, received
  from an external protocol, or represented as domain or wire records. Keep these values as
  ordinary JSON-shaped data.
- Use Effect's `Option` in internal service APIs, lookups, and partial computations when absence
  determines the next control-flow branch.
- Convert once at the architectural boundary. Do not carry `Option` into JSON-facing records, and
  do not carry a nullable result deeper into Effect-based orchestration when it represents a
  branch.
- Keep native `undefined` where JavaScript APIs inherently produce it, such as `Map.get` or an
  omitted optional property. Convert it to `Option` when it crosses into an internal service
  contract.

For example, `findPullRequest(...): Effect.Effect<string | null, TrackerError>` and
`refreshIssue: () => Effect.Effect<Issue | null, AgentError>` should use `Option<string>` and
`Option<Issue>` respectively. In contrast, wire-shaped `Issue` fields including `description`,
`branchName`, `url`, `createdAt`, and `updatedAt` should remain nullable, as should telemetry and
snapshot fields such as `AgentEvent.message`, `sessionId`, `HandoffSnapshot.headSha`, and `reason`.

This mixed style is intentional. It costs one explicit conversion at each architectural boundary,
but keeps serialized types honest and naturally JSON-compatible while making internal absence
composable with Effect.

# Repository Structure

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
