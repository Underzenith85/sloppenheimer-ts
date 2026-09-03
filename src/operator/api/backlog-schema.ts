// The runtime half of the backlog document the console reads from `/api/v1/backlog`.
//
// Unlike the SPEC documents beside it this one is published in the runtime's own vocabulary — it is
// the console's view of the dependency graph rather than a baseline resource — so the schema is
// annotated with `BacklogSnapshot` itself and states exactly what that value looks like on the wire.

import { Schema } from 'effect'

import type { BlockerRef, IssueIdentifier } from '@sloppenheimer/core/domain/domain.js'
import type { DependencyCycle } from '@sloppenheimer/core/domain/dependencies.js'

import type { BacklogIssue, BacklogSnapshot, DependencyEdge, DependencyNode } from '../operator.js'

/**
 * A branded identifier as the wire carries it. The brand is a compile-time name for a string and
 * has no runtime witness — `issueIdentifier` in `domain/domain.js` mints one from any string — so
 * the check this declares is the only one there is to make, and the JSON Schema it advertises is
 * the string it encodes to.
 */
const issueIdentifierSchema: Schema.Schema<IssueIdentifier> = Schema.declare(
  (value: unknown): value is IssueIdentifier => typeof value === 'string',
  { identifier: 'IssueIdentifier', jsonSchema: { type: 'string' } },
)

const blockerSchema: Schema.Schema<BlockerRef> = Schema.Struct({
  id: Schema.String,
  identifier: issueIdentifierSchema,
  title: Schema.String,
  state: Schema.String,
  url: Schema.String,
})

const backlogIssueSchema: Schema.Schema<BacklogIssue> = Schema.Struct({
  number: Schema.Number,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  priority: Schema.NullOr(Schema.Number),
  createdAt: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  dispatchable: Schema.Boolean,
  state: Schema.String,
  normalizedState: Schema.String,
  blockedBy: Schema.Array(blockerSchema),
  readiness: Schema.Literal('ready', 'blocked', 'cyclic'),
  reason: Schema.NullOr(Schema.String),
  unlocks: Schema.Number,
})

const dependencyNodeSchema: Schema.Schema<DependencyNode> = Schema.Struct({
  identifier: Schema.String,
  number: Schema.NullOr(Schema.Number),
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  state: Schema.String,
  readiness: Schema.Literal('ready', 'blocked', 'cyclic', 'completed'),
  reason: Schema.NullOr(Schema.String),
  actionable: Schema.Boolean,
})

const dependencyEdgeSchema: Schema.Schema<DependencyEdge> = Schema.Struct({
  blocker: Schema.String,
  dependent: Schema.String,
})

const dependencyCycleSchema: Schema.Schema<DependencyCycle> = Schema.Struct({
  members: Schema.Array(Schema.String),
  message: Schema.String,
})

export const backlogSnapshotSchema: Schema.Schema<BacklogSnapshot> = Schema.Struct({
  controlLabel: Schema.String,
  issues: Schema.Array(backlogIssueSchema),
  nodes: Schema.Array(dependencyNodeSchema),
  edges: Schema.Array(dependencyEdgeSchema),
  cycles: Schema.Array(dependencyCycleSchema),
})
