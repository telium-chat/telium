// Pure decisions of the release train.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyRollback,
  compareVersions,
  manifestEntry,
  movesLatest,
  newestTag,
  parseTag,
  parseTrailers,
  rewriteManifest,
  TAG_PREFIX,
} from './release-server.mjs'

test('only server-v major.minor.patch is a release tag', () => {
  assert.equal(TAG_PREFIX, 'server-v')
  assert.equal(parseTag('server-v0.2.0').version, '0.2.0')
  assert.deepEqual(parseTag('server-v10.20.30'), { major: 10, minor: 20, patch: 30, version: '10.20.30' })
  for (const bad of [
    'server-v0.2',
    'server-v0.2.0.1',
    'server-v0.2.0-rc1',
    'server-0.2.0',
    'v0.2.0',
    'desktop-v0.2.0',
    'android-v0.2.0',
    'server-v',
    'server-v0.2.x',
    'server-v999999999.0.0',
    '',
  ]) {
    assert.equal(parseTag(bad), null, `${bad || '<empty>'} must not parse`)
  }
})

test('versions compare numerically, not lexicographically', () => {
  const v = (s) => parseTag(`server-v${s}`)
  assert.ok(compareVersions(v('0.10.0'), v('0.9.0')) > 0, '0.10.0 is newer than 0.9.0')
  assert.ok(compareVersions(v('1.0.0'), v('0.99.99')) > 0)
  assert.equal(compareVersions(v('1.2.3'), v('1.2.3')), 0)
})

test('the newest tag is the highest version, ignoring what does not parse', () => {
  assert.equal(newestTag([]), null)
  assert.equal(newestTag(['server-v0.9.0', 'server-v0.10.0', 'server-v0.2.0']), 'server-v0.10.0')
  assert.equal(newestTag(['server-v0.9.0', 'server-v-broken', 'server-v0.1.0']), 'server-v0.9.0')
  assert.equal(newestTag(['desktop-v9.0.0', 'android-v9.0.0']), null)
})

test('only the highest version moves server-latest', () => {
  const tags = ['server-v0.2.0', 'server-v0.1.0']
  assert.equal(movesLatest('server-v0.2.0', tags), true)
  assert.equal(movesLatest('server-v0.1.0', tags), false)
  assert.equal(movesLatest('server-v0.3.0', tags), false)
  assert.equal(movesLatest('server-v0.3.0', [...tags, 'server-v0.3.0']), true)
})

test('release trailers are read from the tag message, and only a yes is a yes', () => {
  const body = [
    'Telium Server 0.2.0',
    '',
    'Security-relevant: yes',
    'Upgrade-notes: reindex media on first start',
  ].join('\n')
  assert.deepEqual(parseTrailers(body), {
    security: true,
    breaking: false,
    notes: 'reindex media on first start',
  })
  assert.equal(parseTrailers('Breaking-change: true').breaking, true)
  assert.equal(parseTrailers('Breaking-change: maybe').breaking, false)
  assert.equal(parseTrailers('Security-relevant:no').security, false)
  assert.equal(parseTrailers('').notes, '')
  assert.equal(parseTrailers(`Upgrade-notes: ${'x'.repeat(900)}`).notes.length, 400)
})

test('rollback is refused exactly when the database moved forward', () => {
  assert.equal(classifyRollback({ migrationsAdded: false, stateFormatChanged: false }).rollbackable, true)
  assert.equal(classifyRollback({ migrationsAdded: true, stateFormatChanged: false }).rollbackable, false)
  assert.equal(classifyRollback({ migrationsAdded: false, stateFormatChanged: true }).rollbackable, false)
  assert.match(classifyRollback({ migrationsAdded: true, stateFormatChanged: false }).reason, /migration/)
  assert.match(classifyRollback({ migrationsAdded: false, stateFormatChanged: true }).reason, /STATE_FORMAT_VERSION/)
})

test('a manifest entry names its version and keeps the commit as the identity', () => {
  const commit = 'a'.repeat(40)
  const entry = manifestEntry({
    version: '0.2.0',
    commit,
    releasedAt: 1_700_000_000_000,
    summary: 'the release',
    image: 'sha256:abc',
    trailers: { security: false, breaking: false, notes: '' },
    protocol: 1,
    minProtocol: 1,
    artifacts: {
      'server-linux-x86_64': { url: 'https://example.invalid/x.tar.gz', sha256: 'b'.repeat(64), size: 10 },
    },
  })
  assert.equal(entry.version, '0.2.0')
  assert.equal(entry.commit, commit)
  assert.equal(entry.released_at, 1_700_000_000_000)
  assert.equal(entry.security, false)
  assert.equal(entry.protocol, 1)
  assert.ok(entry.artifacts['server-linux-x86_64'])
  assert.equal('breaking' in entry, false)
  assert.equal('notes' in entry, false)
})

test('re-recording a release replaces its entry instead of duplicating it', () => {
  const old = { version: '0.1.0', commit: 'b'.repeat(40), released_at: 1 }
  const manifest = { channel: 'releases', generated_at: 1, releases: [old] }
  const entry = { version: '0.1.0', commit: 'b'.repeat(40), released_at: 2 }
  const next = rewriteManifest(manifest, entry)
  assert.equal(next.releases.length, 1)
  assert.equal(next.releases[0].released_at, 2)
  assert.equal(next.channel, 'releases')
  assert.notEqual(next.generated_at, 1, 'a real change moves the timestamp')
})

// Re-running must not produce a commit differing only by `generated_at`; the workflow checks whether the file changed.
test('re-recording identical content leaves generated_at alone', () => {
  const entry = { version: '0.1.0', commit: 'b'.repeat(40), released_at: 2 }
  const manifest = { channel: 'releases', generated_at: 12345, releases: [entry] }
  const next = rewriteManifest(manifest, { ...entry })
  assert.equal(next.generated_at, 12345)
  assert.deepEqual(next.releases, [entry])
})

test('the manifest stays newest-first and bounded', () => {
  const releases = Array.from({ length: 5 }, (_, i) => ({
    commit: String(i).repeat(40).slice(0, 40),
    released_at: i,
  }))
  const next = rewriteManifest({ releases }, { commit: 'f'.repeat(40), released_at: 99 }, 3)
  assert.equal(next.releases.length, 3)
  assert.deepEqual(next.releases.map((r) => r.released_at), [99, 4, 3])
})
