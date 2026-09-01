import { Effect, Exit } from 'effect'

import type { IssueIdentifier, Workspace } from '@sloppenheimer/core/domain/domain.js'
import type { WorkspaceError } from '@sloppenheimer/core/domain/errors.js'
import type { WorkspaceRelease, WorkspaceRun } from '@sloppenheimer/core/domain/workspace-lease.js'
import type { WorkspaceManagerPort } from '@sloppenheimer/core/ports/workspace.js'

export type WorkspaceOperation = Readonly<{
  operation: 'acquire' | 'release' | 'exists' | 'beforeRun' | 'afterRun' | 'remove'
  identifier: IssueIdentifier | null
  workspace: Workspace | null
  /** What a release did with the workspace; `null` for every other operation. */
  release: WorkspaceRelease | null
}>

/**
 * A typed workspace/process seam used without touching the host filesystem.
 *
 * It allocates the way the Node manager does: one directory per issue, one directory per run
 * inside it, leased to that run for the whole of its use and released as the caller's disposition
 * says. A second acquisition of a run identity that is still leased fails here as it does there.
 */
export class FakeWorkspaceProcess implements WorkspaceManagerPort {
  readonly operations: WorkspaceOperation[] = []
  readonly #root: string
  /** Run keys currently leased, by issue. */
  readonly #leased = new Map<IssueIdentifier, Set<string>>()
  /** Run keys released and kept, by issue. */
  readonly #retained = new Map<IssueIdentifier, Set<string>>()

  constructor(root = '/fake/workspaces') {
    this.#root = root
  }

  #record(
    operation: WorkspaceOperation['operation'],
    identifier: IssueIdentifier | null,
    workspace: Workspace | null,
    release: WorkspaceRelease | null = null,
  ): void {
    this.operations.push({ operation, identifier, workspace, release })
  }

  #keys(map: Map<IssueIdentifier, Set<string>>, identifier: IssueIdentifier): Set<string> {
    const existing = map.get(identifier)
    if (existing !== undefined) {
      return existing
    }
    const created = new Set<string>()
    map.set(identifier, created)
    return created
  }

  withLeasedWorkspace<Value, Failure, Requirements>(
    run: WorkspaceRun,
    use: (workspace: Workspace) => Effect.Effect<Value, Failure, Requirements>,
    disposition: (exit: Exit.Exit<Value, Failure | WorkspaceError>) => WorkspaceRelease,
  ): Effect.Effect<Value, Failure, Requirements> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const key = `run-${String(run.runId)}`
        const leased = this.#keys(this.#leased, run.identifier)
        if (leased.has(key)) {
          throw new Error(`workspace ${run.identifier}/${key} is already leased`)
        }
        leased.add(key)
        const workspace: Workspace = { path: `${this.#root}/${run.identifier}/${key}`, key }
        this.#record('acquire', run.identifier, workspace)
        return workspace
      }),
      (workspace) => use(workspace),
      (workspace, exit) =>
        Effect.sync(() => {
          const release = disposition(exit)
          this.#keys(this.#leased, run.identifier).delete(workspace.key)
          if (release._tag === 'Retained') {
            this.#keys(this.#retained, run.identifier).add(workspace.key)
          }
          this.#record('release', run.identifier, workspace, release)
        }),
    )
  }

  exists(identifier: IssueIdentifier): Effect.Effect<boolean> {
    this.#record('exists', identifier, null)
    return Effect.succeed(
      this.#keys(this.#leased, identifier).size + this.#keys(this.#retained, identifier).size > 0,
    )
  }

  beforeRun(workspace: Workspace): Effect.Effect<void> {
    this.#record('beforeRun', null, workspace)
    return Effect.void
  }

  afterRun(workspace: Workspace): Effect.Effect<void> {
    this.#record('afterRun', null, workspace)
    return Effect.void
  }

  /** Cleanup keeps whatever a live run still holds, exactly as the Node manager does. */
  remove(identifier: IssueIdentifier): Effect.Effect<void> {
    this.#record('remove', identifier, null)
    this.#keys(this.#retained, identifier).clear()
    return Effect.void
  }
}

const workspaceBoundary: WorkspaceManagerPort = new FakeWorkspaceProcess()
void workspaceBoundary
