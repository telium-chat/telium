#!/usr/bin/env node
// Builds and signs the SFU release manifest, the document that can make a relay replace its own executable.
// Same primitives as every other Telium manifest, with its own statement prefix: one document kind per
// component, so a server list can never verify as an SFU list (and the SFU verifies these byte for byte).

import { readFileSync, writeFileSync } from 'node:fs'
import {
  assertPublicKeyMatchesSeed,
  signBytesWith,
  verifyBytesWith,
} from './sign-release-manifest.mjs'

/// Must match `STATEMENT_VERSION` in `sfu/src/updates.rs`.
export const STATEMENT_VERSION = 'telium-sfu-release-manifest-v1'

export const signSfuManifestBytes = (bytes, seedText, keyId) =>
  signBytesWith(STATEMENT_VERSION, bytes, seedText, keyId)

export const verifySfuManifestBytes = (bytes, sigDocument, publicKeyText) =>
  verifyBytesWith(STATEMENT_VERSION, bytes, sigDocument, publicKeyText)

const main = () => {
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv

  if (command === 'sign') {
    const manifestPath = rest[0]
    if (!manifestPath) throw new Error('usage: sign <manifest.json> [--out <file>]')
    const outIndex = rest.indexOf('--out')
    const outPath = outIndex >= 0 ? rest[outIndex + 1] : `${manifestPath}.sig`

    const seed = process.env.TELIUM_RELEASE_SIGNING_KEY
    const publicKey = process.env.TELIUM_RELEASE_PUBLIC_KEY
    const keyId = process.env.TELIUM_RELEASE_KEY_ID
    if (!seed) throw new Error('TELIUM_RELEASE_SIGNING_KEY is not set')
    if (!publicKey) throw new Error('TELIUM_RELEASE_PUBLIC_KEY is not set')
    if (!keyId) throw new Error('TELIUM_RELEASE_KEY_ID is not set')
    assertPublicKeyMatchesSeed(seed, publicKey)

    const bytes = readFileSync(manifestPath)
    // Checked before signing so a valid key never signs the wrong kind of document:
    // this signer exists to sign SFU release lists and nothing else.
    const document = JSON.parse(bytes.toString('utf8'))
    if (document.channel !== 'releases' || !Array.isArray(document.releases)) {
      throw new Error(`${manifestPath} is not an SFU release manifest (channel "releases" with a releases array)`)
    }

    const doc = signSfuManifestBytes(bytes, seed, keyId)
    writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`)
    // An unverifiable signature would make every relay report its feed as forged.
    if (!verifySfuManifestBytes(bytes, doc, publicKey)) {
      throw new Error('the signature just produced does not verify; refusing to publish it')
    }
    console.log(`Signed ${manifestPath} -> ${outPath}`)
    console.log(doc.statement)
    return 0
  }

  if (command === 'verify') {
    const [manifestPath, sigPath, publicKey] = rest
    if (!manifestPath || !sigPath || !publicKey) {
      throw new Error('usage: verify <manifest.json> <sig.json> <public-key>')
    }
    const ok = verifySfuManifestBytes(
      readFileSync(manifestPath),
      JSON.parse(readFileSync(sigPath, 'utf8')),
      publicKey,
    )
    console.log(ok ? 'signature verifies' : 'SIGNATURE DOES NOT VERIFY')
    return ok ? 0 : 1
  }

  throw new Error(`unknown command ${command ?? '(none)'}; expected sign or verify`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main())
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
