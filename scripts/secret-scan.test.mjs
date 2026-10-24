// Tests for the secret scanner: each builds a throwaway git repo and runs the real scanner with `--repo`.
// Every credential-shaped string below is dead; never replace one with a live value.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCANNER = join(HERE, 'secret-scan.mjs')
const REPO = resolve(HERE, '..')


// DEAD: base64 of an English sentence, not random; shaped like `voice.turn_secret`.
const FAKE_TURN_SECRET = Buffer.from(
  'this is not a real secret, it is a test fixture!',
).toString('base64')

// DEAD: AKIA prefix followed by the word DEAD repeated.
const FAKE_AWS_KEY = 'AKIADEADDEADDEADDEAD'

// DEAD: Ed25519 key generated for this test and discarded.
const DEAD_ED25519_PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MC4CAQAwBQYDK2VwBCIEIC5a3qkXn46Q0Xm122miADr/ucBVWZiVI7I3M0X/izO+',
  '-----END PRIVATE KEY-----',
].join('\n')

// Near misses: credential-adjacent, none a credential. Must not fire.
const NEAR_MISS = [
  'turn_secret = "${TELIUM_TURN_SECRET}"',
  'webhook_token = "replace-this-with-your-own-token"',
  'scrape_token = "changeme"',
  'api_key = "your-klipy-key-here"',
  'const BOT_REVOKED = "bot_credential_revoked";',
  'let token = cfg.metrics.scrape_token.trim().to_string();',
  'background_token_hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"',
  'service_account_file = "/etc/telium/fcm-service-account.json"',
  'manifest_public_key_url = "https://releases.example/telium.pub"',
  '// The KLIPY api_key is public; see docs/secrets.md.',
].join('\n')


const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString('utf8')
    .trim()

// Real `git init`, since history mode walks real commits.
const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'telium-secret-scan-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'Secret scan test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

const commit = (repo, files, message) => {
  for (const [path, body] of Object.entries(files)) {
    const full = join(repo, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

// Returns `{ code, out }`; a non-zero exit is the case under test, so it is caught.
const scanExpectingFailure = (args) => {
  try {
    const out = execFileSync(process.execPath, [SCANNER, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const emptyAllowlist = (repo) => {
  const path = join(repo, 'allowlist.json')
  writeFileSync(path, JSON.stringify({ allowed: [] }))
  return path
}


test('fires on a credential in the working tree', (t) => {
  const repo = makeRepo()
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  commit(repo, { 'telium.toml': `[voice]\nturn_secret = "${FAKE_TURN_SECRET}"\n` }, 'config')

  const { code, out } = scanExpectingFailure([
    '--tree',
    '--repo',
    repo,
    '--allowlist',
    emptyAllowlist(repo),
  ])
  assert.equal(code, 1, 'the scanner must exit non-zero on a finding')
  assert.match(out, /assigned-credential/)
  assert.match(out, /telium\.toml:2/)
  // A finding names a digest, never the value; CI logs get copied.
  assert.ok(!out.includes(FAKE_TURN_SECRET), 'the scanner must not print the matched text')
  assert.match(out, new RegExp(createHash('sha256').update(FAKE_TURN_SECRET).digest('hex')))
})

test('stays quiet on the near miss', (t) => {
  const repo = makeRepo()
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  commit(repo, { 'near-miss.toml': NEAR_MISS }, 'things that are not secrets')

  const { code, out } = scanExpectingFailure([
    '--tree',
    '--repo',
    repo,
    '--allowlist',
    emptyAllowlist(repo),
  ])
  assert.equal(code, 0, `placeholders and derived values must not be findings:\n${out}`)
  assert.match(out, /No unexplained credentials found/)
})


test('finds a credential a later commit deleted', (t) => {
  const repo = makeRepo()
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const base = commit(repo, { 'README.md': '# fixture\n' }, 'base')
  commit(repo, { 'deploy/prod.toml': `turn_secret = "${FAKE_TURN_SECRET}"\n` }, 'oops')
  const head = commit(repo, { 'deploy/prod.toml': 'turn_secret = ""\n' }, 'remove it again')

  // The working tree is clean but the secret is still in history; a checkout-only scan misses it.
  const clean = scanExpectingFailure([
    '--tree',
    '--repo',
    repo,
    '--allowlist',
    emptyAllowlist(repo),
  ])
  assert.equal(clean.code, 0, 'the tip really is clean -- that is what makes this case hard')

  const { code, out } = scanExpectingFailure([
    '--range',
    `${base}..${head}`,
    '--repo',
    repo,
    '--allowlist',
    emptyAllowlist(repo),
  ])
  assert.equal(code, 1, 'a deleted-but-committed secret must still be a finding')
  assert.match(out, /deploy\/prod\.toml/)
})

test('a PEM private key is a finding wherever it appears', (t) => {
  const repo = makeRepo()
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  commit(repo, { 'docs/example.md': `Do not do this:\n\n${DEAD_ED25519_PEM}\n` }, 'pem')

  const { code, out } = scanExpectingFailure([
    '--tree',
    '--repo',
    repo,
    '--allowlist',
    emptyAllowlist(repo),
  ])
  assert.equal(code, 1)
  assert.match(out, /private-key-block/)
})

test('a shaped credential is a finding with no entropy or placeholder excuse', (t) => {
  const repo = makeRepo()
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  // Surrounded by "example", which would exempt it under the contextual rule; the shaped rules take no such excuse.
  commit(repo, { 'example.env': `# example only\nAWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n` }, 'aws')

  const { code, out } = scanExpectingFailure([
    '--tree',
    '--repo',
    repo,
    '--allowlist',
    emptyAllowlist(repo),
  ])
  assert.equal(code, 1)
  assert.match(out, /aws-access-key-id/)
})


test('an allowlist entry excuses exactly one value at one path', (t) => {
  const repo = makeRepo()
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  commit(repo, { 'telium.toml': `turn_secret = "${FAKE_TURN_SECRET}"\n` }, 'config')

  const allowlist = join(repo, 'allowlist.json')
  const entry = {
    rule: 'assigned-credential',
    path: 'telium.toml',
    sha256: createHash('sha256').update(FAKE_TURN_SECRET).digest('hex'),
    reason:
      'A test fixture whose base64 decodes to an English sentence, kept here to prove the ' +
      'allowlist matches on rule, path and digest together.',
    reviewed: '2026-09-20',
    reviewer: '@67plays',
  }
  writeFileSync(allowlist, JSON.stringify({ allowed: [entry] }))

  assert.equal(
    scanExpectingFailure(['--tree', '--repo', repo, '--allowlist', allowlist]).code,
    0,
    'the entry should excuse the value it names',
  )

  // The same digest at a different path is not excused.
  commit(repo, { 'deploy/other.toml': `turn_secret = "${FAKE_TURN_SECRET}"\n` }, 'elsewhere')
  const moved = scanExpectingFailure(['--tree', '--repo', repo, '--allowlist', allowlist])
  assert.equal(moved.code, 1, 'the same value at another path must still be a finding')
  assert.match(moved.out, /deploy\/other\.toml/)
})

test('a different value in the allowlisted field is still a finding', (t) => {
  const repo = makeRepo()
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const allowlist = join(repo, 'allowlist.json')
  writeFileSync(
    allowlist,
    JSON.stringify({
      allowed: [
        {
          rule: 'assigned-credential',
          path: 'telium.toml',
          sha256: createHash('sha256').update(FAKE_TURN_SECRET).digest('hex'),
          reason:
            'Pinned to one digest on purpose: this test asserts that replacing the value ' +
            'in the same field of the same file brings the finding straight back.',
          reviewed: '2026-09-20',
          reviewer: '@67plays',
        },
      ],
    }),
  )
  // DEAD: base64 of another English sentence.
  const different = Buffer.from('a different dead fixture value, also not a secret').toString(
    'base64',
  )
  commit(repo, { 'telium.toml': `turn_secret = "${different}"\n` }, 'swap the value')

  const { code } = scanExpectingFailure(['--tree', '--repo', repo, '--allowlist', allowlist])
  assert.equal(code, 1, 'the excuse must not survive the value it was written for')
})

test('an allowlist entry with a one-line reason is rejected outright', (t) => {
  const repo = makeRepo()
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  commit(repo, { 'README.md': '# fixture\n' }, 'base')
  const allowlist = join(repo, 'allowlist.json')
  writeFileSync(
    allowlist,
    JSON.stringify({
      allowed: [
        {
          rule: 'assigned-credential',
          path: 'telium.toml',
          sha256: 'a'.repeat(64),
          reason: 'not a secret',
          reviewed: '2026-09-20',
          reviewer: '@67plays',
        },
      ],
    }),
  )
  const { code, out } = scanExpectingFailure(['--tree', '--repo', repo, '--allowlist', allowlist])
  assert.equal(code, 1)
  assert.match(out, /too short to be a justification/)
})

test('--report-only reports the finding and exits zero', (t) => {
  const repo = makeRepo()
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  commit(repo, { 'telium.toml': `turn_secret = "${FAKE_TURN_SECRET}"\n` }, 'config')
  const { code, out } = scanExpectingFailure([
    '--tree',
    '--report-only',
    '--repo',
    repo,
    '--allowlist',
    emptyAllowlist(repo),
  ])
  assert.equal(code, 0)
  assert.match(out, /assigned-credential/)
})


test('this repository is clean under its own allowlist', () => {
  const { code, out } = scanExpectingFailure(['--tree', '--repo', REPO])
  assert.equal(code, 0, out)
})
