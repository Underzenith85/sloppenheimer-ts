import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Effect, Layer, Option, Schema, type Scope } from 'effect'

import {
  DurableWorkflowJson,
  type DurableWorkflow,
} from '@sloppenheimer/core/domain/durable-workflow.js'
import { WorkflowStoreError } from '@sloppenheimer/core/domain/errors.js'
import { WorkflowStore, type WorkflowStorePort } from '@sloppenheimer/core/ports/workflow-store.js'
import { workflowDatabaseWorker } from './workflow-database-worker.js'

type Request =
  | Readonly<{ kind: 'get'; issueId: string }>
  | Readonly<{ kind: 'list' }>
  | Readonly<{
      kind: 'commit'
      issueId: string
      revision: number
      expectedRevision: number | null
      body: string
    }>

const Reply = Schema.Union(
  Schema.Struct({ id: Schema.Int, ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({
    id: Schema.Int,
    ok: Schema.Literal(false),
    category: Schema.Literal('conflict', 'storage'),
  }),
)
type Resume = (result: Effect.Effect<unknown, WorkflowStoreError>) => void
type Connection = Readonly<{
  request: (request: Request) => Effect.Effect<unknown, WorkflowStoreError>
  close: Effect.Effect<void>
}>

const storageFailure = (cause?: unknown): WorkflowStoreError =>
  new WorkflowStoreError({
    category: 'storage',
    message: 'workflow database operation failed',
    cause,
  })

const connect = (worker: Worker): Connection => {
  const pending = new Map<number, Resume>()
  let counter = 0
  let unavailable = false
  const failAll = (cause: unknown): void => {
    unavailable = true
    for (const resume of pending.values()) {
      resume(Effect.fail(storageFailure(cause)))
    }
    pending.clear()
  }
  worker.on('error', failAll)
  worker.on('exit', (code) => failAll({ exitCode: code }))
  worker.on('message', (message: unknown) => {
    const decoded = Schema.decodeUnknownEither(Reply)(message)
    if (decoded._tag === 'Left') {
      failAll('invalid database response')
      return
    }
    const reply = decoded.right
    const resume = pending.get(reply.id)
    pending.delete(reply.id)
    if (resume === undefined) {
      return
    }
    resume(
      reply.ok
        ? Effect.succeed(reply.value)
        : Effect.fail(
            new WorkflowStoreError({
              category: reply.category,
              message:
                reply.category === 'conflict'
                  ? 'workflow revision changed before commit'
                  : 'workflow database operation failed',
            }),
          ),
    )
  })
  return {
    request: (request) =>
      Effect.async((resume) => {
        if (unavailable) {
          resume(Effect.fail(storageFailure()))
          return
        }
        const id = ++counter
        // This bounds communication with a real worker, independent of the orchestration clock.
        const timer = setTimeout(() => {
          pending.delete(id)
          resume(Effect.fail(storageFailure('database response deadline exceeded')))
        }, 10_000)
        pending.set(id, (result) => {
          clearTimeout(timer)
          resume(result)
        })
        try {
          worker.postMessage({ ...request, id })
        } catch (cause) {
          clearTimeout(timer)
          pending.delete(id)
          resume(Effect.fail(storageFailure(cause)))
        }
        return Effect.sync(() => {
          clearTimeout(timer)
          pending.delete(id)
        })
      }),
    close: Effect.sync(() => failAll('workflow store closed')).pipe(
      Effect.zipRight(Effect.promise(() => worker.terminate())),
      Effect.asVoid,
    ),
  }
}

const decode = (body: unknown): Effect.Effect<DurableWorkflow, WorkflowStoreError> =>
  Schema.decodeUnknown(DurableWorkflowJson)(body).pipe(
    Effect.mapError(
      (cause) =>
        new WorkflowStoreError({
          category: 'decode',
          message: 'invalid persisted workflow',
          cause,
        }),
    ),
  )

const storeFor = (connection: Connection): WorkflowStorePort => ({
  get: (issueId) =>
    connection
      .request({ kind: 'get', issueId })
      .pipe(
        Effect.flatMap((body) =>
          body === null
            ? Effect.succeed(Option.none<DurableWorkflow>())
            : Effect.map(decode(body), Option.some),
        ),
      ),
  list: connection.request({ kind: 'list' }).pipe(
    Effect.flatMap(Schema.decodeUnknown(Schema.Array(Schema.String))),
    Effect.mapError(storageFailure),
    Effect.flatMap((rows) => Effect.forEach(rows, decode)),
  ),
  commit: (workflow, expectedRevision) => {
    if (workflow.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) {
      return Effect.fail(
        new WorkflowStoreError({
          category: 'conflict',
          message: 'workflow commit must advance exactly one revision',
        }),
      )
    }
    return Schema.encode(DurableWorkflowJson)(workflow).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowStoreError({
            category: 'decode',
            message: 'invalid workflow commit',
            cause,
          }),
      ),
      Effect.flatMap((body) =>
        connection.request({
          kind: 'commit',
          issueId: workflow.issueId,
          revision: workflow.revision,
          expectedRevision,
          body,
        }),
      ),
      Effect.asVoid,
    )
  },
})

/** No process-wide singleton: one scoped database connection owns one worker and its pending calls. */
export const openWorkflowStore = (
  path: string,
  exclusive = false,
): Effect.Effect<WorkflowStorePort, WorkflowStoreError, Scope.Scope> =>
  Effect.tryPromise({
    try: () => mkdir(dirname(path), { recursive: true }),
    catch: storageFailure,
  }).pipe(
    Effect.zipRight(
      Effect.acquireRelease(
        Effect.try({
          try: () =>
            connect(
              new Worker(workflowDatabaseWorker, { eval: true, workerData: { path, exclusive } }),
            ),
          catch: storageFailure,
        }),
        (connection) => connection.close,
      ),
    ),
    Effect.map(storeFor),
  )

export const layerWorkflowStore = (path: string): Layer.Layer<WorkflowStore, WorkflowStoreError> =>
  Layer.scoped(WorkflowStore, openWorkflowStore(path, true).pipe(Effect.tap((store) => store.list)))
