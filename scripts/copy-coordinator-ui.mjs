/** Package only Vite's public output beside the second executable. */
import { cpSync, rmSync } from 'node:fs'
const destination = new URL('../packages/coordinator/dist/ui/', import.meta.url)
rmSync(destination, { recursive: true, force: true })
cpSync(new URL('../packages/coordinator-ui/dist/', import.meta.url), destination, {
  recursive: true,
})
