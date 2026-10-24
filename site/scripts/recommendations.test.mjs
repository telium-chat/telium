import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_REFERRAL_WEIGHT,
  assertPublicKeyMatchesSeed,
  buildUnsignedRecommendationDocument,
  publicKeyFromSeed,
  recommendationEligibility,
  signRecommendationDocument,
  verifyRecommendationDocument,
} from './recommendations-lib.mjs'

const NOW = Date.parse('2026-09-16T20:00:00Z')
const seed = Buffer.alloc(32, 7)
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
const otherSeed = Buffer.alloc(32, 9)
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')

const entry = (overrides = {}) => ({
  domain: 'community.example',
  name: 'Community',
  description: 'A community Telium homeserver for tests.',
  region: { label: 'Oregon, US', code: 'na-west' },
  size_band: '100-1k',
  operator: { name: 'Community Ops', contact: 'https://community.example/contact' },
  added: '2026-08-01',
  recommendations: { opt_in: true },
  ...overrides,
})

const probe = (overrides = {}) => ({
  ok: true,
  checked_at: '2026-09-16T19:30:00Z',
  first_probe_at: '2026-08-01T00:00:00Z',
  server_name: 'community.example',
  api_origin: 'https://api.community.example',
  protocol_version: 'v1',
  moved_to: null,
  sunset: null,
  registration_open: true,
  roles: { identity: true, guild: true, media: true },
  uptime_30d: 99.9,
  samples: 500,
  recommendations_accepting: true,
  recommendations_referral_weight: 2,
  ...overrides,
})

test('a healthy opted-in identity server is eligible', () => {
  const result = recommendationEligibility(entry(), probe(), NOW)
  assert.equal(result.eligible, true)
  assert.equal(result.weight, 2)
  assert.deepEqual(result.reasons, [])
})

test('registry listing alone never opts a server into automatic referrals', () => {
  const result = recommendationEligibility(entry({ recommendations: undefined }), probe(), NOW)
  assert.equal(result.eligible, false)
  assert.ok(result.reasons.includes('operator_not_opted_in'))
})

test('a backdated registry entry cannot skip the observed maturation period', () => {
  const result = recommendationEligibility(
    entry({ added: '2025-01-01' }),
    probe({ first_probe_at: '2026-09-15T00:00:00Z' }),
    NOW,
  )
  assert.equal(result.eligible, false)
  assert.ok(result.reasons.includes('insufficient_observed_age'))
})

test('a reachable operator contact is required for beginner recommendations', () => {
  const result = recommendationEligibility(
    entry({ operator: { name: 'Community Ops', contact: '' } }),
    probe(),
    NOW,
  )
  assert.equal(result.eligible, false)
  assert.ok(result.reasons.includes('operator_contact_missing'))
})

test('live server signal is required even after registry opt-in', () => {
  const result = recommendationEligibility(entry(), probe({ recommendations_accepting: null }), NOW)
  assert.equal(result.eligible, false)
  assert.ok(result.reasons.includes('live_recommendations_disabled'))
})

test('automatic recommendations require the probed identity domain and a secure API origin', () => {
  const wrongDomain = recommendationEligibility(
    entry(),
    probe({ server_name: 'elsewhere.example' }),
    NOW,
  )
  assert.equal(wrongDomain.eligible, false)
  assert.ok(wrongDomain.reasons.includes('identity_domain_mismatch'))

  const insecureApi = recommendationEligibility(
    entry(),
    probe({ api_origin: 'http://api.community.example' }),
    NOW,
  )
  assert.equal(insecureApi.eligible, false)
  assert.ok(insecureApi.reasons.includes('insecure_or_invalid_api_origin'))
})

test('bad health, incompatible protocol, migration and stale probes exclude a server', () => {
  const result = recommendationEligibility(entry(), probe({
    ok: false,
    registration_open: false,
    protocol_version: 'v2',
    moved_to: 'new.example',
    sunset: { mode: 'planned' },
    checked_at: '2026-09-15T00:00:00Z',
    samples: 3,
    uptime_30d: 80,
  }), NOW)
  assert.equal(result.eligible, false)
  for (const reason of [
    'unreachable',
    'registration_closed',
    'incompatible_protocol',
    'server_moved',
    'server_sunsetting',
    'stale_probe',
    'insufficient_probe_history',
    'uptime_below_minimum',
  ]) {
    assert.ok(result.reasons.includes(reason), reason)
  }
})

test('referral weight is bounded so a server cannot claim the whole stream', () => {
  const result = recommendationEligibility(entry(), probe({ recommendations_referral_weight: 999 }), NOW)
  assert.equal(result.eligible, true)
  assert.equal(result.weight, MAX_REFERRAL_WEIGHT)
})

test('zero live weight is a pause even when accepting is true', () => {
  const result = recommendationEligibility(entry(), probe({ recommendations_referral_weight: 0 }), NOW)
  assert.equal(result.eligible, false)
  assert.ok(result.reasons.includes('no_live_referral_weight'))
})

test('document contains only eligible servers, normalized display metadata and stable ordering', () => {
  const registry = [
    entry({ domain: 'z.example', name: 'Zed' }),
    entry({ domain: 'a.example', name: 'Aye' }),
    entry({ domain: 'off.example', name: 'Off', recommendations: { opt_in: false } }),
  ]
  const status = {
    servers: {
      'z.example': probe({ server_name: 'z.example', api_origin: 'https://api.z.example' }),
      'a.example': probe({
        server_name: 'a.example',
        api_origin: 'https://accounts.a.example:8443',
        recommendations_referral_weight: 1,
      }),
      'off.example': probe({ server_name: 'off.example', api_origin: 'https://off.example' }),
    },
  }
  const { document, excluded } = buildUnsignedRecommendationDocument(registry, status, { nowMs: NOW })
  assert.deepEqual(document.servers.map((server) => server.domain), ['a.example', 'z.example'])
  assert.deepEqual(excluded.map((server) => server.domain), ['off.example'])
  assert.equal(document.criteria.live_acceptance_required, true)
  assert.equal(document.criteria.operator_contact_required, true)
  assert.equal(document.criteria.identity_domain_match_required, true)
  assert.equal(document.criteria.https_api_required, true)
  assert.equal(document.criteria.min_observed_age_days, 7)
  assert.deepEqual(document.servers[0], {
    domain: 'a.example',
    api_origin: 'https://accounts.a.example:8443',
    name: 'Aye',
    region: 'na-west',
    region_label: 'Oregon, US',
    operator_name: 'Community Ops',
    operator_contact: 'https://community.example/contact',
    uptime_30d: 99.9,
    checked_at: '2026-09-16T19:30:00Z',
    weight: 1,
  })
})

test('configured public recommendation pin must match the signing seed', () => {
  const publicKey = publicKeyFromSeed(seed)
  assert.equal(assertPublicKeyMatchesSeed(seed, publicKey), publicKey)

  assert.throws(
    () => assertPublicKeyMatchesSeed(seed, publicKeyFromSeed(otherSeed)),
    /does not match the signing key/,
  )
  assert.throws(
    () => assertPublicKeyMatchesSeed(seed, ''),
    /public key is required/,
  )
})

test('signed documents verify and tampering is rejected', () => {
  const { document } = buildUnsignedRecommendationDocument(
    [entry()],
    { servers: { 'community.example': probe() } },
    { nowMs: NOW },
  )
  const signed = signRecommendationDocument(document, seed, 'ed25519:test')
  const publicKey = publicKeyFromSeed(seed)
  assert.equal(verifyRecommendationDocument(signed, publicKey), true)

  const tampered = structuredClone(signed)
  tampered.servers[0].weight = 3
  assert.equal(verifyRecommendationDocument(tampered, publicKey), false)
})
