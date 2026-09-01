import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

mkdirSync('dist/operator/ui', { recursive: true })
cpSync('src/operator/ui/index.html', 'dist/operator/ui/index.html')
cpSync('src/operator/ui/styles.css', 'dist/operator/ui/styles.css')

// Every compiled browser source, whatever they are called. The order the page loads them in is the
// server's to decide, in `src/operator/ui-assets.ts`; restating it here would be a second list to
// keep in step with the first.
const built = '.operator-ui-build/operator/ui'
for (const name of readdirSync(built).filter((entry) => entry.endsWith('.js'))) {
  const script = readFileSync(`${built}/${name}`, 'utf8').replace(/^export \{\};\n/mu, '')
  writeFileSync(`dist/operator/ui/${name}`, script)
}
rmSync('.operator-ui-build', { recursive: true })
