// Pure decisions of the SFU release train.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  compareVersions,
  LATEST_TAG,
  movesLatest,
  newestTag,
  parseTag,
  TAG_PREFIX,
} from './release-sfu.mjs'
// The component-neutral decisions are imported, not copied: the day the two
// trains disagree about what a manifest entry is, one of them is lying.
import { manifestEntry, parseTrailers, rewriteManifest } from './release-server.mjs'

test('only sfu-v major.minor.patch is a release tag', () => {
  assert.equal(TAG_PREFIX, 'sfu-v')
  assert.equal(parseTag('sfu-v0.2.0').version, '0.2.0')
  assert.deepEqual(parseTag('sfu-v10.20.30'), { major: 10, minor: 20, patch: 30, version: '10.20.30' })
  for (const bad of [
    'sfu-v0.2',
    'sfu-v0.2.0.1',
    'sfu-v0.2.0-rc1',
    'sfu-0.2.0',
    'v0.2.0',
    'server-v0.2.0',
    'desktop-v0.2.0',
    'sfu-v',
    'sfu-v0.2.x',
    'sfu-v999999999.0.0',
    '',
  ]) {
    assert.equal(parseTag(bad), null, `${bad || '<empty>'} must not parse`)
  }
})

test('versions compare numerically, not lexicographically', () => {
  const v = (s) => parseTag(`sfu-v${s}`)
  assert.ok(compareVersions(v('0.10.0'), v('0.9.0')) > 0, '0.10.0 is newer than 0.9.0')
  assert.ok(compareVersions(v('1.0.0'), v('0.99.99')) > 0)
  assert.equal(compareVersions(v('1.2.3'), v('1.2.3')), 0)
})

test('the newest tag is the highest version, ignoring what does not parse', () => {
  assert.equal(newestTag([]), null)
  assert.equal(newestTag(['sfu-v0.9.0', 'sfu-v0.10.0', 'sfu-v0.2.0']), 'sfu-v0.10.0')
  assert.equal(newestTag(['sfu-v0.9.0', 'sfu-v-broken', 'sfu-v0.1.0']), 'sfu-v0.9.0')
  assert.equal(newestTag(['server-v9.0.0', 'desktop-v9.0.0']), null)
})

test('only the highest version moves sfu-latest', () => {
  const tags = ['sfu-v0.2.0', 'sfu-v0.1.0']
  assert.equal(LATEST_TAG, 'sfu-latest')
  assert.equal(movesLatest('sfu-v0.2.0', tags), true)
  assert.equal(movesLatest('sfu-v0.1.0', tags), false)
  assert.equal(movesLatest('sfu-v0.3.0', tags), false)
  assert.equal(movesLatest('sfu-v0.3.0', [...tags, 'sfu-v0.3.0']), true)
})

test('an SFU manifest entry carries the sfu artifact keys and the release words', () => {
  const entry = manifestEntry({
    version: '0.2.0',
    commit: 'a'.repeat(40),
    releasedAt: 1_700_000_000_000,
    summary: 'relay release',
    image: 'sha256:abc',
    trailers: parseTrailers('Breaking-change: yes\nUpgrade-notes: drain first'),
    protocol: 3,
    minProtocol: 2,
    artifacts: {
      'sfu-linux-x86_64': { url: 'https://example/telium-sfu-linux-x86_64.tar.gz', sha256: 'a'.repeat(64), size: 10 },
    },
  })
  assert.equal(entry.version, '0.2.0')
  assert.equal(entry.breaking, true)
  assert.equal(entry.notes, 'drain first')
  assert.equal(entry.protocol, 3)
  assert.equal(entry.min_protocol, 2)
  assert.deepEqual(Object.keys(entry.artifacts), ['sfu-linux-x86_64'])
})

test('recording a release rewrites deploy/sfu-releases.json in place, keyed on the commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfu-release-test-'))
  try {
    const manifestPath = join(dir, 'sfu-releases.json')
    writeFileSync(manifestPath, JSON.stringify({
      channel: 'releases',
      generated_at: 1,
      releases: [{
        version: '0.1.0',
        commit: 'b'.repeat(40),
        released_at: 1_600_000_000_000,
        security: false,
        summary: 'seed',
        artifacts: {},
      }],
    }, null, 2) + '\n')

    const out = execFileSync(process.execPath, [
      'scripts/release-sfu.mjs', 'record',
      '--tag', 'sfu-v0.2.0',
      '--commit', 'a'.repeat(40),
      '--released-at', '1700000000',
      '--summary', 'newest relay',
      '--image', 'sha256:abc',
      '--trailers', 'Upgrade-notes: none needed',
      '--artifact-x86_64-url', 'https://example/telium-sfu-linux-x86_64.tar.gz',
      '--artifact-x86_64-sha256', 'a'.repeat(64),
      '--artifact-x86_64-size', '1024',
      '--manifest', manifestPath,
    ], { encoding: 'utf8' })
    assert.match(out, /recorded=0\.2\.0/)

    const next = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(next.channel, 'releases')
    assert.equal(next.releases.length, 2)
    assert.equal(next.releases[0].commit, 'a'.repeat(40), 'newest first')
    assert.deepEqual(Object.keys(next.releases[0].artifacts), ['sfu-linux-x86_64'])
    assert.equal(next.releases[1].commit, 'b'.repeat(40), 'the seed release is carried forward')

    // A re-record with the same content is a no-op.
    execFileSync(process.execPath, [
      'scripts/release-sfu.mjs', 'record',
      '--tag', 'sfu-v0.2.0',
      '--commit', 'a'.repeat(40),
      '--released-at', '1700000000',
      '--summary', 'newest relay',
      '--image', 'sha256:abc',
      '--trailers', 'Upgrade-notes: none needed',
      '--artifact-x86_64-url', 'https://example/telium-sfu-linux-x86_64.tar.gz',
      '--artifact-x86_64-sha256', 'a'.repeat(64),
      '--artifact-x86_64-size', '1024',
      '--manifest', manifestPath,
    ], { encoding: 'utf8' })
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).generated_at, next.generated_at)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the repository manifest this script writes is the shape the relay reads', () => {
  // The seed lives at deploy/sfu-releases.json; whatever is committed must stay
  // a channel="releases" document with a releases array, which is what both
  // rewriteManifest here and parse_manifest in the relay require.
  const manifest = JSON.parse(readFileSync(new URL('../deploy/sfu-releases.json', import.meta.url), 'utf8'))
  assert.equal(manifest.channel, 'releases')
  assert.ok(Array.isArray(manifest.releases))
  assert.ok(manifest.releases.length >= 1)
  for (const release of manifest.releases) {
    assert.match(release.commit, /^[0-9a-f]{40}$/, 'every entry is keyed on a full commit')
  }
  const sorted = [...manifest.releases].sort((a, b) => b.released_at - a.released_at)
  assert.deepEqual(manifest.releases, sorted, 'newest first')
})
