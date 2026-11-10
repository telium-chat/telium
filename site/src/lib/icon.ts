import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cache = new Map<string, string>()

export const loadIcon = (name: string): string => {
  const cached = cache.get(name)
  if (cached !== undefined) return cached

  let source: string
  try {
    source = readFileSync(require.resolve(`@tabler/icons/outline/${name}.svg`), 'utf8')
  } catch {
    throw new Error(`Icon "${name}" not found in @tabler/icons`)
  }

  const inner = source
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<path\s+stroke="none"\s+d="M0 0h24v24H0z"\s+fill="none"\s*\/>/g, '')
    .trim()

  cache.set(name, inner)
  return inner
}
