import { Effect } from 'effect'

import type { IssueIdentifier, Workspace } from '../../src/domain/domain.js'
import type { WorkspaceManager } from '../../src/workspace.js'

export type WorkspaceOperation = Readonly<{
  operation: 'create' | 'exists' | 'beforeRun' | 'afterRun' | 'remove'
  identifier: IssueIdentifier | null
  workspace: Workspace | null
}>

/** A typed workspace/process seam used without touching the host filesystem. */
export class FakeWorkspaceProcess implements WorkspaceManager {
  readonly operations: WorkspaceOperation[] = []
  readonly #root: string
  readonly #existing = new Set<IssueIdentifier>()

  constructor(root = '/fake/workspaces') {
    this.#root = root
  }

  create(identifier: IssueIdentifier): Effect.Effect<Workspace> {
    const createdNow = !this.#existing.has(identifier)
    this.#existing.add(identifier)
    const workspace = { path: `${this.#root}/${identifier}`, key: identifier, createdNow }
    this.operations.push({ operation: 'create', identifier, workspace })
    return Effect.succeed(workspace)
  }

  exists(identifier: IssueIdentifier): Effect.Effect<boolean> {
    this.operations.push({ operation: 'exists', identifier, workspace: null })
    return Effect.succeed(this.#existing.has(identifier))
  }

  beforeRun(workspace: Workspace): Effect.Effect<void> {
    this.operations.push({ operation: 'beforeRun', identifier: null, workspace })
    return Effect.void
  }

  afterRun(workspace: Workspace): Effect.Effect<void> {
    this.operations.push({ operation: 'afterRun', identifier: null, workspace })
    return Effect.void
  }

  remove(identifier: IssueIdentifier): Effect.Effect<void> {
    this.operations.push({ operation: 'remove', identifier, workspace: null })
    this.#existing.delete(identifier)
    return Effect.void
  }
}

const workspaceBoundary: WorkspaceManager = new FakeWorkspaceProcess()
void workspaceBoundary
