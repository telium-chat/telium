// The public SFU directory feed: eligibility, canonicalization and signing.
//
// The document this module builds is consumed by `telium_protocol::sfu_directory`,
// which must verify it byte-for-byte. Two consequences:
//
//  1. Canonical JSON here (recursive key-sort, then JSON.stringify) matches
//     serde_json's BTreeMap ordering on the Rust side, and every number is an
//     integer — a float would serialize differently on either side and fail
//     verification honestly but mysteriously.
//  2. Timestamps and the serial are integer epoch milliseconds, not ISO
//     strings: the Rust `Directory` parses them as i64.
//
// A relay's load and `accepting` flag change by the minute and are deliberately
// absent here; subscribers learn them from the relay's own /health.

import {
  assertPublicKeyMatchesSeed,
  canonicalJson,
  publicKeyFromSeed,
  signRecommendationDocument as signCanonicalDocument,
  verifyRecommendationDocument as verifyCanonicalDocument,
} from './recommendations-lib.mjs'

export const SFU_DIRECTORY_KIND = 'telium.sfu_directory'
export const SFU_DIRECTORY_VERSION = 1

// Eligibility gates. The publisher owns these: they are embedded in the signed
// document's `criteria` block, so a subscriber can see them and explain a thin
// directory. Launch can relax them via env without a code change, and tighten
// them as the directory matures.
const envInt = (name, fallback) => {
  const raw = process.env[name]
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export const MIN_OBSERVED_AGE_DAYS = envInt('SFU_DIRECTORY_MIN_OBSERVED_AGE_DAYS', 7)
export const MIN_UPTIME_PERCENT = envInt('SFU_DIRECTORY_MIN_UPTIME_PERCENT', 99)
export const MAX_PROBE_AGE_MINUTES = envInt('SFU_DIRECTORY_MAX_PROBE_AGE_MINUTES', 180)
export const MIN_SAMPLES = envInt('SFU_DIRECTORY_MIN_PROBE_SAMPLES', 72)
export const MAX_WEIGHT = 3
export const DEFAULT_VALIDITY_MINUTES = 120

export const CAPACITY_BANDS = ['<100m', '100m', '1g', '10g']

export const sfuPublicKeyFromSeed = publicKeyFromSeed

const clampWeight = (value) => {
  if (!Number.isInteger(value) || value <= 0) return 1
  return Math.min(value, MAX_WEIGHT)
}

const parseAdded = (value) => {
  if (typeof value !== 'string') return null
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) ? time : null
}

const parseTimestamp = (value) => {
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

const validHttpsOrigin = (value) => {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

const validOperatorContact = (entry) => (
  typeof entry?.operator?.name === 'string'
  && entry.operator.name.trim().length >= 2
  && typeof entry.operator?.contact === 'string'
  && /^(https:\/\/|mailto:)/.test(entry.operator.contact)
)

export const sfuEligibility = (entry, probe, nowMs = Date.now()) => {
  const reasons = []
  if (entry?.feed?.opt_in !== true) reasons.push('operator_not_opted_in')
  if (!validOperatorContact(entry)) reasons.push('operator_contact_missing')
  if (!validHttpsOrigin(entry?.url)) reasons.push('insecure_or_invalid_relay_url')
  if (!CAPACITY_BANDS.includes(entry?.capacity_band)) reasons.push('unknown_capacity_band')

  const observedMs = MIN_OBSERVED_AGE_DAYS * 24 * 60 * 60 * 1000

  // Two independent ages, like the server registry: the declared listing date
  // and the observed first probe. Backdating `added` cannot skip the latter.
  const added = parseAdded(entry?.added)
  if (added === null || nowMs - added < observedMs) reasons.push('listing_too_new')

  const firstProbeAt = parseTimestamp(probe?.first_probe_at)
  if (firstProbeAt === null || nowMs - firstProbeAt < observedMs || firstProbeAt > nowMs + 5 * 60 * 1000) {
    reasons.push('insufficient_observed_age')
  }

  if (probe?.ok !== true) reasons.push('unreachable')

  const checkedAt = parseTimestamp(probe?.checked_at ?? null)
  if (!Number.isFinite(checkedAt) || nowMs - checkedAt > MAX_PROBE_AGE_MINUTES * 60 * 1000 || checkedAt > nowMs + 5 * 60 * 1000) {
    reasons.push('stale_probe')
  }

  if (!Number.isInteger(probe?.samples) || probe.samples < MIN_SAMPLES) reasons.push('insufficient_probe_history')
  if (typeof probe?.uptime_30d !== 'number' || probe.uptime_30d < MIN_UPTIME_PERCENT) {
    reasons.push('uptime_below_minimum')
  }

  // The weight is the publisher's own ranking judgement, declared in the
  // registry entry and clamped here. It damps automatic selection; it is not
  // a share quota.
  const weight = clampWeight(entry?.weight ?? 1)

  return { eligible: reasons.length === 0, reasons, weight }
}

export const buildUnsignedSfuDirectory = (registry, status, { nowMs = Date.now(), serial, validityMinutes = DEFAULT_VALIDITY_MINUTES } = {}) => {
  if (!Array.isArray(registry)) throw new Error('registry must be an array')
  if (!status || typeof status !== 'object' || !status.sfus || typeof status.sfus !== 'object') {
    throw new Error('status must contain an sfus object')
  }
  if (!Number.isInteger(serial) || serial <= 0) throw new Error('serial must be a positive integer')

  const sfus = []
  for (const entry of registry) {
    const probe = status.sfus[entry.url]
    const decision = sfuEligibility(entry, probe, nowMs)
    if (!decision.eligible) continue
    const card = {
      url: entry.url,
      name: entry.name,
      region: entry.region?.code ?? null,
      region_label: entry.region?.label ?? null,
      operator_name: entry.operator?.name ?? null,
      contact: entry.operator?.contact ?? null,
      capacity_band: entry.capacity_band,
      weight: decision.weight,
    }
    if (typeof entry.description === 'string' && entry.description.trim()) {
      card.description = entry.description
    }
    if (typeof entry.pubkey_hint === 'string' && entry.pubkey_hint.trim()) {
      card.pubkey_hint = entry.pubkey_hint
    }
    sfus.push(card)
  }

  // Sorted by URL: list position is not a ranking signal, and the signature is
  // reproducible for a given (serial, registry, status).
  sfus.sort((a, b) => a.url.localeCompare(b.url))

  return {
    document: {
      kind: SFU_DIRECTORY_KIND,
      version: SFU_DIRECTORY_VERSION,
      publisher: 'telium.chat',
      serial,
      issued_at: nowMs,
      expires_at: nowMs + validityMinutes * 60 * 1000,
      criteria: {
        min_observed_age_days: MIN_OBSERVED_AGE_DAYS,
        min_uptime_percent: MIN_UPTIME_PERCENT,
        max_probe_age_minutes: MAX_PROBE_AGE_MINUTES,
      },
      sfus,
    },
  }
}

// The canonical signing helpers come from the recommendations library, which
// already implements recursive key-sort canonicalization over Ed25519 with a
// 32-byte seed. The Rust verifier (`telium_protocol::sfu_directory`) reads the
// same bytes.
export const signSfuDirectory = (document, seedText, keyId) => signCanonicalDocument(document, seedText, keyId)
export const verifySfuDirectory = (document, publicKeyText) => verifyCanonicalDocument(document, publicKeyText)
export { assertPublicKeyMatchesSeed, canonicalJson }
