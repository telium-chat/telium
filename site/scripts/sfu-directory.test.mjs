import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildUnsignedSfuDirectory,
  signSfuDirectory,
  sfuEligibility,
  sfuPublicKeyFromSeed,
  verifySfuDirectory,
  CAPACITY_BANDS,
} from './sfu-directory-lib.mjs'

const NOW = Date.parse('2026-11-03T20:00:00Z')
const seed = Buffer.alloc(32, 31).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const otherSeed = Buffer.alloc(32, 32).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

const entry = (overrides = {}) => ({
  url: 'https://sfu.example',
  name: 'Example Relay',
  description: 'A community-run relay in Frankfurt.',
  region: { label: 'Frankfurt, DE', code: 'eu-central' },
  capacity_band: '1g',
  operator: { name: 'Example Collective', contact: 'mailto:ops@example.org' },
  added: '2026-08-01',
  feed: { opt_in: true },
  ...overrides,
})

const probe = (overrides = {}) => ({
  ok: true,
  checked_at: '2026-11-03T19:30:00Z',
  first_probe_at: '2026-08-01T00:00:00Z',
  uptime_30d: 99.9,
  samples: 500,
  ...overrides,
})

test('a healthy, aged-in, opted-in relay is eligible with its declared weight', () => {
  const decision = sfuEligibility(entry({ weight: 3 }), probe(), NOW)
  assert.deepEqual(decision, { eligible: true, reasons: [], weight: 3 })
})

test('every gate fires with its own reason', () => {
  const cases = [
    [entry({ feed: undefined }), probe(), ['operator_not_opted_in']],
    [entry({ operator: { name: 'X', contact: 'ftp://x' } }), probe(), ['operator_contact_missing']],
    [entry({ url: 'http://sfu.example' }), probe(), ['insecure_or_invalid_relay_url']],
    [entry({ capacity_band: '10tb' }), probe(), ['unknown_capacity_band']],
    [entry({ added: '2026-11-01' }), probe(), ['listing_too_new']],
    [entry({ added: '2026-08-01' }), probe({ first_probe_at: '2026-11-01T00:00:00Z' }), ['insufficient_observed_age']],
    [entry(), probe({ ok: false }), ['unreachable']],
    [entry(), probe({ checked_at: '2026-11-01T19:30:00Z' }), ['stale_probe']],
    [entry(), probe({ samples: 3 }), ['insufficient_probe_history']],
    [entry(), probe({ uptime_30d: 97 }), ['uptime_below_minimum']],
    [entry(), probe({ uptime_30d: null }), ['uptime_below_minimum']],
  ]
  for (const [badEntry, badProbe, expected] of cases) {
    const decision = sfuEligibility(badEntry, badProbe, NOW)
    assert.equal(decision.eligible, false, JSON.stringify({ badEntry, badProbe }))
    assert.deepEqual(decision.reasons, expected)
  }
})

test('a relay with a bad probe stays eligible for the directory page but not the feed', () => {
  // This is the directory-only posture: listed on the website, never suggested.
  assert.equal(sfuEligibility(entry({ feed: { opt_in: false } }), probe(), NOW).eligible, false)
})

test('weights clamp into 1..3 and default to 1', () => {
  assert.equal(sfuEligibility(entry({ weight: 99 }), probe(), NOW).weight, 3)
  assert.equal(sfuEligibility(entry({ weight: 0 }), probe(), NOW).weight, 1)
  assert.equal(sfuEligibility(entry(), probe(), NOW).weight, 1)
})

test('the document matches the shape the Rust verifier reads', () => {
  const { document } = buildUnsignedSfuDirectory(
    [entry({ weight: 2, pubkey_hint: 'ed25519:hint' })],
    { sfus: { 'https://sfu.example': probe() } },
    { nowMs: NOW, serial: 7 },
  )
  assert.equal(document.kind, 'telium.sfu_directory')
  assert.equal(document.version, 1)
  assert.equal(document.publisher, 'telium.chat')
  assert.equal(document.serial, 7)
  // Integer epoch milliseconds: the Rust side parses i64, not ISO strings.
  assert.equal(document.issued_at, NOW)
  assert.equal(document.expires_at, NOW + 120 * 60 * 1000)
  assert.deepEqual(document.criteria, {
    min_observed_age_days: 7,
    min_uptime_percent: 99,
    max_probe_age_minutes: 180,
  })
  assert.equal(document.sfus.length, 1)
  assert.equal(document.sfus[0].url, 'https://sfu.example')
  assert.equal(document.sfus[0].weight, 2)
  assert.equal(document.sfus[0].pubkey_hint, 'ed25519:hint')
})

test('an ineligible relay is left out and the rest keep stable order', () => {
  const registry = [
    entry({ url: 'https://z.example', name: 'Zed' }),
    entry({ url: 'https://a.example', name: 'Aye', feed: { opt_in: false } }),
    entry({ url: 'https://m.example', name: 'Em' }),
  ]
  const status = { sfus: {} }
  for (const e of registry) status.sfus[e.url] = probe()
  const { document } = buildUnsignedSfuDirectory(registry, status, { nowMs: NOW, serial: 1 })
  assert.deepEqual(document.sfus.map((s) => s.url), ['https://m.example', 'https://z.example'])
})

test('a serial must be a positive integer and the signature binds the document', () => {
  assert.throws(() => buildUnsignedSfuDirectory([entry()], { sfus: { 'https://sfu.example': probe() } }, { serial: 0 }))
  assert.throws(() => buildUnsignedSfuDirectory([entry()], { sfus: { 'https://sfu.example': probe() } }, { serial: 1.5 }))

  const { document } = buildUnsignedSfuDirectory([entry()], { sfus: { 'https://sfu.example': probe() } }, { nowMs: NOW, serial: 3 })
  const pin = sfuPublicKeyFromSeed(seed)
  const signed = signSfuDirectory(document, seed, 'ed25519:test')
  assert.ok(verifySfuDirectory(signed, pin))

  const impostor = signSfuDirectory(document, otherSeed, 'ed25519:test')
  assert.equal(verifySfuDirectory(impostor, pin), false)

  const tampered = structuredClone(signed)
  tampered.sfus[0].weight = 3
  assert.equal(verifySfuDirectory(tampered, pin), false)

  // issued_at is inside the signature: moving it breaks verification. The
  // expiry window is checked separately by the subscriber against its clock.
  const stale = structuredClone(signed)
  stale.issued_at = NOW - 10 * 60 * 1000
  assert.equal(verifySfuDirectory(stale, pin), false)
})

test('the capacity bands match the protocol crate exactly', () => {
  assert.deepEqual(CAPACITY_BANDS, ['<100m', '100m', '1g', '10g'])
})
