// Release-manifest signing: the cases where a signature verifies when it should not.

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import {
  assertPublicKeyMatchesSeed,
  publicKeyFromSeed,
  signManifestBytes,
  statementFor,
  verifyManifestBytes,
} from './sign-release-manifest.mjs'

const toUrlB64 = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

const seed = toUrlB64(randomBytes(32))
const publicKey = publicKeyFromSeed(seed)
const KEY_ID = 'ed25519:release-manifest:test'

const manifest = Buffer.from(JSON.stringify({ channel: 'main', releases: [] }, null, 2) + '\n')

test('a freshly signed manifest verifies', () => {
  const doc = signManifestBytes(manifest, seed, KEY_ID)
  assert.equal(verifyManifestBytes(manifest, doc, publicKey), true)
})

test('a single changed byte in the manifest invalidates the signature', () => {
  const doc = signManifestBytes(manifest, seed, KEY_ID)
  const tampered = Buffer.concat([manifest, Buffer.from(' ')])
  assert.equal(verifyManifestBytes(tampered, doc, publicKey), false)
})

test('a signature from a different key does not verify', () => {
  const other = toUrlB64(randomBytes(32))
  const doc = signManifestBytes(manifest, other, KEY_ID)
  assert.equal(verifyManifestBytes(manifest, doc, publicKey), false)
})

test('a genuine signature over a different manifest is not accepted for this one', () => {
  // Replay: both halves are authentic; only the statement-vs-bytes check stops it.
  const older = Buffer.from('{"channel":"main","releases":[{"commit":"old"}]}\n')
  const doc = signManifestBytes(older, seed, KEY_ID)
  assert.equal(verifyManifestBytes(older, doc, publicKey), true)
  assert.equal(verifyManifestBytes(manifest, doc, publicKey), false)
})

test('rewriting the statement to match the manifest does not rescue a signature', () => {
  const older = Buffer.from('{"channel":"main","releases":[{"commit":"old"}]}\n')
  const doc = signManifestBytes(older, seed, KEY_ID)
  doc.statement = statementFor(manifest)
  assert.equal(verifyManifestBytes(manifest, doc, publicKey), false)
})

test('an unknown algorithm is refused rather than ignored', () => {
  // A verifier that skips unknown fields can be downgraded by naming an unknown algorithm.
  const doc = signManifestBytes(manifest, seed, KEY_ID)
  assert.equal(verifyManifestBytes(manifest, { ...doc, alg: 'none' }, publicKey), false)
})

test('a malformed or absent signature is false, not a thrown exception', () => {
  // Runs in a periodic homeserver check; an exception there is an outage, worse than "could not verify".
  for (const doc of [null, {}, { alg: 'ed25519' }, { alg: 'ed25519', statement: statementFor(manifest), signature: '!!!' }]) {
    assert.equal(verifyManifestBytes(manifest, doc, publicKey), false)
  }
})

test('a public key that does not match the seed is caught before anything is signed', () => {
  const other = publicKeyFromSeed(toUrlB64(randomBytes(32)))
  assert.throws(() => assertPublicKeyMatchesSeed(seed, other), /drifted apart/)
  assert.equal(assertPublicKeyMatchesSeed(seed, publicKey), publicKey)
})

test('the statement is ASCII and carries the scheme version', () => {
  // The Rust verifier assumes both.
  const statement = statementFor(manifest)
  assert.match(statement, /^telium-release-manifest-v1 sha256=[0-9a-f]{64}$/)
  assert.equal(Buffer.from(statement, 'utf8').length, statement.length)
})
