import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { parse } from 'yaml'

import { WorkflowError } from '@sloppenheimer/core/domain/errors.js'
import { isJsonObject } from '@sloppenheimer/core/support/json.js'

/**
 * The document as a file: reading it, separating its YAML front matter from the prompt template
 * that follows, and refusing front matter that is not a map at all.
 */
/** Separates the YAML front matter from the prompt template that follows it. */
export const splitWorkflow = (
  source: string,
): Effect.Effect<Readonly<{ config: unknown; prompt: string }>, WorkflowError> => {
  if (!source.startsWith('---')) {
    return Effect.succeed({ config: {}, prompt: source.trim() })
  }
  const lines = source.split(/\r?\n/u)
  const closing = lines.findIndex((line, index) => index > 0 && line === '---')
  if (closing < 0) {
    return Effect.fail(
      new WorkflowError({
        category: 'workflow_parse_error',
        message: 'YAML front matter is not closed',
      }),
    )
  }
  const prompt = lines
    .slice(closing + 1)
    .join('\n')
    .trim()
  return Effect.try({
    try: () => parse(lines.slice(1, closing).join('\n')) as unknown,
    catch: (cause: unknown) =>
      new WorkflowError({
        category: 'workflow_parse_error',
        message: 'invalid YAML front matter',
        cause,
      }),
  }).pipe(Effect.map((config) => ({ config, prompt })))
}

/**
 * The front matter has to be a map before any of it can be decoded, and a document that is a list
 * or a scalar is a different failure from one whose fields are wrong: it declares nothing this
 * loader can act on, so it keeps its own category.
 */
export const frontMatterMap = (value: unknown): Effect.Effect<unknown, WorkflowError> =>
  isJsonObject(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new WorkflowError({
          category: 'workflow_front_matter_not_a_map',
          message: 'workflow front matter must be a map',
        }),
      )

export const readWorkflowSource = (
  path: string,
): Effect.Effect<string, WorkflowError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path, 'utf8')),
    Effect.mapError(
      (cause) =>
        new WorkflowError({
          category: 'missing_workflow_file',
          message: `cannot read workflow file: ${path}`,
          cause,
        }),
    ),
  )
