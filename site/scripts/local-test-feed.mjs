#!/usr/bin/env node

// Mints an EPHEMERAL signing key and writes a signed account-home
// recommendation feed for LOCAL testing of the signup recommender. This is a
// test fixture, not a publication: the key lives only in this run's output,
// the feed names servers you pass on the command line, and everything it
// writes is gitignored.
//
//   node scripts/local-test-feed.mjs [api-origin] [name]
//
//   node scripts/local-test-feed.mjs https://staging.telium.chat "Telium Staging"
//
// The api-origin must be https — the client refuses anything else, exactly as
// it would refuse it from the production feed. The script prints the
// VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY the client must be built with, and
// writes it to web/.env.local so the next `bun run build:portal` pins it.
//
// To go back to the dormant recommender, delete the two files it names.

import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { publicKeyFromSeed, signRecommendationDocument } from './recommendations-lib.mjs'

const root = new URL('../', import.meta.url)
const OUTPUT = new URL('public/.well-known/telium/account-home-recommendations.json', root)
const ENV_LOCAL = new URL('../web/.env.local', root)

const [originArg, nameArg] = process.argv.slice(2)
const apiOrigin = originArg ?? 'https://staging.telium.chat'

const parsed = new URL(apiOrigin)
if (parsed.protocol !== 'https:' || parsed.origin !== apiOrigin.replace(/\/$/, '')) {
  throw new Error(`api origin must be a bare https origin, got "${apiOrigin}"`)
}
const domain = parsed.host

const toUrlB64 = (bytes) => Buffer.from(bytes)
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')

// A fresh seed every run: a local feed never outlives the machine that trusts it.
const seed = toUrlB64(randomBytes(32))
const publicKey = publicKeyFromSeed(seed)
const keyId = 'ed25519:local-test'

const now = Date.now()
const document = {
  kind: 'telium.account_home_recommendations',
  version: 1,
  publisher: 'local.test',
  generated_at: new Date(now).toISOString(),
  expires_at: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
  servers: [{
    domain,
    api_origin: parsed.origin,
    name: nameArg ?? `Local test — ${domain}`,
    region: null,
    region_label: null,
    operator_name: 'Local test run',
    operator_contact: null,
    uptime_30d: 100,
    checked_at: new Date(now).toISOString(),
    weight: 1,
  }],
}
const signed = signRecommendationDocument(document, seed, keyId)

await mkdir(new URL('.', OUTPUT), { recursive: true })
await writeFile(OUTPUT, `${JSON.stringify(signed, null, 2)}\n`)

// The client reads the pinned key at build time; .env.local is the local place
// for it, and is already outside version control.
let previous = ''
try { previous = await readFile(ENV_LOCAL, 'utf8') } catch { /* a fresh file */ }
const kept = previous
  .split('\n')
  .filter((line) => line && !line.startsWith('VITE_TELIUM_RECOMMENDATION_'))
await writeFile(
  ENV_LOCAL,
  `${kept.join('\n')}${kept.length ? '\n' : ''}`
  + `VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY=${publicKey}\n`
  + `VITE_TELIUM_RECOMMENDATION_KEY_ID=${keyId}\n`,
)

console.log(`wrote ${fileURLToPath(OUTPUT)}`)
console.log(`wrote ${fileURLToPath(ENV_LOCAL)}`)
console.log('')
console.log('Rebuild the portal so the client pins this key, then serve it:')
console.log('')
console.log('  bun run build:portal && bun run preview:portal')
console.log('')
console.log(`pinned key: VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY=${publicKey}`)
