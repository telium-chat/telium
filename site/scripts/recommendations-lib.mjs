import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
} from 'node:crypto'

export const RECOMMENDATION_KIND = 'telium.account_home_recommendations'
export const RECOMMENDATION_VERSION = 1
export const CURRENT_PROTOCOL = 'v1'

export const MIN_LISTING_AGE_DAYS = 7
export const MIN_SAMPLES = 72
export const MIN_UPTIME_PERCENT = 99
export const MAX_PROBE_AGE_MINUTES = 180
export const MAX_REFERRAL_WEIGHT = 3
export const DEFAULT_VALIDITY_MINUTES = 120

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_LISTING_AGE_MS = MIN_LISTING_AGE_DAYS * DAY_MS
const MAX_PROBE_AGE_MS = MAX_PROBE_AGE_MINUTES * 60 * 1000

const PKCS8_ED25519_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

const fromUrlB64 = (text) => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error('key must be URL-safe base64 without padding')
  }
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

const toUrlB64 = (bytes) => Buffer.from(bytes)
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')

const privateKeyFromSeed = (seedText) => {
  const seed = fromUrlB64(seedText)
  if (seed.length !== 32) throw new Error(`signing seed must decode to 32 bytes, got ${seed.length}`)
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_SEED_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
}

const publicKeyFromRaw = (publicText) => {
  const raw = fromUrlB64(publicText)
  if (raw.length !== 32) throw new Error(`public key must decode to 32 bytes, got ${raw.length}`)
  const prefix = Buffer.from('302a300506032b6570032100', 'hex')
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' })
}

export const publicKeyFromSeed = (seedText) => {
  const privateKey = privateKeyFromSeed(seedText)
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return toUrlB64(der.subarray(der.length - 32))
}

export const assertPublicKeyMatchesSeed = (seedText, publicKeyText) => {
  if (typeof publicKeyText !== 'string' || !publicKeyText) {
    throw new Error('a pinned recommendation public key is required')
  }
  const configured = fromUrlB64(publicKeyText)
  if (configured.length !== 32) {
    throw new Error(`public key must decode to 32 bytes, got ${configured.length}`)
  }
  const derivedText = publicKeyFromSeed(seedText)
  const derived = fromUrlB64(derivedText)
  if (!timingSafeEqual(configured, derived)) {
    throw new Error('configured recommendation public key does not match the signing key')
  }
  return derivedText
}

const sortForCanonicalJson = (value) => {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForCanonicalJson(value[key])]),
  )
}

export const canonicalJson = (value) => JSON.stringify(sortForCanonicalJson(value))

const unsignedBody = (document) => {
  const copy = structuredClone(document)
  delete copy.key_id
  delete copy.signature
  return copy
}

export const signRecommendationDocument = (document, seedText, keyId) => {
  if (!keyId || typeof keyId !== 'string') throw new Error('a non-empty key id is required')
  const body = unsignedBody(document)
  const signature = edSign(null, Buffer.from(canonicalJson(body)), privateKeyFromSeed(seedText))
  return {
    ...body,
    key_id: keyId,
    signature: toUrlB64(signature),
  }
}

export const verifyRecommendationDocument = (document, publicKeyText) => {
  if (!document || typeof document !== 'object' || typeof document.signature !== 'string') return false
  let signature
  try {
    signature = fromUrlB64(document.signature)
  } catch {
    return false
  }
  if (signature.length !== 64) return false
  try {
    return edVerify(
      null,
      Buffer.from(canonicalJson(unsignedBody(document))),
      publicKeyFromRaw(publicKeyText),
      signature,
    )
  } catch {
    return false
  }
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

const clampWeight = (value) => {
  if (!Number.isInteger(value) || value <= 0) return 0
  return Math.min(value, MAX_REFERRAL_WEIGHT)
}

const validOperatorContact = (entry) => (
  typeof entry?.operator?.name === 'string'
  && entry.operator.name.trim().length >= 2
  && typeof entry.operator.contact === 'string'
  && /^(https:\/\/|mailto:)/.test(entry.operator.contact)
)

const validHttpsOrigin = (value) => {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value.replace(/\/$/, '')
  } catch {
    return false
  }
}

export const recommendationEligibility = (entry, probe, nowMs = Date.now()) => {
  const reasons = []
  const optIn = entry?.recommendations?.opt_in === true
  if (!optIn) reasons.push('operator_not_opted_in')
  if (!validOperatorContact(entry)) reasons.push('operator_contact_missing')

  const added = parseAdded(entry?.added)
  if (added === null || nowMs - added < MIN_LISTING_AGE_MS) reasons.push('listing_too_new')

  // Registry metadata is operator-submitted, so the recommendation pool also
  // requires an independently observed age from our own probe history. A new
  // operator cannot backdate `added` and skip the maturation period.
  const firstProbeAt = parseTimestamp(probe?.first_probe_at)
  if (
    firstProbeAt === null
    || nowMs - firstProbeAt < MIN_LISTING_AGE_MS
    || firstProbeAt > nowMs + 5 * 60 * 1000
  ) {
    reasons.push('insufficient_observed_age')
  }

  if (!probe?.ok) reasons.push('unreachable')
  if (probe?.server_name !== entry?.domain) reasons.push('identity_domain_mismatch')
  if (!validHttpsOrigin(probe?.api_origin)) reasons.push('insecure_or_invalid_api_origin')
  if (probe?.registration_open !== true) reasons.push('registration_closed')
  if (probe?.protocol_version !== CURRENT_PROTOCOL) reasons.push('incompatible_protocol')
  if (probe?.moved_to) reasons.push('server_moved')
  if (probe?.sunset) reasons.push('server_sunsetting')
  if (probe?.roles?.identity !== true) reasons.push('identity_role_unavailable')

  const checkedAt = Date.parse(probe?.checked_at ?? '')
  if (!Number.isFinite(checkedAt) || nowMs - checkedAt > MAX_PROBE_AGE_MS || checkedAt > nowMs + 5 * 60 * 1000) {
    reasons.push('stale_probe')
  }

  if (!Number.isInteger(probe?.samples) || probe.samples < MIN_SAMPLES) reasons.push('insufficient_probe_history')
  if (typeof probe?.uptime_30d !== 'number' || probe.uptime_30d < MIN_UPTIME_PERCENT) {
    reasons.push('uptime_below_minimum')
  }

  if (probe?.recommendations_accepting !== true) reasons.push('live_recommendations_disabled')
  const weight = clampWeight(probe?.recommendations_referral_weight)
  if (weight === 0) reasons.push('no_live_referral_weight')

  return {
    eligible: reasons.length === 0,
    reasons,
    weight,
  }
}

export const buildUnsignedRecommendationDocument = (
  registry,
  status,
  { nowMs = Date.now(), validityMinutes = DEFAULT_VALIDITY_MINUTES } = {},
) => {
  if (!Array.isArray(registry)) throw new Error('registry must be an array')
  if (!status || typeof status !== 'object' || !status.servers || typeof status.servers !== 'object') {
    throw new Error('status must contain a servers object')
  }

  const servers = []
  const excluded = []

  for (const entry of registry) {
    const probe = status.servers[entry.domain]
    const decision = recommendationEligibility(entry, probe, nowMs)
    if (!decision.eligible) {
      excluded.push({ domain: entry.domain, reasons: decision.reasons })
      continue
    }

    // Flatten registry display metadata into a deliberately small feed contract.
    // The registry keeps structured operator/region objects for the directory;
    // clients should not need to know that schema just to render one signup card.
    servers.push({
      domain: entry.domain,
      api_origin: probe.api_origin,
      name: entry.name,
      region: entry.region?.code ?? null,
      region_label: entry.region?.label ?? null,
      operator_name: entry.operator?.name ?? null,
      operator_contact: entry.operator?.contact ?? null,
      uptime_30d: probe.uptime_30d,
      checked_at: probe.checked_at,
      weight: decision.weight,
    })
  }

  // Stable order makes signatures reproducible and ensures list position itself
  // is not a hidden ranking signal. Clients randomize locally.
  servers.sort((a, b) => a.domain.localeCompare(b.domain))
  excluded.sort((a, b) => a.domain.localeCompare(b.domain))

  const generatedAt = new Date(nowMs)
  const expiresAt = new Date(nowMs + validityMinutes * 60 * 1000)

  return {
    document: {
      kind: RECOMMENDATION_KIND,
      version: RECOMMENDATION_VERSION,
      publisher: 'telium.chat',
      generated_at: generatedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      criteria: {
        protocol_version: CURRENT_PROTOCOL,
        min_listing_age_days: MIN_LISTING_AGE_DAYS,
        min_observed_age_days: MIN_LISTING_AGE_DAYS,
        min_probe_samples: MIN_SAMPLES,
        min_uptime_percent: MIN_UPTIME_PERCENT,
        max_probe_age_minutes: MAX_PROBE_AGE_MINUTES,
        max_referral_weight: MAX_REFERRAL_WEIGHT,
        registry_opt_in_required: true,
        operator_contact_required: true,
        live_acceptance_required: true,
        identity_role_required: true,
        identity_domain_match_required: true,
        https_api_required: true,
      },
      servers,
    },
    excluded,
  }
}
