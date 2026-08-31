import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

mkdirSync('dist/operator/ui', { recursive: true })
cpSync('src/operator/ui/index.html', 'dist/operator/ui/index.html')
cpSync('src/operator/ui/styles.css', 'dist/operator/ui/styles.css')

for (const name of ['model', 'dom', 'detail', 'app']) {
  const script = readFileSync(`.operator-ui-build/operator/ui/${name}.js`, 'utf8').replace(
    /^export \{\};\n/mu,
    '',
  )
  writeFileSync(`dist/operator/ui/${name}.js`, script)
}
rmSync('.operator-ui-build', { recursive: true })
