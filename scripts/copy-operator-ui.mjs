import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

import { timelineCategories } from '../dist/telemetry.js'

mkdirSync('dist/operator/ui', { recursive: true })
cpSync('src/operator/ui/index.html', 'dist/operator/ui/index.html')
cpSync('src/operator/ui/styles.css', 'dist/operator/ui/styles.css')

const scriptPath = 'dist/operator/ui/app.js'
const script = readFileSync('.operator-ui-build/operator/ui/app.js', 'utf8').replace(
  /^export \{\};\n/mu,
  '',
)
writeFileSync(
  scriptPath,
  "'use strict'\nconst timelineCategories = Object.freeze(" +
    JSON.stringify(timelineCategories) +
    ')\n' +
    script,
)
rmSync('.operator-ui-build', { recursive: true })
