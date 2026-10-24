#!/usr/bin/env node
// Signs `deploy/releases.json` with a key that is not in the repository, so edits to the raw file are detectable.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
} from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

// Versioned in its first token so an old verifier rejects a changed scheme.
export const STATEMENT_VERSION = 'telium-release-manifest-v1'

// Distinct statement prefix per document prevents cross-protocol confusion; the server verifies these byte for byte.
export const statementWith = (version, bytes) =>
  `${version} sha256=${createHash('sha256').update(bytes).digest('hex')}`

export const statementFor = (bytes) => statementWith(STATEMENT_VERSION, bytes)

// Duplicated from `site/scripts/recommendations-lib.mjs` to keep the release pipeline off the Astro site's package.
const PKCS8_ED25519_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const fromUrlB64 = (text) => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error('key material must be URL-safe base64 without padding')
  }
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

const toUrlB64 = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

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
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

export const publicKeyFromSeed = (seedText) => {
  const der = createPublicKey(privateKeyFromSeed(seedText)).export({ format: 'der', type: 'spki' })
  return toUrlB64(der.subarray(der.length - 32))
}

// Stops a half-rotated key from publishing a manifest nobody can verify.
export const assertPublicKeyMatchesSeed = (seedText, publicKeyText) => {
  const configured = fromUrlB64(publicKeyText)
  if (configured.length !== 32) throw new Error(`public key must decode to 32 bytes, got ${configured.length}`)
  const derived = fromUrlB64(publicKeyFromSeed(seedText))
  if (!timingSafeEqual(configured, derived)) {
    throw new Error(
      'TELIUM_RELEASE_PUBLIC_KEY does not match TELIUM_RELEASE_SIGNING_KEY. ' +
        'The secret and the variable have drifted apart; a manifest signed now would verify nowhere.',
    )
  }
  return toUrlB64(derived)
}

export const signBytesWith = (version, bytes, seedText, keyId) => {
  if (!keyId || typeof keyId !== 'string') throw new Error('a non-empty key id is required')
  const statement = statementWith(version, bytes)
  return {
    alg: 'ed25519',
    key_id: keyId,
    statement,
    signature: toUrlB64(edSign(null, Buffer.from(statement, 'utf8'), privateKeyFromSeed(seedText))),
  }
}

export const signManifestBytes = (bytes, seedText, keyId) =>
  signBytesWith(STATEMENT_VERSION, bytes, seedText, keyId)

export const verifyBytesWith = (version, bytes, sigDocument, publicKeyText) => {
  if (!sigDocument || typeof sigDocument !== 'object') return false
  if (sigDocument.alg !== 'ed25519') return false
  const expected = statementWith(version, bytes)
  // Compared first: otherwise a replayed, genuinely signed older manifest would be accepted.
  if (sigDocument.statement !== expected) return false
  try {
    return edVerify(
      null,
      Buffer.from(expected, 'utf8'),
      publicKeyFromRaw(publicKeyText),
      fromUrlB64(sigDocument.signature),
    )
  } catch {
    return false
  }
}

export const verifyManifestBytes = (bytes, sigDocument, publicKeyText) =>
  verifyBytesWith(STATEMENT_VERSION, bytes, sigDocument, publicKeyText)


const main = () => {
  const [command, ...rest] = process.argv.slice(2)

  if (command === 'keygen') {
    const seed = toUrlB64(randomBytes(32))
    const publicKey = publicKeyFromSeed(seed)
    // stderr, so `keygen > key.env` captures only the assignments.
    console.error('Generated a Telium release-manifest signing key.')
    console.error('')
    console.error('  TELIUM_RELEASE_SIGNING_KEY -> repository SECRET. It never leaves 1Password')
    console.error('     and the Actions secret store. Anyone holding it can sign a release list')
    console.error('     that every homeserver in the world will believe.')
    console.error('  TELIUM_RELEASE_PUBLIC_KEY / TELIUM_RELEASE_KEY_ID -> repository VARIABLES.')
    console.error('     Not secret. Publishing them is what makes the signature checkable.')
    console.error('')
    console.error('Set RELEASE_SIGNING_ENABLED=true only once all three exist; see docs/supply-chain.md.')
    console.log(`TELIUM_RELEASE_SIGNING_KEY=${seed}`)
    console.log(`TELIUM_RELEASE_PUBLIC_KEY=${publicKey}`)
    console.log(`TELIUM_RELEASE_KEY_ID=ed25519:release-manifest:${publicKey.slice(0, 10)}`)
    return 0
  }

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
    const doc = signManifestBytes(bytes, seed, keyId)
    writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n')

    // An unverifiable signature with exit 0 would publish a file that looks like a guarantee.
    if (!verifyManifestBytes(bytes, doc, publicKey)) {
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
    const ok = verifyManifestBytes(
      readFileSync(manifestPath),
      JSON.parse(readFileSync(sigPath, 'utf8')),
      publicKey,
    )
    console.log(ok ? 'signature verifies' : 'SIGNATURE DOES NOT VERIFY')
    return ok ? 0 : 1
  }

  throw new Error(`unknown command ${command ?? '(none)'}; expected keygen, sign or verify`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main())
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
