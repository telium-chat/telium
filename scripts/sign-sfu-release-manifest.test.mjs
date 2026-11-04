// The SFU manifest signer: right statement prefix, refuses the wrong document, self-verifies.

import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createHash } from 'node:crypto'

import { STATEMENT_VERSION, signSfuManifestBytes, verifySfuManifestBytes } from './sign-sfu-release-manifest.mjs'
import { signBytesWith } from './sign-release-manifest.mjs'

// A throwaway key: the CI key never appears in a test. The signer takes the
// seed; the public key the tests verify against is the matching half of the
// same generated pair.
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const SEED = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64url')
const PUBLIC = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
const KEY_ID = 'ed25519:release-manifest:test'

const MANIFEST = JSON.stringify({
  channel: 'releases',
  generated_at: 1_700_000_000_000,
  releases: [{ version: '0.2.0', commit: 'a'.repeat(40), released_at: 1_700_000_000_000, security: false }],
}) + '\n'

test('the statement carries the SFU prefix, so no other component verifies it', () => {
  assert.equal(STATEMENT_VERSION, 'telium-sfu-release-manifest-v1')
  const doc = signSfuManifestBytes(Buffer.from(MANIFEST), SEED, KEY_ID)
  const digest = createHash('sha256').update(Buffer.from(MANIFEST)).digest('hex')
  assert.equal(doc.statement, `telium-sfu-release-manifest-v1 sha256=${digest}`)

  // The SFU's own verifier in Rust checks exactly this string, byte for byte.
  assert.equal(verifySfuManifestBytes(Buffer.from(MANIFEST), doc, PUBLIC), true)
  assert.equal(
    verifySfuManifestBytes(Buffer.from(MANIFEST + ' '), doc, PUBLIC),
    false,
    'altered bytes must not verify',
  )

  // A server manifest signed with the same key verifies under the server's
  // prefix and NOT under the SFU's: the domain separation is the point.
  const serverDoc = signBytesWith('telium-release-manifest-v1', Buffer.from(MANIFEST), SEED, KEY_ID)
  assert.equal(verifySfuManifestBytes(Buffer.from(MANIFEST), serverDoc, PUBLIC), false)
})

test('a replayed statement is refused before any key check', () => {
  const doc = signSfuManifestBytes(Buffer.from(MANIFEST), SEED, KEY_ID)
  const stale = { ...doc, statement: doc.statement.replace(/sha256=[0-9a-f]/, 'sha256=0') }
  assert.equal(verifySfuManifestBytes(Buffer.from(MANIFEST), stale, PUBLIC), false)
})

test('a wrong key refuses the signature', () => {
  const doc = signSfuManifestBytes(Buffer.from(MANIFEST), SEED, KEY_ID)
  const other = generateKeyPairSync('ed25519')
  const otherPub = other.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
  assert.equal(verifySfuManifestBytes(Buffer.from(MANIFEST), doc, otherPub), false)
})
