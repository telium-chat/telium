#!/usr/bin/env node
/* Poll every homeserver in the registry and write what came back.
 *
 * Telium has no server directory of its own — there is no route, table or
 * config key anywhere in the reference server that enumerates peers. What it
 * does have is two unauthenticated endpoints on every deployment, and between
 * them they carry almost everything the directory wants to show:
 *
 *   GET /.well-known/telium/server  → server_name, api, gateway,
 *                                     protocol_version, moved_to, sunset,
 *                                     onboarding.recommendations
 *   GET <api>/_telium/v1/capabilities → roles, registration_open, features,
 *                                     server_version, media.max_file_bytes
 *
 * The two it cannot answer are population (no server-wide account count exists,
 * authenticated or otherwise) and uptime (nothing tracks it). Population is
 * therefore operator-declared in the registry and labelled as such in the UI;
 * uptime is computed here, from our own history of these probes, and is honestly
 * "reachable from a GitHub runner" rather than "reachable from you".
 *
 * Run: node scripts/probe.mjs
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { recommendationEligibility } from './recommendations-lib.mjs'

const root = new URL('../', import.meta.url)
const REGISTRY = new URL('registry/servers.json', root)
const HISTORY = new URL('data/probe-history.json', root)
const STATUS = new URL('data/status.json', root)

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

/** fetch with a hard deadline; a hung server must not hold the whole run open. */
const getJson = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/json', 'user-agent': 'telium-directory-probe/1.0' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/* `api` in .well-known may be a bare host, a host:port, or a full origin — the
 * point of the delegation is that `home.example` can hand off to
 * `telium.home.example:8443`, so all three shapes are legitimate. */
const toOrigin = (api, fallbackDomain) => {
  const value = (api || '').trim()
  if (!value) return `https://${fallbackDomain}`
  if (/^https?:\/\//.test(value)) return value.replace(/\/+$/, '')
  return `https://${value.replace(/\/+$/, '')}`
}

const readRecommendations = (document) => {
  const recommendations = document?.onboarding?.recommendations
  if (!recommendations || typeof recommendations !== 'object') return null
  return {
    accepting: typeof recommendations.accepting === 'boolean' ? recommendations.accepting : null,
    referralWeight: Number.isInteger(recommendations.referral_weight)
      ? recommendations.referral_weight
      : null,
  }
}

const probe = async (entry) => {
  const started = Date.now()
  const result = {
    domain: entry.domain,
    ok: false,
    checked_at: new Date(started).toISOString(),
    error: null,
    server_name: null,
    api_origin: null,
    protocol_version: null,
    moved_to: null,
    sunset: null,
    registration_open: null,
    server_version: null,
    roles: null,
    features: null,
    max_file_bytes: null,
    recommendations_accepting: null,
    recommendations_referral_weight: null,
    probe_ms: null,
  }

  try {
    const wellKnown = await getJson(`https://${entry.domain}/.well-known/telium/server`)
    result.server_name = typeof wellKnown.server_name === 'string' ? wellKnown.server_name : null
    result.protocol_version = wellKnown.protocol_version ?? null
    result.moved_to = wellKnown.moved_to ?? null
    result.sunset = wellKnown.sunset ?? null
    result.api_origin = toOrigin(wellKnown.api, entry.domain)

    const discoveryRecommendations = readRecommendations(wellKnown)
    if (discoveryRecommendations) {
      result.recommendations_accepting = discoveryRecommendations.accepting
      result.recommendations_referral_weight = discoveryRecommendations.referralWeight
    }

    /* A server that has moved or is sunsetting still answers, and the directory
       would rather say so than quietly drop the row. Reaching .well-known is
       enough to count as up. */
    result.ok = true

    try {
      const caps = await getJson(`${result.api_origin}/_telium/v1/capabilities`)
      result.registration_open = typeof caps.registration_open === 'boolean' ? caps.registration_open : null
      result.server_version = typeof caps.server_version === 'string' ? caps.server_version : null
      result.roles = caps.roles && typeof caps.roles === 'object' ? caps.roles : null
      result.features = caps.features && typeof caps.features === 'object' ? caps.features : null
      result.max_file_bytes = typeof caps.media?.max_file_bytes === 'number' ? caps.media.max_file_bytes : null

      // Prefer capabilities when a server exposes the signal there; discovery
      // is the rollout-compatible fallback. This lets old and new reference
      // servers coexist while keeping one status shape for the generator.
      const capabilityRecommendations = readRecommendations(caps)
      if (capabilityRecommendations) {
        result.recommendations_accepting = capabilityRecommendations.accepting
        result.recommendations_referral_weight = capabilityRecommendations.referralWeight
      }

      if (!result.server_name) result.server_name = typeof caps.server_name === 'string' ? caps.server_name : null
    } catch (error) {
      /* Capabilities is the richer endpoint but the less essential one. A
         server reachable at .well-known and not here is degraded, not down. */
      result.error = `capabilities: ${error.message}`
    }
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
    throw new Error('registry/servers.json is not an array')
  }
  if (registry.length === 0) console.log('registry is empty — pruning recorded state, nothing to probe')

  const results = await pool(registry, CONCURRENCY, probe)
  const now = Date.now()

  // --- history -------------------------------------------------------------
  const history = await readJson(HISTORY, {})
  const cutoff = now - RETAIN_MS
  for (const result of results) {
    const samples = (history[result.domain] ?? []).filter(([t]) => t * 1000 >= cutoff)
    samples.push([Math.round(now / 1000), result.ok ? 1 : 0])
    history[result.domain] = samples
  }
  // Drop servers that have left the registry rather than growing the file forever.
  const live = new Set(registry.map((entry) => entry.domain))
  for (const domain of Object.keys(history)) if (!live.has(domain)) delete history[domain]

  // --- status --------------------------------------------------------------
  const entries = new Map(registry.map((entry) => [entry.domain, entry]))
  const servers = {}
  for (const result of results) {
    const samples = history[result.domain] ?? []
    const up = samples.reduce((total, [, ok]) => total + ok, 0)
    const firstSampleSeconds = samples.length ? samples[0][0] : null
    const measured = {
      ...result,
      /* Withheld until there is enough history to mean anything. A "100%"
         computed from two samples is a worse answer than no answer. */
      uptime_30d: samples.length >= 24 ? Math.round((up / samples.length) * 1000) / 10 : null,
      samples: samples.length,
      // Unlike registry `added`, this cannot be backdated by an operator. The
      // recommendation pool uses it to enforce a real observation period.
      first_probe_at: Number.isInteger(firstSampleSeconds)
        ? new Date(firstSampleSeconds * 1000).toISOString()
        : null,
    }
    // Store the exact same mechanical decision the signed feed generator uses.
    // The directory can therefore explain an exclusion without implementing a
    // second, inevitably divergent version of the recommendation rules.
    measured.recommendation = recommendationEligibility(entries.get(result.domain), measured, now)
    servers[result.domain] = measured
  }

  await writeFile(HISTORY, `${JSON.stringify(history)}\n`)
  await writeFile(
    STATUS,
    /* No timestamp when there is nothing listed: the file stays byte-identical
       between hourly runs, so an empty directory cannot churn a commit and a
       rebuild every probe, and the page has no "last checked" fact to state. */
    `${JSON.stringify(
      { generated_at: registry.length ? new Date(now).toISOString() : null, servers },
      null,
      2,
    )}\n`,
  )

  const reachable = results.filter((result) => result.ok).length
  console.log(`probed ${results.length} servers · ${reachable} reachable · ${results.length - reachable} down`)
  for (const result of results) {
    if (!result.ok) console.log(`  down: ${result.domain} — ${result.error}`)
    else if (result.error) console.log(`  degraded: ${result.domain} — ${result.error}`)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
