#!/usr/bin/env node

// Generates the SFU directory signing key: a 32-byte Ed25519 seed plus its
// public pin. Run it again only when rotating; the same seed always yields
// the same public key.

import { randomBytes } from 'node:crypto'
import { sfuPublicKeyFromSeed } from './sfu-directory-lib.mjs'

const seed = randomBytes(32).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const publicKey = sfuPublicKeyFromSeed(seed)
const keyId = `ed25519:sfu-directory:${publicKey.slice(0, 10)}`

console.log(`Generated a signing key for the public SFU directory.

The three values:

  TELIUM_SFU_DIRECTORY_SIGNING_KEY
      ${seed}
      SECRET. This seed is what signs the feed; anyone holding it can publish
      a directory every server trusts. It belongs in telium-chat/telium-keys
      (as sfu-directory.env) and as a GitHub Actions *secret* on
      telium-chat/telium. Never commit it to telium-chat/telium itself.

  TELIUM_SFU_DIRECTORY_PUBLIC_KEY
      ${publicKey}
      Public. This is the pin every Telium server verifies the feed against,
      and it is not a secret: it goes into the server's config.rs
      (DEFAULT_SFU_DIRECTORY_PUBLIC_KEY) and a GitHub Actions *variable*.

  TELIUM_SFU_DIRECTORY_KEY_ID
      ${keyId}
      Public. A label for the key above, shown when a signature does not
      verify.

Where each one goes:

  1. telium-chat/telium-keys — add sfu-directory.env containing the three
     NAME=value lines, and a row for it in that repo's README table.
  2. GitHub Actions settings on telium-chat/telium (or via the CLI):

       gh secret set -R telium-chat/telium TELIUM_SFU_DIRECTORY_SIGNING_KEY
       gh variable set -R telium-chat/telium TELIUM_SFU_DIRECTORY_PUBLIC_KEY
       gh variable set -R telium-chat/telium TELIUM_SFU_DIRECTORY_KEY_ID
       gh variable set -R telium-chat/telium SFU_DIRECTORY_ENABLED=true

     SFU_DIRECTORY_ENABLED is the publish switch: until it is true the feed
     is simply never written, and servers stay silent rather than trusting
     anything.

  3. telium-chat/telium — paste the public key as DEFAULT_SFU_DIRECTORY_PUBLIC_KEY
     in server/src/config.rs. This is the moment the directory turns on for
     every server at once: an operator can still switch it off with
     [voice.directory] enabled = false, or pin a key of their own.

  4. Optional, for launch: the feed's eligibility gates can start lenient and
     tighten later -- see site/README.md, "SFU directory feed", for the env
     variables. They travel inside the signed document, so subscribers can
     always see which rules produced the list.
`)
