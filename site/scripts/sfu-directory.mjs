#!/usr/bin/env node

// Builds (and with --write signs) the public SFU directory feed that servers
// fetch and verify. The serial is monotonic and lives in data/, committed by
// the probe workflow, so a re-run can never replay or equivocate: two runs in
// one validity window with different contents get different serials.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  assertPublicKeyMatchesSeed,
  buildUnsignedSfuDirectory,
  sfuEligibility,
  signSfuDirectory,
  verifySfuDirectory,
} from './sfu-directory-lib.mjs'

const root = new URL('../', import.meta.url)
const REGISTRY = new URL('registry/sfus.json', root)
const STATUS = new URL('data/sfu-status.json', root)
const SERIAL = new URL('data/sfu-directory-serial.json', root)
const OUTPUT = new URL('public/.well-known/telium/sfu-directory.json', root)

const readJson = async (url) => JSON.parse(await readFile(url, 'utf8'))

const mode = process.argv.includes('--write') ? 'write' : 'check'

const main = async () => {
  const [registry, status] = await Promise.all([readJson(REGISTRY), readJson(STATUS)])

  let serial = 0
  try {
    const held = await readJson(SERIAL)
    if (Number.isInteger(held?.serial)) serial = held.serial
  } catch {
    // First run: the feed starts at serial 1.
  }

  const { document } = buildUnsignedSfuDirectory(registry, status, { serial: serial + 1 })
  console.log(`sfu directory: ${document.sfus.length} listed, serial ${document.serial}`)
  for (const entry of registry) {
    const probe = status.sfus?.[entry.url]
    const { eligible, reasons } = sfuEligibility(entry, probe)
    if (!eligible) console.log(`  ${entry.url}: ${reasons.join(', ')}`)
  }

  if (mode === 'check') return

  const seed = process.env.TELIUM_SFU_DIRECTORY_SIGNING_KEY
  const publicKey = process.env.TELIUM_SFU_DIRECTORY_PUBLIC_KEY
  const keyId = process.env.TELIUM_SFU_DIRECTORY_KEY_ID || 'ed25519:sfu-directory'
  if (!seed) throw new Error('TELIUM_SFU_DIRECTORY_SIGNING_KEY is required with --write')
  if (!publicKey) throw new Error('TELIUM_SFU_DIRECTORY_PUBLIC_KEY is required with --write')
  assertPublicKeyMatchesSeed(seed, publicKey)

  const signed = signSfuDirectory(document, seed, keyId)
  if (!verifySfuDirectory(signed, publicKey)) {
    throw new Error('refusing to publish: the freshly signed document does not verify under the pinned key')
  }

  await mkdir(new URL('.', OUTPUT), { recursive: true })
  await writeFile(OUTPUT, `${JSON.stringify(signed, null, 2)}\n`)
  await writeFile(SERIAL, `${JSON.stringify({ serial: document.serial }, null, 2)}\n`)

  console.log(`wrote ${fileURLToPath(OUTPUT)}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
