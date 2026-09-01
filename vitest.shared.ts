import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url))

/**
 * The workspace packages publish built JavaScript, because that is what the installed `sloppenheimer`
 * executable loads. The suite is not testing that build, so it resolves `@sloppenheimer/*` back to the
 * TypeScript sources: a test run needs no prior `pnpm build`, and a stack trace, a coverage report,
 * and a watch-mode rebuild all point at the file an author would edit.
 */
export const workspaceSourceAliases = [
  {
    find: /^@sloppenheimer\/([^/]+)$/u,
    replacement: `${repositoryRoot}packages/$1/src/index.ts`,
  },
  {
    find: /^@sloppenheimer\/([^/]+)\/(.+)\.js$/u,
    replacement: `${repositoryRoot}packages/$1/src/$2.ts`,
  },
]
