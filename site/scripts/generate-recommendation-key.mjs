#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { publicKeyFromSeed } from './recommendations-lib.mjs'

const base64url = (bytes) => Buffer.from(bytes)
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')

const seed = base64url(randomBytes(32))
const publicKey = publicKeyFromSeed(seed)
const keyId = `ed25519:account-home-recommendations:${publicKey.slice(0, 10)}`

console.error('Generated a new Telium account-home recommendation signing key.')
console.error('Store the SIGNING_KEY as a GitHub Actions secret or equivalent; never commit it.')
console.error('The PUBLIC_KEY and KEY_ID are non-secret build/deploy variables.')
console.log(`TELIUM_RECOMMENDATION_SIGNING_KEY=${seed}`)
console.log(`TELIUM_RECOMMENDATION_PUBLIC_KEY=${publicKey}`)
console.log(`TELIUM_RECOMMENDATION_KEY_ID=${keyId}`)
