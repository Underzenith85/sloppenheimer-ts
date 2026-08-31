import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

import { timelineCategories } from '../telemetry.js'

const read = (name: string): string =>
  readFileSync(new URL(`./ui/${name}`, import.meta.url), 'utf8')

/**
 * The browser script declares `timelineCategories` as an ambient binding so that the
 * console never restates the telemetry category list. The value is supplied here, from
 * the same module the server uses, rather than being baked in by the build.
 */
const categoryPrelude =
  "'use strict'\nconst timelineCategories = Object.freeze(" +
  JSON.stringify(timelineCategories) +
  ')\n'

/**
 * Type stripping is still flagged experimental, so Node prints a warning the first time it
 * runs. The CLI's stderr is an asserted contract, so the warning is suppressed for the one
 * call rather than allowed to leak into every source-mode run.
 */
const stripTypes = (source: string): string => {
  const emitWarning = process.emitWarning.bind(process)
  process.emitWarning = (): void => {}
  try {
    return stripTypeScriptTypes(source, { mode: 'strip' })
  } finally {
    process.emitWarning = emitWarning
  }
}

/**
 * The browser sources, in dependency order. They are plain scripts rather than modules — none of
 * them imports or exports — so the compiler typechecks them as one program and they can be served
 * as one classic script without a bundler. The order is the only thing this list encodes.
 */
const browserSources: readonly string[] = ['model', 'dom', 'detail', 'app']

/**
 * From `dist/` the compiled browser sources sit next to this module. In source mode there
 * is no build output to read — a fresh checkout has no `dist/` at all — so the same
 * TypeScript the build compiles is type-stripped in memory instead.
 */
const browserScript = (): string =>
  browserSources
    .map((name) =>
      import.meta.url.endsWith('.ts') ? stripTypes(read(`${name}.ts`)) : read(`${name}.js`),
    )
    .join('\n')

export const appTemplate = read('index.html')
export const appStyles = read('styles.css')
export const appJavaScript = categoryPrelude + browserScript()
