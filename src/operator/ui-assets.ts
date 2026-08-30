import { readFileSync } from 'node:fs'

const asset = (name: string): string => {
  const path =
    name === 'app.js' && import.meta.url.endsWith('.ts')
      ? '../../dist/operator/ui/app.js'
      : `./ui/${name}`
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

export const appTemplate = asset('index.html')
export const appStyles = asset('styles.css')
export const appJavaScript = asset('app.js')
