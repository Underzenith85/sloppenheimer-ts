import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url))

/**
 * The workspace packages publish built JavaScript, because that is what the installed `symphony`
 * executable loads. The suite is not testing that build, so it resolves `@symphony/*` back to the
 * TypeScript sources: a test run needs no prior `pnpm build`, and a stack trace, a coverage report,
 * and a watch-mode rebuild all point at the file an author would edit.
 */
export const workspaceSourceAliases = [
  {
    find: /^@symphony\/([^/]+)$/u,
    replacement: `${repositoryRoot}packages/$1/src/index.ts`,
  },
  {
    find: /^@symphony\/([^/]+)\/(.+)\.js$/u,
    replacement: `${repositoryRoot}packages/$1/src/$2.ts`,
  },
]
