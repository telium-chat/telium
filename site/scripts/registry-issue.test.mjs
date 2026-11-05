import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// node wants a plain path for its entry argument; import.meta.url is a URL.
const CLI = fileURLToPath(new URL('./registry-issue.mjs', import.meta.url))
import {
  checkboxChecked,
  detectKind,
  findDuplicate,
  insertEntry,
  parseEntryObject,
  rebuildEntry,
  sectionFor,
} from './registry-issue.mjs'

/* The body shape below is what GitHub renders a filled issue form into: each
   field becomes a `### Label` heading, checkbox fields become `- [X]` lists,
   and a textarea carries whatever the submitter put in it verbatim. */

const serverBody = (entry, { ownership = true, consent = false } = {}) => `<!-- telium-registry: server -->
This issue is turned into a pull request by automation.

### Registry entry

\`\`\`json
${JSON.stringify(entry, null, 2)}
\`\`\`

### Ownership

- [${ownership ? 'X' : ' '}] I run this server myself — it is not someone else's server.

### Automatic suggestions

- [${consent ? 'X' : ' '}] Also suggest this server automatically to people picking their first server.

### Notes

`

const serverEntry = (overrides = {}) => ({
  domain: 'chat.example.org',
  name: 'Example Chat',
  description: 'General-purpose homeserver for the Example community, open registration.',
  region: { label: 'Frankfurt, DE', code: 'eu-central' },
  size_band: '100-1k',
  operator: { name: 'Example Collective', contact: 'https://example.org/contact' },
  ...overrides,
})

test('sectionFor extracts a field up to the next heading', () => {
  const body = '### Registry entry\n\n```json\n{"a":1}\n```\n\n### Notes\n\nhello\n'
  assert.equal(sectionFor(body, 'Registry entry'), '\n```json\n{"a":1}\n```\n')
  assert.equal(sectionFor(body, 'Notes'), '\nhello\n')
  assert.equal(sectionFor(body, 'Missing'), null)
})

test('parseEntryObject takes a fenced block or bare JSON', () => {
  assert.deepEqual(parseEntryObject('\n```json\n{"a":1}\n```\n'), { a: 1 })
  assert.deepEqual(parseEntryObject('\n{"a":1}\n'), { a: 1 })
  assert.deepEqual(parseEntryObject('\n```\n{"a":1}\n```\n'), { a: 1 })
  assert.throws(() => parseEntryObject('\nnot json\n'), /not valid JSON/)
  assert.throws(() => parseEntryObject(null), /no "Registry entry" section/)
})

test('checkboxChecked matches the rendered list item', () => {
  const checked = '- [X] I run this server myself — it is not someone else\'s server.\n'
  const unchecked = '- [ ] I run this server myself — it is not someone else\'s server.\n'
  assert.equal(checkboxChecked(checked, 'I run this server myself'), true)
  assert.equal(checkboxChecked(unchecked, 'I run this server myself'), false)
  assert.equal(checkboxChecked(null, 'anything'), false)
})

test('detectKind reads the template marker', () => {
  assert.equal(detectKind('<!-- telium-registry: server -->\nrest'), 'server')
  assert.equal(detectKind('<!-- telium-registry: sfu -->'), 'sfu')
  assert.equal(detectKind('a plain issue'), null)
})

test('rebuildEntry keeps only schema fields and stamps nothing it was not given', () => {
  const raw = serverEntry({ recommendations: { opt_in: true }, added: '1999-01-01', sneaky: true })
  const entry = rebuildEntry('server', raw, { added: '2026-11-04', consent: false })
  assert.deepEqual(entry, {
    domain: 'chat.example.org',
    name: 'Example Chat',
    description: 'General-purpose homeserver for the Example community, open registration.',
    region: { label: 'Frankfurt, DE', code: 'eu-central' },
    size_band: '100-1k',
    operator: { name: 'Example Collective', contact: 'https://example.org/contact' },
    added: '2026-11-04',
  })
})

test('consent switches come from the checkbox, never the JSON', () => {
  const smuggled = rebuildEntry('server', serverEntry({ recommendations: { opt_in: true } }), { added: '2026-11-04', consent: false })
  assert.equal('recommendations' in smuggled, false)
  const opted = rebuildEntry('server', serverEntry(), { added: '2026-11-04', consent: true })
  assert.deepEqual(opted.recommendations, { opt_in: true })

  const feedSmuggled = rebuildEntry('sfu', { url: 'https://sfu.example', feed: { opt_in: true } }, { added: '2026-11-04', consent: false })
  assert.equal('feed' in feedSmuggled, false)
  const feedOpted = rebuildEntry('sfu', { url: 'https://sfu.example', weight: 3, pubkey_hint: 'x' }, { added: '2026-11-04', consent: true })
  assert.deepEqual(feedOpted.feed, { opt_in: true })
  assert.equal('weight' in feedOpted, false)
  assert.equal('pubkey_hint' in feedOpted, false)
})

test('relay URLs lose their trailing slash', () => {
  const entry = rebuildEntry('sfu', { url: 'https://sfu.example/' }, { added: '2026-11-04', consent: false })
  assert.equal(entry.url, 'https://sfu.example')
})

test('rebuildEntry rejects anything that is not an object', () => {
  assert.throws(() => rebuildEntry('server', [1, 2], { added: '2026-11-04', consent: false }), /must be a JSON object/)
  assert.throws(() => rebuildEntry('server', '"hi"', { added: '2026-11-04', consent: false }), /must be a JSON object/)
})

test('insertEntry sorts by domain with telium.chat pinned first', () => {
  const registry = [{ domain: 'telium.chat' }, { domain: 'atlas.nyc' }, { domain: 'zeta.example' }]
  const inserted = insertEntry(registry, { domain: 'mid.example' }, 'server')
  assert.deepEqual(inserted.map((entry) => entry.domain), ['telium.chat', 'atlas.nyc', 'mid.example', 'zeta.example'])
  // The pinned entry stays put even when the newcomer sorts before it.
  assert.deepEqual(insertEntry([{ domain: 'telium.chat' }], { domain: 'aaa.example' }, 'server').map((e) => e.domain), ['telium.chat', 'aaa.example'])
  // An empty registry takes its first entry.
  assert.deepEqual(insertEntry([], { domain: 'chat.example.org' }, 'server'), [{ domain: 'chat.example.org' }])
})

test('insertEntry sorts relays by url with no pinned entry', () => {
  const inserted = insertEntry([{ url: 'https://sfu.example' }], { url: 'https://aaa.example' }, 'sfu')
  assert.deepEqual(inserted.map((entry) => entry.url), ['https://aaa.example', 'https://sfu.example'])
})

test('findDuplicate matches domains exactly and relay origins with or without a slash', () => {
  assert.ok(findDuplicate([{ domain: 'chat.example.org' }], { domain: 'chat.example.org' }, 'server'))
  assert.equal(findDuplicate([{ domain: 'chat.example.org' }], { domain: 'other.example' }, 'server'), undefined)
  assert.ok(findDuplicate([{ url: 'https://sfu.example' }], { url: 'https://sfu.example/' }, 'sfu'))
})

test('the command line turns an issue into a sorted, validated registry file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'registry-issue-'))
  try {
    const registry = join(dir, 'servers.json')
    await writeFile(registry, '[]\n')
    const body = join(dir, 'body.md')
    await writeFile(body, serverBody(serverEntry()))

    const run = spawnSync(process.execPath, [
      CLI,
      '--kind', 'server',
      '--body-file', body,
      '--created', '2026-11-04T09:30:00Z',
      '--registry', registry,
    ], { encoding: 'utf8' })

    assert.equal(run.status, 0, `expected success, got:\n${run.stdout}\n${run.stderr}`)
    const file = JSON.parse(await readFile(registry, 'utf8'))
    assert.equal(file.length, 1)
    assert.equal(file[0].domain, 'chat.example.org')
    assert.equal(file[0].added, '2026-11-04')
    assert.equal(run.stdout.includes('chat.example.org'), true)
    // The file on disk is byte-for-byte what the validators and the site expect.
    assert.equal(await readFile(registry, 'utf8'), `${JSON.stringify(file, null, 2)}\n`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the command line refuses duplicates and unparseable entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'registry-issue-'))
  try {
    const registry = join(dir, 'servers.json')
    await writeFile(registry, `${JSON.stringify([serverEntry()], null, 2)}\n`)
    const body = join(dir, 'body.md')
    await writeFile(body, serverBody(serverEntry()))
    const run = spawnSync(process.execPath, [
      CLI,
      '--kind', 'server',
      '--body-file', body,
      '--created', '2026-11-04T09:30:00Z',
      '--registry', registry,
    ], { encoding: 'utf8' })
    assert.equal(run.status, 3)
    assert.match(run.stderr, /already listed/)

    // A different domain, so the duplicate check passes and the validator's
    // rejection is what stops the run.
    const bad = join(dir, 'bad.md')
    await writeFile(bad, serverBody(serverEntry({ domain: 'other.example.org', description: 'too short' })).replace('size_band": "100-1k"', 'size_band": "medium"'))
    const runBad = spawnSync(process.execPath, [
      CLI,
      '--kind', 'server',
      '--body-file', bad,
      '--created', '2026-11-04T09:30:00Z',
      '--registry', registry,
    ], { encoding: 'utf8' })
    assert.equal(runBad.status, 1, 'the validator must gate the commit')
    assert.match(runBad.stderr, /size_band must be one of/)
    assert.match(runBad.stderr, /did not pass the registry validator/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
