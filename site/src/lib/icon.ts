/* Read a Lucide glyph off disk, once per icon per build.
 *
 * Resolution goes through Node rather than a relative path because Astro
 * bundles the component into dist/.prerender/chunks/ before rendering it, and a
 * path relative to the source file points at nothing from there.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cache = new Map<string, string>()

export const loadIcon = (name: string): string => {
  const cached = cache.get(name)
  if (cached !== undefined) return cached

  let source: string
  try {
    source = readFileSync(fileURLToPath(import.meta.resolve(`lucide-static/icons/${name}.svg`)), 'utf8')
  } catch {
    // A missing icon should break the build, not ship a silent gap in the page.
    throw new Error(`Icon "${name}" not found in lucide-static`)
  }

  // Keep only the drawing. The wrapper in Icon.astro owns every presentational
  // attribute, so a future lucide release cannot quietly change our stroke weight.
  const inner = source
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim()

  cache.set(name, inner)
  return inner
}
