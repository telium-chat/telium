#!/usr/bin/env node
/* Fail the build if the site would load anything from a host we do not control.
 *
 * The footer says "No analytics. No third-party fonts. No trackers." That is a
 * promise about what the browser does, so it is checked by looking at what the
 * browser would actually fetch: attributes that pull a subresource, and the
 * url()/@import rules in the stylesheets. A fresh dependency that quietly adds
 * a font CDN or a preconnect hint breaks the build rather than the promise.
 *
 * Two things are deliberately not violations:
 *
 *   - <a href>. A hyperlink to GitHub loads nothing until somebody clicks it.
 *   - The latency probe on /servers. It requests the homeservers in the
 *     registry, which is the entire point of the column, and the page discloses
 *     it in prose with a toggle to turn it off. Those requests are checked
 *     against the registry, so the probe cannot reach a host that is not listed.
 *
 * Run: node scripts/check-no-third-party.mjs
 */

import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const DIST = new URL('dist/', root)

const registry = JSON.parse(await readFile(new URL('registry/servers.json', root), 'utf8'))
const listed = new Set(registry.map((entry) => entry.domain))

/* Hosts an analytics or tag script would talk to. The attribute scan below
 * already catches a <script src> pointing at one of these; this list catches the
 * subtler shape — a string in an inlined bundle that is fetched at runtime. */
const TRACKERS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'g.doubleclick',
  'facebook.net', 'connect.facebook', 'hotjar.com', 'segment.io', 'segment.com',
  'mixpanel.com', 'amplitude.com', 'sentry.io', 'plausible.io', 'posthog.com',
  'fullstory.com', 'clarity.ms', 'matomo.cloud', 'newrelic.com', 'intercom.io',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com',
  'cdnjs.cloudflare.com', 'polyfill.io',
]

const problems = []

const walk = async (dir) => {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
    if (entry.isDirectory()) files.push(...(await walk(child)))
    else files.push(child)
  }
  return files
}

/** Absolute URLs whose host is not ours. Protocol-relative counts too. */
const foreign = (value) => {
  const match = /^(?:https?:)?\/\/([^/?#]+)/i.exec(value.trim())
  if (!match) return null
  const host = match[1].replace(/^[^@]*@/, '').split(':')[0].toLowerCase()
  return host === 'telium.chat' || host.endsWith('.telium.chat') ? null : host
}

/* Attributes that make the browser fetch something without any user action.
 * href is only one of them on <link>, which is why it is matched with its tag. */
const ATTRS = /\b(?:src|srcset|poster|data-src|imagesrcset)\s*=\s*"([^"]*)"/gi
const LINKS = /<link\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>/gi
const CSS_URL = /url\(\s*['"]?([^'")]+)/gi
const CSS_IMPORT = /@import\s+(?:url\(\s*)?['"]([^'"]+)/gi

const scan = (file, text) => {
  const name = file.replace(fileURLToPath(root), '')

  const flag = (host, what) => {
    if (listed.has(host)) return // a registry homeserver, probed on purpose
    problems.push(`${name}: ${what} → ${host}`)
  }

  for (const [, value] of text.matchAll(ATTRS)) {
    for (const candidate of value.split(',')) {
      const host = foreign(candidate.trim().split(/\s+/)[0] ?? '')
      if (host) flag(host, 'subresource')
    }
  }

  for (const [tag, href] of text.matchAll(LINKS)) {
    /* rel="me" and rel="license" are metadata; they load nothing. Everything
       else on a <link> — stylesheet, preload, preconnect, dns-prefetch, icon,
       manifest — either fetches or opens a connection. */
    if (/\brel\s*=\s*"(?:me|license|author|canonical|alternate)"/i.test(tag)) continue
    const host = foreign(href)
    if (host) flag(host, 'link')
  }

  for (const pattern of [CSS_URL, CSS_IMPORT]) {
    for (const [, value] of text.matchAll(pattern)) {
      const host = foreign(value)
      if (host) flag(host, 'stylesheet')
    }
  }

  for (const tracker of TRACKERS) {
    /* Skip CSS comments — Tailwind's output names tailwindcss.com in one. */
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '')
    if (stripped.includes(tracker)) problems.push(`${name}: names ${tracker}`)
  }
}

const files = (await walk(DIST)).filter((file) => /\.(html|css|js|json|svg|xml)$/i.test(file.pathname))
if (files.length === 0) {
  console.error('dist/ has nothing to check — run `bun run build` first')
  process.exit(1)
}

for (const file of files) scan(fileURLToPath(file), await readFile(file, 'utf8'))

if (problems.length) {
  console.error(`third-party requests in the build — ${problems.length}:\n`)
  for (const problem of [...new Set(problems)]) console.error(`  ${problem}`)
  console.error('\nThe footer claims the site makes none. Remove the dependency or the claim.\n')
  process.exit(1)
}

console.log(`no third-party requests — checked ${files.length} files`)
