#!/usr/bin/env node

// Generates the SFU directory signing key: a 32-byte Ed25519 seed plus its
// public pin. The seed is the secret (TELIUM_SFU_DIRECTORY_SIGNING_KEY); the
// public key and key id are the non-secret halves a server pins and a build
// embeds.

import { randomBytes } from 'node:crypto'
import { publicKeyFromSeed } from './sfu-directory-lib.mjs'

const seed = randomBytes(32).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const publicKey = publicKeyFromSeed(seed)
const keyId = `ed25519:sfu-directory:${publicKey.slice(0, 10)}`

console.log(`TELIUM_SFU_DIRECTORY_SIGNING_KEY=${seed}`)
console.log(`TELIUM_SFU_DIRECTORY_PUBLIC_KEY=${publicKey}`)
console.log(`TELIUM_SFU_DIRECTORY_KEY_ID=${keyId}`)
