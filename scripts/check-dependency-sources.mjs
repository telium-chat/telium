#!/usr/bin/env node
// Fails on non-crates.io registries, npm entries without integrity, and git deps not pinned to approved commits.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The index URL Cargo stamps into every package id.
const CRATES_IO = 'https://github.com/rust-lang/crates.io-index'

// Approved git dependencies, each pinned to a full commit. `arrpc` has no npm release.
const ALLOWED_GIT_DEPENDENCIES = new Map([
  ['arrpc', 'github:OpenAsar/arrpc#d4ce31f313eaf864f46576ee98fbf88c9ef47036'],
])

// Kept in step with `audit-gate.mjs`.
const AUDITED = [
  'server/Cargo.lock',
  'sfu/Cargo.lock',
  // `unit-tests.yml` builds this crate standalone, so it needs a lockfile.
  'telium-protocol/Cargo.lock',
  'web/src-tauri/Cargo.lock',
  'web/bun.lock',
  'web/electron/bun.lock',
  'site/bun.lock',
]

const problems = []
const note = (what) => problems.push(what)


const SKIP_DIRS = new Set(['node_modules', 'target', '.git', 'dist', 'dist-electron', 'gen', 'build'])
const LOCKFILES = new Set(['Cargo.lock', 'bun.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])

const discover = (dir, found = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      discover(join(dir, entry.name), found)
    } else if (LOCKFILES.has(entry.name)) {
      found.push(relative(REPO, join(dir, entry.name)))
    }
  }
  return found
}

const checkDiscovery = () => {
  const found = discover(REPO).sort()
  for (const lock of found) {
    // Another tool's lockfile means different resolution rules than CI's.
    if (lock.endsWith('package-lock.json') || lock.endsWith('yarn.lock') || lock.endsWith('pnpm-lock.yaml')) {
      note(`${lock}: this repository installs with bun and commits bun.lock; delete this file.`)
      continue
    }
    if (!AUDITED.includes(lock)) {
      note(
        `${lock}: a dependency tree that no audit target covers. Add it to AUDITED here ` +
          `and to TARGETS in scripts/audit-gate.mjs, or remove the lockfile.`,
      )
    }
  }
  for (const lock of AUDITED) {
    if (!found.includes(lock)) {
      note(`${lock}: listed as an audit target but not present. Remove it from both lists.`)
    }
  }
}


// Package ids are `<source>#<name>@<version>`; the source prefix says where it came from.
const checkCargo = (manifestDir) => {
  let out
  try {
    out = execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], {
      cwd: join(REPO, manifestDir),
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
  } catch (err) {
    // `--locked` fails on lockfile/manifest mismatch, which is itself a finding.
    note(`${manifestDir}: cargo metadata --locked failed; the committed Cargo.lock does not match Cargo.toml.`)
    return
  }
  const meta = JSON.parse(out)
  for (const pkg of meta.packages ?? []) {
    const id = String(pkg.id ?? '')
    if (id.startsWith('path+file://')) continue // a crate in this repository
    if (id.startsWith(`registry+${CRATES_IO}`)) continue
    if (id.startsWith('git+')) {
      note(`${manifestDir}: ${pkg.name} ${pkg.version} is a git dependency (${id}). Git dependencies are not approved for Rust here.`)
      continue
    }
    if (id.startsWith('registry+')) {
      note(`${manifestDir}: ${pkg.name} ${pkg.version} resolves from a registry other than crates.io (${id}).`)
      continue
    }
    note(`${manifestDir}: ${pkg.name} ${pkg.version} has an unrecognised source (${id}).`)
  }
}

// `bun.lock` has trailing commas that `JSON.parse` rejects; one pass tracking strings and escapes avoids a JSON5 dependency.
const parseBunLock = (text) => {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === ',') {
      // A comma before a closing bracket is bun's trailing comma.
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += c
  }
  return JSON.parse(out)
}

// Entry shape varies by source, so `entry[1]` is not reliably the resolution; element 0 is `<name>@<specifier>`.
const specifierOf = (key) => {
  // Skip a leading scope `@`.
  const at = key.lastIndexOf('@')
  return at <= 0 ? '' : key.slice(at + 1)
}

const IS_BARE_VERSION = /^\d+\.\d+\.\d+/

const checkBunLock = (lockPath) => {
  const lock = parseBunLock(readFileSync(join(REPO, lockPath), 'utf8'))
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
      note(`${lockPath}: ${name} has an entry this check does not understand; bun's lockfile format may have changed.`)
      continue
    }
    const spec = specifierOf(entry[0])
    const integrity = entry.find((v) => typeof v === 'string' && v.startsWith('sha512-'))

    if (!IS_BARE_VERSION.test(spec)) {
      if (spec.startsWith('workspace:') || spec.startsWith('link:') || spec.startsWith('file:')) continue

      const base = name.split('/').pop()
      const approved = ALLOWED_GIT_DEPENDENCIES.get(base)
      if (!approved) {
        note(`${lockPath}: ${name} resolves from "${spec}" rather than the npm registry, and is not in ALLOWED_GIT_DEPENDENCIES.`)
        continue
      }
      // bun abbreviates the commit; compare as a prefix of the approved one.
      const lockCommit = spec.split('#')[1] ?? ''
      const approvedCommit = approved.split('#')[1] ?? ''
      if (!lockCommit || !approvedCommit.startsWith(lockCommit)) {
        note(`${lockPath}: ${name} is locked at commit "${lockCommit}", which is not the approved "${approvedCommit}".`)
        continue
      }
      const approvedRepo = approved.split('#')[0]
      if (!spec.startsWith(approvedRepo)) {
        note(`${lockPath}: ${name} is locked against "${spec}" but the approved source is "${approvedRepo}".`)
        continue
      }
    }

    // Without an integrity hash the lockfile pins the version but not the bytes.
    if (!integrity) {
      note(`${lockPath}: ${name} has no integrity hash; its contents are not pinned.`)
    }
  }
}

// A branch or bare `github:owner/repo` installs whatever it points at today.
const checkApprovedGitPins = () => {
  for (const [name, spec] of ALLOWED_GIT_DEPENDENCIES) {
    const fragment = spec.split('#')[1] ?? ''
    if (!/^[0-9a-f]{40}$/.test(fragment)) {
      note(`ALLOWED_GIT_DEPENDENCIES: ${name} is "${spec}", which does not pin a 40-character commit.`)
    }
  }
  for (const manifest of ['web/package.json', 'web/electron/package.json', 'site/package.json', 'sdk/bot/js/package.json']) {
    let pkg
    try {
      pkg = JSON.parse(readFileSync(join(REPO, manifest), 'utf8'))
    } catch (err) {
      note(`${manifest}: could not be read (${err.message}).`)
      continue
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (typeof range !== 'string') continue
        if (/^(\^|~|>|<|=|\d|\*|$)/.test(range) || range === 'latest') continue
        if (range.startsWith('workspace:') || range.startsWith('file:') || range.startsWith('link:')) continue
        const approved = ALLOWED_GIT_DEPENDENCIES.get(name.split('/').pop())
        if (approved !== range) {
          note(`${manifest}: ${name} is declared as "${range}", which is not an approved, commit-pinned source.`)
        }
      }
    }
  }
}


checkDiscovery()
checkApprovedGitPins()
for (const dir of ['server', 'sfu', 'web/src-tauri']) checkCargo(dir)
for (const lock of ['web/bun.lock', 'web/electron/bun.lock', 'site/bun.lock']) {
  try {
    checkBunLock(lock)
  } catch (err) {
    note(`${lock}: could not be read as a bun lockfile (${err.message}).`)
  }
}

const summary = problems.length
  ? ['### Dependency sources', '', `${problems.length} problem(s):`, '', ...problems.map((p) => `- ${p}`), '']
  : ['### Dependency sources', '', 'Every dependency resolves from crates.io or the npm registry, every registry package carries an integrity hash, and every approved git dependency names a commit.', '']

process.stdout.write(summary.join('\n') + '\n')
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n')
}
process.exit(problems.length ? 1 : 0)
