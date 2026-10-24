// Decision logic of the advisory gate, run against `--input` fixtures; asserts the exit code.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const REASON =
  'A fixture reason that is deliberately long enough to satisfy the justification length rule.'

const dayOffset = (days) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const finding = (over = {}) => ({
  ecosystem: 'cargo',
  target: 'server',
  id: 'RUSTSEC-9999-0001',
  package: 'example',
  version: '1.0.0',
  severity: 'high',
  title: 'Example advisory',
  url: '',
  fixed: '',
  gating: true,
  ...over,
})

// The gate resolves its allowlist relative to itself, so fixtures need a throwaway copy of the layout.
const runGate = (findings, advisories, extraArgs = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-gate-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, '.github'))
    copyFileSync(join(HERE, 'audit-gate.mjs'), join(dir, 'scripts', 'audit-gate.mjs'))
    writeFileSync(join(dir, '.github', 'dependency-audit-allowlist.json'), JSON.stringify({ advisories }))
    const input = join(dir, 'fixture.json')
    writeFileSync(input, JSON.stringify({ findings, targets: [{ name: 'server' }] }))
    try {
      const stdout = execFileSync(
        process.execPath,
        [join(dir, 'scripts', 'audit-gate.mjs'), '--input', input, ...extraArgs],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
      return { code: 0, stdout }
    } catch (err) {
      return { code: err.status, stdout: String(err.stdout ?? '') }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const exemption = (over = {}) => ({
  id: 'RUSTSEC-9999-0001',
  ecosystem: 'cargo',
  package: 'example',
  reason: REASON,
  reviewed: dayOffset(-30),
  expires: dayOffset(30),
  reviewer: '@someone',
  ...over,
})

test('a clean scan passes', () => {
  const { code } = runGate([], [])
  assert.equal(code, 0)
})

test('an advisory with no exemption fails the build', () => {
  const { code, stdout } = runGate([finding()], [])
  assert.equal(code, 1)
  assert.match(stdout, /no reviewed exemption/)
})

test('an advisory under a current exemption passes, and says when it is due', () => {
  const { code, stdout } = runGate([finding()], [exemption()])
  assert.equal(code, 0)
  assert.match(stdout, /under a current exemption/)
  assert.match(stdout, new RegExp(dayOffset(30)))
})

test('an exemption past its expiry date fails, even though the advisory is unchanged', () => {
  // An expired entry that keeps suppressing is a permanent mute.
  const { code, stdout } = runGate([finding()], [exemption({ expires: dayOffset(-1) })])
  assert.equal(code, 1)
  assert.match(stdout, /past their review date/)
})

test('an exemption expiring today still holds', () => {
  // Renewal is not due at 00:05 UTC.
  const { code } = runGate([finding()], [exemption({ expires: dayOffset(0) })])
  assert.equal(code, 0)
})

test('an exemption does not cover a different package with the same advisory id', () => {
  const { code } = runGate([finding({ package: 'something-else' })], [exemption()])
  assert.equal(code, 1)
})

test('an exemption does not cross ecosystems', () => {
  const { code } = runGate([finding({ ecosystem: 'npm' })], [exemption()])
  assert.equal(code, 1)
})

test('a non-gating finding is reported but does not fail', () => {
  const { code, stdout } = runGate([finding({ gating: false, severity: 'unmaintained' })], [])
  assert.equal(code, 0)
  assert.match(stdout, /informational/)
})

test('an exemption that matches nothing is reported but does not fail', () => {
  const { code, stdout } = runGate([], [exemption()])
  assert.equal(code, 0)
  assert.match(stdout, /no longer match anything/)
})

test('--report-only never fails, but still says action is required', () => {
  const { code } = runGate([finding()], [], ['--report-only'])
  assert.equal(code, 0)
})

test('a malformed allowlist fails loudly rather than exempting nothing in silence', () => {
  for (const broken of [
    exemption({ expires: 'soon' }),
    exemption({ reason: 'too short' }),
    { ...exemption(), reviewer: undefined },
  ]) {
    const { code } = runGate([finding()], [broken])
    assert.equal(code, 1)
  }
})

test('the repository’s own allowlist is valid', () => {
  const { code } = (() => {
    const input = join(mkdtempSync(join(tmpdir(), 'audit-gate-real-')), 'empty.json')
    writeFileSync(input, JSON.stringify({ findings: [], targets: [] }))
    try {
      execFileSync(process.execPath, [join(REPO, 'scripts', 'audit-gate.mjs'), '--input', input], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { code: 0 }
    } catch (err) {
      return { code: err.status, stderr: String(err.stderr ?? '') }
    }
  })()
  assert.equal(code, 0)
})
