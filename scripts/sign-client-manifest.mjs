#!/usr/bin/env node
// Builds and signs the client release manifest, the document that can make a client replace its own executable.
// Artifact digests are computed here, never passed in: a typed digest would sign a claim about a file never read.

import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import {
  assertPublicKeyMatchesSeed,
  signBytesWith,
  verifyBytesWith,
} from './sign-release-manifest.mjs'

/// Must match `STATEMENT_VERSION` in `web/src/lib/updates.js` and `web/electron/updater.cjs`.
export const STATEMENT_VERSION = 'telium-client-manifest-v1'
export const MANIFEST_KIND = 'telium.client_releases'
export const MANIFEST_VERSION = 1

/// Enough that a client several releases behind can see whether any missed one was security-relevant.
const KEEP_RELEASES = 8

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/// Split from the right twice: a URL can contain `=`.
const parseArtifact = (raw) => {
  const first = raw.indexOf('=')
  const last = raw.indexOf('=', first + 1)
  if (first < 1 || last < 0) {
    throw new Error(`--artifact wants key=path=url, got ${raw}`)
  }
  const key = raw.slice(0, first)
  const path = raw.slice(first + 1, last)
  const url = raw.slice(last + 1)
  if (!/^https:\/\//i.test(url)) {
    // Failing here turns a silently empty release into a fixable build failure.
    throw new Error(`artifact ${key} must be served over https, got ${url}`)
  }
  const bytes = readFileSync(path)
  return [key, { url, sha256: sha256(bytes), size: statSync(path).size }]
}

const flag = (argv, name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : ''
}

const flags = (argv, name) => argv
  .map((value, index) => (value === name ? argv[index + 1] : null))
  .filter((value) => value !== null)

export const buildManifest = ({
  version,
  artifacts,
  security = false,
  page = '',
  summary = '',
  minSupported = '',
  previous = null,
  generatedAt = Date.now(),
}) => {
  if (!version) throw new Error('a version is required')
  // Both platform jobs run from one tag and hash only their own artifact, so this run overlays the previous entries for the same version.
  const priorSame = (previous?.releases ?? [])
    .find((release) => release && release.version === version)
  const carried = Object.entries(priorSame?.artifacts ?? {})
    .filter(([key]) => !artifacts.some(([published]) => published === key))
  const entry = {
    version,
    released_at: generatedAt,
    security: Boolean(security),
    ...(summary ? { summary } : {}),
    ...(minSupported ? { min_supported: minSupported } : {}),
    ...(page ? { page } : {}),
    artifacts: { ...Object.fromEntries(carried), ...Object.fromEntries(artifacts) },
  }
  // Older releases are carried forward; their artifacts cannot be re-hashed.
  const older = (previous?.releases ?? [])
    .filter((release) => release && release.version && release.version !== version)
  return {
    kind: MANIFEST_KIND,
    version: MANIFEST_VERSION,
    channel: 'stable',
    generated_at: generatedAt,
    releases: [entry, ...older].slice(0, KEEP_RELEASES),
  }
}

export const signClientManifestBytes = (bytes, seedText, keyId) =>
  signBytesWith(STATEMENT_VERSION, bytes, seedText, keyId)

export const verifyClientManifestBytes = (bytes, sigDocument, publicKeyText) =>
  verifyBytesWith(STATEMENT_VERSION, bytes, sigDocument, publicKeyText)


const main = () => {
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv

  if (command === 'build') {
    const out = flag(rest, '--out')
    if (!out) throw new Error('usage: build --out <manifest.json> --version <v> --artifact ...')
    const artifacts = flags(rest, '--artifact').map(parseArtifact)
    if (!artifacts.length) throw new Error('a release with no artifacts would offer nothing')
    const previousPath = flag(rest, '--previous')
    let previous = null
    if (previousPath) {
      try {
        previous = JSON.parse(readFileSync(previousPath, 'utf8'))
      } catch {
        // Losing history beats failing the release.
        console.error(`Could not read ${previousPath}; publishing a manifest with one release.`)
      }
    }
    const document = buildManifest({
      version: flag(rest, '--version'),
      artifacts,
      security: rest.includes('--security'),
      page: flag(rest, '--page'),
      summary: flag(rest, '--summary'),
      minSupported: flag(rest, '--min-supported'),
      previous,
    })
    writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`)
    console.log(`Wrote ${out} with ${document.releases.length} release(s).`)
    for (const [key, artifact] of artifacts) console.log(`  ${key} sha256=${artifact.sha256}`)
    return 0
  }

  if (command === 'sign') {
    const manifestPath = rest[0]
    if (!manifestPath) throw new Error('usage: sign <manifest.json> [--out <file>]')
    const outPath = flag(rest, '--out') || `${manifestPath}.sig`

    const seed = process.env.TELIUM_RELEASE_SIGNING_KEY
    const publicKey = process.env.TELIUM_RELEASE_PUBLIC_KEY
    const keyId = process.env.TELIUM_RELEASE_KEY_ID
    if (!seed) throw new Error('TELIUM_RELEASE_SIGNING_KEY is not set')
    if (!publicKey) throw new Error('TELIUM_RELEASE_PUBLIC_KEY is not set')
    if (!keyId) throw new Error('TELIUM_RELEASE_KEY_ID is not set')
    assertPublicKeyMatchesSeed(seed, publicKey)

    const bytes = readFileSync(manifestPath)
    // Checked before signing so a valid key never signs the wrong kind of document.
    const document = JSON.parse(bytes.toString('utf8'))
    if (document.kind !== MANIFEST_KIND || document.version !== MANIFEST_VERSION) {
      throw new Error(`${manifestPath} is not a ${MANIFEST_KIND} v${MANIFEST_VERSION} document`)
    }

    const doc = signClientManifestBytes(bytes, seed, keyId)
    writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`)
    // An unverifiable signature would make every client report `forged`.
    if (!verifyClientManifestBytes(bytes, doc, publicKey)) {
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
    const ok = verifyClientManifestBytes(
      readFileSync(manifestPath),
      JSON.parse(readFileSync(sigPath, 'utf8')),
      publicKey,
    )
    console.log(ok ? 'signature verifies' : 'SIGNATURE DOES NOT VERIFY')
    return ok ? 0 : 1
  }

  throw new Error(`unknown command ${command ?? '(none)'}; expected build, sign or verify`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main())
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
