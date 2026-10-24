// Client-release manifest signer, and the desktop updater's handling of what it produces.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { publicKeyFromSeed, statementFor } from './sign-release-manifest.mjs'
import {
  MANIFEST_KIND,
  MANIFEST_VERSION,
  STATEMENT_VERSION,
  buildManifest,
  signClientManifestBytes,
  verifyClientManifestBytes,
} from './sign-client-manifest.mjs'

const require = createRequire(import.meta.url)
const updater = require('../web/electron/updater.cjs')

/// Deterministic, so a failure reproduces from the output.
const SEED = Buffer.alloc(32, 7).toString('base64url')
const PUBLIC_KEY = publicKeyFromSeed(SEED)
const KEY_ID = 'ed25519:client-manifest:test'

/// Taken from the updater rather than hard-coded, or install tests pass vacuously off Linux.
const HERE = updater.artifactKeyFor()

const artifact = (sha, key = HERE) => [key, {
  url: 'https://downloads.example/Telium_9.9.9_x86_64.AppImage',
  sha256: sha,
  size: 1234,
}]

const bytesOf = (document) => Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8')

test('a built manifest is the shape the clients parse', () => {
  const document = buildManifest({
    version: '9.9.9',
    artifacts: [artifact('a'.repeat(64))],
    page: 'https://example.invalid/releases/9.9.9',
    generatedAt: 1_700_000_000_000,
  })
  assert.equal(document.kind, MANIFEST_KIND)
  assert.equal(document.version, MANIFEST_VERSION)
  assert.equal(document.releases.length, 1)
  assert.equal(document.releases[0].version, '9.9.9')
})

test('re-cutting a release replaces it rather than listing it twice', () => {
  const first = buildManifest({ version: '1.2.0', artifacts: [artifact('a'.repeat(64))] })
  const again = buildManifest({
    version: '1.2.0',
    artifacts: [artifact('b'.repeat(64))],
    previous: first,
  })
  assert.deepEqual(again.releases.map((r) => r.version), ['1.2.0'])
  assert.equal(again.releases[0].artifacts[HERE].sha256, 'b'.repeat(64))
})

test('a second workflow signing the same version converges on one entry for both platforms', () => {
  // Whichever platform job signs second must carry the first's artifact, not overwrite it.
  const linuxKey = 'desktop-linux-x86_64-appimage'
  const windowsKey = 'desktop-windows-x86_64'
  const signed = (key, sha) => buildManifest({
    version: '2.0.0',
    artifacts: [[key, { url: `https://downloads.example/${key}`, sha256: sha, size: 1234 }]],
  })
  const linuxFirst = signed(linuxKey, 'a'.repeat(64))
  const both = buildManifest({
    version: '2.0.0',
    artifacts: [[windowsKey, { url: 'https://downloads.example/win', sha256: 'b'.repeat(64), size: 4321 }]],
    previous: linuxFirst,
  })
  assert.deepEqual(both.releases.map((r) => r.version), ['2.0.0'])
  assert.equal(both.releases[0].artifacts[linuxKey].sha256, 'a'.repeat(64))
  assert.equal(both.releases[0].artifacts[windowsKey].sha256, 'b'.repeat(64))
  const windowsFirst = signed(windowsKey, 'b'.repeat(64))
  const bothAgain = buildManifest({
    version: '2.0.0',
    artifacts: [[linuxKey, { url: 'https://downloads.example/linux', sha256: 'a'.repeat(64), size: 1234 }]],
    previous: windowsFirst,
  })
  assert.deepEqual(Object.keys(bothAgain.releases[0].artifacts).sort(), [linuxKey, windowsKey].sort())
})

test('older releases are carried forward so a missed security fix is still visible', () => {
  let manifest = buildManifest({
    version: '1.0.0',
    artifacts: [artifact('a'.repeat(64))],
    security: true,
  })
  manifest = buildManifest({
    version: '1.0.1',
    artifacts: [artifact('c'.repeat(64))],
    previous: manifest,
  })
  assert.deepEqual(manifest.releases.map((r) => r.version), ['1.0.1', '1.0.0'])
  assert.equal(manifest.releases[1].security, true)
})

test('the statement is domain separated from the server release manifest', () => {
  const bytes = Buffer.from('anything at all')
  const client = signClientManifestBytes(bytes, SEED, KEY_ID).statement
  assert.ok(client.startsWith(`${STATEMENT_VERSION} sha256=`))
  assert.notEqual(client, statementFor(bytes))
})

test('a server manifest signature is refused as a client manifest signature', () => {
  // One key signs both documents; a signed server release list must not verify as a client manifest.
  const bytes = bytesOf(buildManifest({ version: '3.0.0', artifacts: [artifact('d'.repeat(64))] }))
  const serverStyle = {
    alg: 'ed25519',
    key_id: KEY_ID,
    statement: statementFor(bytes),
    signature: signClientManifestBytes(bytes, SEED, KEY_ID).signature,
  }
  assert.equal(verifyClientManifestBytes(bytes, serverStyle, PUBLIC_KEY), false)
  assert.equal(updater.verifyManifestSignature(bytes, serverStyle, PUBLIC_KEY), false)
})

test('the desktop main process accepts what the signer produces', () => {
  const bytes = bytesOf(buildManifest({ version: '2.0.0', artifacts: [artifact('e'.repeat(64))] }))
  const signature = signClientManifestBytes(bytes, SEED, KEY_ID)
  assert.equal(updater.verifyManifestSignature(bytes, signature, PUBLIC_KEY), true)
  assert.equal(verifyClientManifestBytes(bytes, signature, PUBLIC_KEY), true)
})

test('a signature replayed from another manifest does not verify', () => {
  const older = bytesOf(buildManifest({ version: '1.0.0', artifacts: [artifact('a'.repeat(64))] }))
  const newer = bytesOf(buildManifest({ version: '1.1.0', artifacts: [artifact('b'.repeat(64))] }))
  const signature = signClientManifestBytes(older, SEED, KEY_ID)
  // Genuinely signed but not this manifest: a replay of last month's list.
  assert.equal(updater.verifyManifestSignature(newer, signature, PUBLIC_KEY), false)
  assert.equal(verifyClientManifestBytes(newer, signature, PUBLIC_KEY), false)
})

test('a single flipped byte in the manifest invalidates the signature', () => {
  const bytes = bytesOf(buildManifest({ version: '4.0.0', artifacts: [artifact('f'.repeat(64))] }))
  const signature = signClientManifestBytes(bytes, SEED, KEY_ID)
  const tampered = Buffer.from(bytes)
  tampered[tampered.length - 2] ^= 0x01
  assert.equal(updater.verifyManifestSignature(tampered, signature, PUBLIC_KEY), false)
})

test('a different key does not verify', () => {
  const bytes = bytesOf(buildManifest({ version: '5.0.0', artifacts: [artifact('0'.repeat(64))] }))
  const signature = signClientManifestBytes(bytes, SEED, KEY_ID)
  const other = publicKeyFromSeed(Buffer.alloc(32, 9).toString('base64url'))
  assert.equal(updater.verifyManifestSignature(bytes, signature, other), false)
})


test('with no publisher key the desktop updater never reaches the network', async () => {
  // With no key nothing is fetched at all, not fetched then refused.
  let calls = 0
  const fetchImpl = async () => { calls += 1; throw new Error('should never be called') }

  for (const publisher of [
    { url: '', publicKey: '' },
    { url: 'https://downloads.example/clients.json', publicKey: '' },
    { url: '', publicKey: PUBLIC_KEY },
    null,
  ]) {
    const result = await updater.checkForUpdate({
      publisher,
      currentVersion: '0.0.1',
      fetchImpl,
    })
    assert.equal(result.fault, updater.Fault.NoKey)
    assert.equal(result.release, undefined)
  }
  assert.equal(calls, 0)
})

test('an unkeyed update service refuses to install and says why', async () => {
  let calls = 0
  const service = updater.createUpdateService({
    publisher: { url: 'https://downloads.example/clients.json', publicKey: '' },
    currentVersion: '0.0.1',
    appImagePath: '/nonexistent/Telium.AppImage',
    fetchImpl: async () => { calls += 1; throw new Error('should never be called') },
  })
  const state = await service.install()
  assert.equal(state.phase, updater.Phase.Failed)
  assert.equal(state.fault, updater.Fault.NoKey)
  assert.equal(service.stagedPath(), '')
  assert.equal(calls, 0)
})

test('a forged manifest is refused before it is parsed, and nothing is staged', async () => {
  const document = buildManifest({
    version: '99.0.0',
    artifacts: [artifact('1'.repeat(64))],
  })
  const bytes = bytesOf(document)
  // Valid manifest signed by someone else's key.
  const wrongSeed = Buffer.alloc(32, 3).toString('base64url')
  const signature = signClientManifestBytes(bytes, wrongSeed, KEY_ID)

  const service = updater.createUpdateService({
    publisher: { url: 'https://downloads.example/clients.json', publicKey: PUBLIC_KEY },
    currentVersion: '0.0.1',
    appImagePath: '/nonexistent/Telium.AppImage',
    fetchImpl: async (url) => (url.endsWith('.sig')
      ? { ok: true, text: async () => JSON.stringify(signature) }
      : { ok: true, arrayBuffer: async () => bytes }),
  })
  const state = await service.install()
  assert.equal(state.phase, updater.Phase.Failed)
  assert.equal(state.fault, updater.Fault.Forged)
  assert.equal(service.stagedPath(), '')
})

test('an artifact whose digest does not match is not staged', async () => {
  const document = buildManifest({
    version: '99.0.0',
    // Genuine signed manifest; the mirror serves different bytes.
    artifacts: [artifact('9'.repeat(64))],
  })
  const bytes = bytesOf(document)
  const signature = signClientManifestBytes(bytes, SEED, KEY_ID)
  const directory = mkdtempSync(join(tmpdir(), 'cliupd-'))
  const target = join(directory, 'Telium.AppImage')
  writeFileSync(target, 'the build that is already installed')

  const service = updater.createUpdateService({
    publisher: { url: 'https://downloads.example/clients.json', publicKey: PUBLIC_KEY },
    currentVersion: '0.0.1',
    appImagePath: target,
    downloadDirectory: join(directory, 'download'),
    fetchImpl: async (url) => {
      if (url.endsWith('.sig')) return { ok: true, text: async () => JSON.stringify(signature) }
      if (url.endsWith('.json')) return { ok: true, arrayBuffer: async () => bytes }
      return {
        ok: true,
        body: (async function* body() { yield Buffer.from('not the promised bytes') }()),
      }
    },
  })
  const state = await service.install()
  assert.equal(state.phase, updater.Phase.Failed)
  assert.equal(state.fault, updater.Fault.Corrupt)
  assert.equal(service.stagedPath(), '')
  // The installed build stays untouched.
  assert.equal(require('node:fs').readFileSync(target, 'utf8'), 'the build that is already installed')
})

test('a verified artifact replaces the running AppImage atomically', async () => {
  const payload = Buffer.from('#!/bin/sh\nthe new build\n')
  const digest = require('node:crypto').createHash('sha256').update(payload).digest('hex')
  const document = buildManifest({ version: '99.0.0', artifacts: [artifact(digest)] })
  const bytes = bytesOf(document)
  const signature = signClientManifestBytes(bytes, SEED, KEY_ID)
  const directory = mkdtempSync(join(tmpdir(), 'cliupd-'))
  const target = join(directory, 'Telium.AppImage')
  writeFileSync(target, 'the old build')

  const phases = []
  const service = updater.createUpdateService({
    publisher: { url: 'https://downloads.example/clients.json', publicKey: PUBLIC_KEY },
    currentVersion: '1.0.0',
    appImagePath: target,
    downloadDirectory: join(directory, 'download'),
    onChange: (state) => phases.push(state.phase),
    fetchImpl: async (url) => {
      if (url.endsWith('.sig')) return { ok: true, text: async () => JSON.stringify(signature) }
      if (url.endsWith('.json')) return { ok: true, arrayBuffer: async () => bytes }
      return { ok: true, body: (async function* body() { yield payload }()) }
    },
  })
  const state = await service.install()
  assert.equal(state.fault, '')
  assert.equal(state.phase, updater.Phase.Ready)
  assert.equal(require('node:fs').readFileSync(target, 'utf8'), payload.toString('utf8'))
  assert.deepEqual(phases, ['checking', 'downloading', 'verifying', 'ready'])
  // Once staged, the only verb is restart; a second check would report "up to date".
  assert.equal((await service.check()).phase, updater.Phase.Ready)
})
