#!/usr/bin/env node
/* Validate registry/servers.json.
 *
 * Hand-rolled rather than pulling a JSON Schema runtime: the schema next to the
 * data is there for editors, but the thing that runs on every pull request
 * should produce an error a first-time contributor can act on — "entry 4:
 * description must be at least 10 characters" — not a JSON Pointer. It also
 * checks two things a schema cannot: duplicate domains, and that the file stays
 * sorted, so merging two PRs never produces a conflict over row order.
 *
 * Run: node scripts/validate-registry.mjs [path]
 */

import { readFile } from 'node:fs/promises'

// With an argument, validate that file instead of the checked-in registry —
// the listing bot points this at the issue's entry merged into a copy, and
// its tests use the same door so the real file is never touched.
const REGISTRY = process.argv[2] ?? new URL('../registry/servers.json', import.meta.url)
const LABEL = typeof REGISTRY === 'string' ? REGISTRY : 'registry/servers.json'

import { REGION_CODES, checkRegion } from '../src/lib/regions.mjs'

const REGIONS = new Set(REGION_CODES)
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const CONTACT = /^(https:\/\/|mailto:)/

const errors = []
const fail = (where, message) => errors.push(`${where}: ${message}`)

const str = (where, value, field, { min = 1, max = Infinity } = {}) => {
  // A missing field was already reported by the required-key check; saying it
  // is also not a string tells a contributor nothing new.
  if (value === undefined) return
  if (typeof value !== 'string') return fail(where, `${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed !== value) fail(where, `${field} has leading or trailing whitespace`)
  if (trimmed.length < min) fail(where, `${field} must be at least ${min} characters`)
  if (trimmed.length > max) fail(where, `${field} must be at most ${max} characters (got ${trimmed.length})`)
}

const REQUIRED_KEYS = ['domain', 'name', 'description', 'region', 'operator', 'added']
const ALLOWED_KEYS = [...REQUIRED_KEYS, 'recommendations']

const main = async () => {
  let registry
  try {
    registry = JSON.parse(await readFile(REGISTRY, 'utf8'))
  } catch (error) {
    console.error(`${LABEL} is not valid JSON — ${error.message}`)
    process.exit(1)
  }

  if (!Array.isArray(registry)) {
    console.error(`${LABEL} must be a JSON array of server entries`)
    process.exit(1)
  }

  const seen = new Map()

  registry.forEach((entry, index) => {
    const where = `entry ${index + 1}${entry?.domain ? ` (${entry.domain})` : ''}`

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return fail(where, 'must be an object')
    }

    for (const key of REQUIRED_KEYS) if (!(key in entry)) fail(where, `missing required field "${key}"`)
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_KEYS.includes(key)) fail(where, `unknown field "${key}" — remove it or update the schema`)
    }

    if (typeof entry.domain === 'string') {
      if (!DOMAIN.test(entry.domain)) {
        fail(where, `domain "${entry.domain}" must be a bare lowercase hostname — no scheme, port or path`)
      }
      if (seen.has(entry.domain)) {
        fail(where, `duplicate domain, already listed as entry ${seen.get(entry.domain) + 1}`)
      } else {
        seen.set(entry.domain, index)
      }
    } else {
      fail(where, 'domain must be a string')
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
      } else {
        // The label's country decides which codes are allowed, so the two cannot drift apart.
        const problem = checkRegion(entry.region)
        if (problem) fail(where, problem)
      }
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

    if (entry.recommendations !== undefined) {
      if (typeof entry.recommendations !== 'object' || entry.recommendations === null || Array.isArray(entry.recommendations)) {
        fail(where, 'recommendations must be an object with "opt_in"')
      } else {
        for (const key of Object.keys(entry.recommendations)) {
          if (key !== 'opt_in') fail(where, `unknown recommendations field "${key}"`)
        }
        if (typeof entry.recommendations.opt_in !== 'boolean') {
          fail(where, 'recommendations.opt_in must be true or false')
        }
      }
    }

    if (typeof entry.added !== 'string' || !DATE.test(entry.added)) {
      fail(where, 'added must be a date as YYYY-MM-DD')
    } else if (Number.isNaN(Date.parse(entry.added))) {
      fail(where, `added "${entry.added}" is not a real date`)
    }
  })

  /* Sorted by domain, with the project's own server first. Keeping the order
     mechanical means two operators adding themselves the same week never
     collide, and nobody has to argue about who is at the top. */
  const domains = registry.map((entry) => entry.domain).filter((d) => typeof d === 'string')
  const expected = [...domains].sort((a, b) => {
    if (a === 'telium.chat') return -1
    if (b === 'telium.chat') return 1
    return a.localeCompare(b)
  })
  if (JSON.stringify(domains) !== JSON.stringify(expected)) {
    fail('file', `entries must be sorted by domain (telium.chat first). Expected order:\n    ${expected.join('\n    ')}`)
  }

  if (errors.length) {
    console.error(`${LABEL} — ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n`)
    for (const error of errors) console.error(`  ${error}`)
    console.error('')
    process.exit(1)
  }

  console.log(`${LABEL} ok — ${registry.length} servers`)
}

main()
