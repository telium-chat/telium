#!/usr/bin/env node
/* Validate registry/sfus.json — the public SFU relay directory.
 *
 * Same philosophy as validate-registry.mjs: hand-rolled checks whose errors a
 * first-time contributor can act on, plus the two things a schema cannot say —
 * duplicate relay URLs, and that the file stays sorted by URL so merging two
 * PRs never conflicts over row order.
 *
 * A relay URL is the entry's identity, and it must be a bare HTTPS origin: the
 * signed feed refuses anything else, so a submission that would never list
 * should fail here first, in plainer words.
 *
 * Run: node scripts/validate-sfus.mjs [path]
 */

import { readFile } from 'node:fs/promises'

// With an argument, validate that file instead of the checked-in registry —
// the listing bot points this at the issue's entry merged into a copy, and
// its tests use the same door so the real file is never touched.
const REGISTRY = process.argv[2] ?? new URL('../registry/sfus.json', import.meta.url)
const LABEL = typeof REGISTRY === 'string' ? REGISTRY : 'registry/sfus.json'

const REGIONS = new Set([
  'af-south', 'ap-east', 'ap-south', 'ap-southeast', 'eu-central', 'eu-north',
  'eu-west', 'me-central', 'na-central', 'na-east', 'na-west', 'oc-southeast', 'sa-east',
])
const CAPACITY_BANDS = new Set(['<100m', '100m', '1g', '10g'])
const DATE = /^\d{4}-\d{2}-\d{2}$/
const CONTACT = /^(https:\/\/|mailto:)/

const errors = []
const fail = (where, message) => errors.push(`${where}: ${message}`)

const str = (where, value, field, { min = 1, max = Infinity } = {}) => {
  if (value === undefined) return
  if (typeof value !== 'string') return fail(where, `${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed !== value) fail(where, `${field} has leading or trailing whitespace`)
  if (trimmed.length < min) fail(where, `${field} must be at least ${min} characters`)
  if (trimmed.length > max) fail(where, `${field} must be at most ${max} characters (got ${trimmed.length})`)
}

// A bare HTTPS origin: scheme, host, optional port, nothing else. Usernames in
// URLs put a trusted-looking part before the `@`.
const relayUrl = (value) => {
  if (typeof value !== 'string') return 'must be a string'
  // WHATWG URL parsing strips embedded tabs and newlines. They must never
  // survive validation and become additional GITHUB_OUTPUT lines.
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'must not contain control characters'
  let url
  try {
    url = new URL(value)
  } catch {
    return 'must be an absolute URL, like https://sfu.example.com'
  }
  if (url.protocol !== 'https:') return 'must be https:// — browsers probe relays from a secure page'
  if (url.username || url.password) return 'must not carry a username or password'
  if (url.pathname !== '/' && url.pathname !== '') return `must be a bare origin — no path (got "${url.pathname}")`
  if (url.search || url.hash) return 'must be a bare origin — no query or fragment'
  if (!url.hostname.includes('.')) return 'hostname must be a real domain, not a bare TLD or IP literal'
  return null
}

const REQUIRED_KEYS = ['url', 'name', 'description', 'region', 'capacity_band', 'operator', 'added']
const ALLOWED_KEYS = [...REQUIRED_KEYS, 'weight', 'pubkey_hint', 'feed']

const main = async () => {
  let registry
  try {
    registry = JSON.parse(await readFile(REGISTRY, 'utf8'))
  } catch (error) {
    console.error(`${LABEL} is not valid JSON — ${error.message}`)
    process.exit(1)
  }

  if (!Array.isArray(registry)) {
    console.error(`${LABEL} must be a JSON array of relay entries`)
    process.exit(1)
  }

  const seen = new Map()

  registry.forEach((entry, index) => {
    const where = `entry ${index + 1}${entry?.url ? ` (${entry.url})` : ''}`

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return fail(where, 'must be an object')
    }

    for (const key of REQUIRED_KEYS) if (!(key in entry)) fail(where, `missing required field "${key}"`)
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_KEYS.includes(key)) fail(where, `unknown field "${key}" — remove it or update the schema`)
    }

    const urlProblem = relayUrl(entry.url)
    if (urlProblem) fail(where, `url ${urlProblem}`)
    if (typeof entry.url === 'string' && !urlProblem) {
      const normalized = entry.url.replace(/\/$/, '')
      if (normalized !== entry.url) fail(where, 'url must not have a trailing slash')
      if (seen.has(normalized)) {
        fail(where, `duplicate url, already listed as entry ${seen.get(normalized) + 1}`)
      } else {
        seen.set(normalized, index)
      }
    }

    str(where, entry.name, 'name', { min: 2, max: 40 })
    str(where, entry.description, 'description', { min: 10, max: 160 })

    if (typeof entry.region !== 'object' || entry.region === null || Array.isArray(entry.region)) {
      fail(where, 'region must be an object with "label" and "code"')
    } else {
      for (const key of Object.keys(entry.region)) {
        if (!['label', 'code'].includes(key)) fail(where, `unknown region field "${key}"`)
      }
      str(where, entry.region.label, 'region.label', { min: 2, max: 40 })
      if (!REGIONS.has(entry.region.code)) {
        fail(where, `region.code must be one of ${[...REGIONS].join(', ')} — got ${JSON.stringify(entry.region.code)}`)
      }
    }

    if (!CAPACITY_BANDS.has(entry.capacity_band)) {
      fail(where, `capacity_band must be one of ${[...CAPACITY_BANDS].join(', ')} — got ${JSON.stringify(entry.capacity_band)}`)
    }

    if (typeof entry.operator !== 'object' || entry.operator === null || Array.isArray(entry.operator)) {
      fail(where, 'operator must be an object with "name" and "contact"')
    } else {
      for (const key of Object.keys(entry.operator)) {
        if (!['name', 'contact'].includes(key)) fail(where, `unknown operator field "${key}"`)
      }
      str(where, entry.operator.name, 'operator.name', { min: 2, max: 60 })
      if (typeof entry.operator.contact !== 'string' || !CONTACT.test(entry.operator.contact)) {
        fail(where, 'operator.contact must be an https:// URL or a mailto: address')
      }
    }

    if (entry.weight !== undefined && (!Number.isInteger(entry.weight) || entry.weight < 1 || entry.weight > 3)) {
      fail(where, 'weight must be an integer from 1 to 3 — it damps automatic selection; leave it out for 1')
    }

    if (entry.pubkey_hint !== undefined && (typeof entry.pubkey_hint !== 'string' || entry.pubkey_hint.length > 128)) {
      fail(where, 'pubkey_hint must be a string of at most 128 characters')
    }

    if (entry.feed !== undefined) {
      if (typeof entry.feed !== 'object' || entry.feed === null || Array.isArray(entry.feed)) {
        fail(where, 'feed must be an object with "opt_in"')
      } else {
        for (const key of Object.keys(entry.feed)) {
          if (key !== 'opt_in') fail(where, `unknown feed field "${key}"`)
        }
        if (typeof entry.feed.opt_in !== 'boolean') {
          fail(where, 'feed.opt_in must be true or false')
        }
      }
    }

    if (typeof entry.added !== 'string' || !DATE.test(entry.added)) {
      fail(where, 'added must be a date as YYYY-MM-DD')
    } else if (Number.isNaN(Date.parse(entry.added))) {
      fail(where, `added "${entry.added}" is not a real date`)
    }
  })

  // Sorted by URL, no pinned first entry: the directory has no home team.
  const urls = registry.map((entry) => entry.url).filter((u) => typeof u === 'string')
  const expected = [...urls].sort((a, b) => a.localeCompare(b))
  if (JSON.stringify(urls) !== JSON.stringify(expected)) {
    fail('file', `entries must be sorted by url. Expected order:\n    ${expected.join('\n    ')}`)
  }

  if (errors.length) {
    console.error(`${LABEL} — ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n`)
    for (const error of errors) console.error(`  ${error}`)
    console.error('')
    process.exit(1)
  }

  console.log(`${LABEL} ok — ${registry.length} relays`)
}

main()
