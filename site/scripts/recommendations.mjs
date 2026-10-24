#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  assertPublicKeyMatchesSeed,
  buildUnsignedRecommendationDocument,
  signRecommendationDocument,
} from './recommendations-lib.mjs'

const root = new URL('../', import.meta.url)
const REGISTRY = new URL('registry/servers.json', root)
const STATUS = new URL('data/status.json', root)
const OUTPUT = new URL('public/.well-known/telium/account-home-recommendations.json', root)

const readJson = async (url) => JSON.parse(await readFile(url, 'utf8'))

const mode = process.argv.includes('--write') ? 'write' : 'check'

const main = async () => {
  const [registry, status] = await Promise.all([readJson(REGISTRY), readJson(STATUS)])
  const { document, excluded } = buildUnsignedRecommendationDocument(registry, status)

  console.log(`account-home recommendations: ${document.servers.length} eligible, ${excluded.length} excluded`)
  for (const item of excluded) {
    console.log(`  ${item.domain}: ${item.reasons.join(', ')}`)
  }

  if (mode === 'check') return

  const seed = process.env.TELIUM_RECOMMENDATION_SIGNING_KEY
  const publicKey = process.env.TELIUM_RECOMMENDATION_PUBLIC_KEY
  const keyId = process.env.TELIUM_RECOMMENDATION_KEY_ID || 'ed25519:account-home-recommendations'
  if (!seed) {
    throw new Error('TELIUM_RECOMMENDATION_SIGNING_KEY is required with --write')
  }
  if (!publicKey) {
    throw new Error('TELIUM_RECOMMENDATION_PUBLIC_KEY is required with --write')
  }

  const verifiedPublicKey = assertPublicKeyMatchesSeed(seed, publicKey)
  const signed = signRecommendationDocument(document, seed, keyId)
  await mkdir(new URL('.', OUTPUT), { recursive: true })
  await writeFile(OUTPUT, `${JSON.stringify(signed, null, 2)}\n`)

  console.log(`wrote ${fileURLToPath(OUTPUT)}`)
  console.log(`verified public key pin: ${verifiedPublicKey}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
