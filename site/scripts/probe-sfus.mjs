#!/usr/bin/env node
/* Poll every relay in the SFU registry and write what came back.
 *
 * A relay publishes exactly one unauthenticated endpoint that matters here:
 *
 *   GET {url}/health → { ok, accepting, rooms, participants, transfer }
 *
 * Load and `accepting` change by the minute, so the status file is a snapshot,
 * not the feed: servers read them live from the relay. What this script owns
 * is the slow facts — is it up, since when, what fraction of the last month
 * was it up — computed from our own probe history, and honestly "reachable
 * from a GitHub runner" rather than "reachable from you".
 *
 * Run: node scripts/probe-sfus.mjs
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { sfuEligibility } from './sfu-directory-lib.mjs'

const root = new URL('../', import.meta.url)
const REGISTRY = new URL('registry/sfus.json', root)
const HISTORY = new URL('data/sfu-probe-history.json', root)
const STATUS = new URL('data/sfu-status.json', root)

const TIMEOUT_MS = 8000
const CONCURRENCY = 8
const RETAIN_DAYS = 30
const RETAIN_MS = RETAIN_DAYS * 24 * 60 * 60 * 1000

const readJson = async (url, fallback) => {
  try {
    return JSON.parse(await readFile(url, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`${fileURLToPath(url)} is not valid JSON: ${error.message}`)
  }
}

/** fetch with a hard deadline; a hung relay must not hold the whole run open. */
// A registry PR is not permission to connect a GitHub Actions runner to
// loopback or private networks. DNS is checked before fetch and redirects are
// forbidden. Runner-level egress restrictions remain desirable against DNS
// rebinding between validation and the actual connection.
export function isPublicIp(address) {
  const ip = String(address).toLowerCase().split('%')[0]
  const kind = isIP(ip)
  if (kind === 4) {
    const p = ip.split('.').map(Number)
    const [a, b, c] = p
    return a !== 0 && a !== 10 && a !== 127 && a < 224
      && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && b === 168)
      && !(a === 192 && b === 0)
      && !(a === 192 && b === 88 && c === 99)
      && !(a === 198 && (b === 18 || b === 19))
      && !(a === 192 && b === 0 && c === 0)
      && !(a === 192 && b === 0 && c === 2)
      && !(a === 198 && b === 51 && c === 100)
      && !(a === 203 && b === 0 && c === 113)
  }
  if (kind === 6) {
    if (ip.startsWith('::ffff:')) {
      const suffix = ip.slice('::ffff:'.length)
      return isIP(suffix) === 4 && isPublicIp(suffix)
    }
    const first = Number.parseInt(ip.split(':')[0], 16)
    return first >= 0x2000 && first < 0x4000 && !ip.startsWith('2001:db8:')
      && !ip.startsWith('2001:0:')
  }
  return false
}

export async function assertPublicRelayUrl(raw, resolve = lookup) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('only credential-free HTTPS relay URLs are probeable')
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await resolve(url.hostname, { all: true })
  if (!addresses.length || addresses.some((entry) => !isPublicIp(entry.address))) {
    throw new Error('relay resolves to a non-public address')
  }
}

const getJson = async (url) => {
  await assertPublicRelayUrl(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'application/json', 'user-agent': 'telium-sfu-directory-probe/1.0' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

const probe = async (entry) => {
  const started = Date.now()
  const result = {
    url: entry.url,
    ok: false,
    checked_at: new Date(started).toISOString(),
    error: null,
    accepting: null,
    rooms: null,
    participants: null,
    service: null,
    probe_ms: null,
  }

  try {
    const body = await getJson(`${entry.url.replace(/\/$/, '')}/health`)
    if (body?.service !== 'telium-sfu' || body?.ok !== true
        || typeof body.accepting !== 'boolean') {
      throw new Error('the endpoint did not return a healthy Telium SFU response')
    }
    result.ok = true
    result.accepting = body.accepting
    result.rooms = Number.isInteger(body.rooms) ? body.rooms : null
    result.participants = Number.isInteger(body.participants) ? body.participants : null
    result.service = typeof body.service === 'string' ? body.service : null
  } catch (error) {
    result.error = error.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : error.message
  }

  result.probe_ms = Date.now() - started
  return result
}

/** Run tasks with a ceiling on how many are in flight at once. */
const pool = async (items, limit, worker) => {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

const main = async () => {
  const registry = await readJson(REGISTRY, [])
  if (!Array.isArray(registry)) {
    throw new Error('registry/sfus.json is not an array')
  }
  if (registry.length === 0) console.log('registry is empty — pruning recorded state, nothing to probe')

  const results = await pool(registry, CONCURRENCY, probe)
  const now = Date.now()

  // --- history -------------------------------------------------------------
  const history = await readJson(HISTORY, {})
  const cutoff = now - RETAIN_MS
  for (const result of results) {
    const samples = (history[result.url] ?? []).filter(([t]) => t * 1000 >= cutoff)
    samples.push([Math.round(now / 1000), result.ok ? 1 : 0])
    history[result.url] = samples
  }
  // Drop relays that have left the registry rather than growing the file forever.
  const live = new Set(registry.map((entry) => entry.url))
  for (const url of Object.keys(history)) if (!live.has(url)) delete history[url]

  // --- status --------------------------------------------------------------
  const entries = new Map(registry.map((entry) => [entry.url, entry]))
  const sfus = {}
  for (const result of results) {
    const samples = history[result.url] ?? []
    const up = samples.reduce((total, [, ok]) => total + ok, 0)
    const firstSampleSeconds = samples.length ? samples[0][0] : null
    const measured = {
      ...result,
      /* Withheld until there is enough history to mean anything. A "100%"
         computed from two samples is a worse answer than no answer. */
      uptime_30d: samples.length >= 24 ? Math.round((up / samples.length) * 1000) / 10 : null,
      samples: samples.length,
      // Unlike registry `added`, this cannot be backdated by an operator. The
      // eligibility gate uses it to enforce a real observation period.
      first_probe_at: Number.isInteger(firstSampleSeconds)
        ? new Date(firstSampleSeconds * 1000).toISOString()
        : null,
    }
    // Store the exact same mechanical decision the signed feed generator uses,
    // so the page can explain an exclusion without a second copy of the rules.
    measured.eligibility = sfuEligibility(entries.get(result.url), measured, now)
    sfus[result.url] = measured
  }

  await writeFile(HISTORY, `${JSON.stringify(history)}\n`)
  await writeFile(
    STATUS,
    /* No timestamp when there is nothing listed: the file stays byte-identical
       between hourly runs, so an empty directory cannot churn a commit and a
       rebuild every probe. */
    `${JSON.stringify(
      { generated_at: registry.length ? new Date(now).toISOString() : null, sfus },
      null,
      2,
    )}\n`,
  )

  const reachable = results.filter((result) => result.ok).length
  console.log(`probed ${results.length} relays · ${reachable} reachable · ${results.length - reachable} down`)
  for (const result of results) {
    if (!result.ok) console.log(`  down: ${result.url} — ${result.error}`)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
