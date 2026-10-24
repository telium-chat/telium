#!/usr/bin/env node
// Decisions behind a tagged server release; builds nothing and moves no tag.

import { readFileSync, writeFileSync } from 'node:fs'


/// The tag prefix this train owns; `desktop-v` and `android-v` are other trains.
export const TAG_PREFIX = 'server-v'

export const LATEST_TAG = 'server-latest'

/// No pre-release suffix, matching `Version::parse` in Rust.
export function parseTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith(TAG_PREFIX)) return null
  const version = tag.slice(TAG_PREFIX.length)
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) return null
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])]
  // Same ceiling as the server, so an accepted tag is one the binary agrees is a release.
  if (parts.some((n) => !Number.isSafeInteger(n) || n > 1_000_000)) return null
  return { major: parts[0], minor: parts[1], patch: parts[2], version }
}

/// Numeric: a string sort puts `0.10.0` before `0.9.0`.
export function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/// Unparsable tags are ignored so a typo cannot become the newest release.
export function newestTag(tags) {
  let best = null
  for (const tag of tags) {
    const parsed = parseTag(tag)
    if (!parsed) continue
    if (best === null || compareVersions(parsed, best.parsed) > 0) {
      best = { tag, parsed }
    }
  }
  return best ? best.tag : null
}

/// Only the highest version, so re-running an old release cannot move the pointer backwards.
export function movesLatest(tag, tags) {
  return newestTag(tags) === tag
}

/// Trailers are on their own line, case-insensitive; only `yes`/`true` counts.
export function parseTrailers(text) {
  const body = typeof text === 'string' ? text : ''
  const flag = (name) => new RegExp(`^${name}:[ \\t]*(yes|true)[ \\t]*$`, 'im').test(body)
  const noted = /^Upgrade-notes:[ \t]*(.+)$/im.exec(body)
  return {
    security: flag('Security-relevant'),
    breaking: flag('Breaking-change'),
    notes: (noted ? noted[1] : '').trim().slice(0, 400),
  }
}

/// A new migration or changed `STATE_FORMAT_VERSION` makes the old binary refuse the database; the undo is the backup.
export function classifyRollback({ migrationsAdded, stateFormatChanged }) {
  if (migrationsAdded) {
    return {
      rollbackable: false,
      reason: 'it adds a migration, so the previous binary cannot open the migrated database',
    }
  }
  if (stateFormatChanged) {
    return {
      rollbackable: false,
      reason: 'it changes STATE_FORMAT_VERSION, so the previous binary cannot read the stored values',
    }
  }
  return {
    rollbackable: true,
    reason: 'it adds no migration and keeps the state format, so the previous binary can open the database',
  }
}

/// Artifact URLs point at the versioned release so a download cannot be replaced under a pinned box.
export function manifestEntry({ version, commit, releasedAt, summary, image, trailers, protocol, minProtocol, artifacts }) {
  const entry = {
    version,
    commit,
    released_at: releasedAt,
    security: trailers.security,
    summary: String(summary ?? '').slice(0, 200),
    image: image ?? '',
  }
  // Absent and false mean the same to every consumer; omit them to keep the file small.
  if (trailers.breaking) entry.breaking = true
  if (trailers.notes) entry.notes = trailers.notes
  if (Number.isInteger(protocol)) entry.protocol = protocol
  if (Number.isInteger(minProtocol)) entry.min_protocol = minProtocol
  if (artifacts && Object.keys(artifacts).length > 0) entry.artifacts = artifacts
  return entry
}

/// Re-running replaces the entry; `generated_at` moves only when the list changed.
export function rewriteManifest(manifest, entry, keep = 200) {
  const releases = Array.isArray(manifest.releases) ? manifest.releases : []
  const others = releases.filter((r) => r && r.commit !== entry.commit)
  const merged = [...others, entry]
  merged.sort((a, b) => (b.released_at || 0) - (a.released_at || 0))
  const bounded = merged.slice(0, keep)

  // Order-insensitive, so a re-record with the same content is a no-op.
  const before = JSON.stringify(sortByCommit(releases))
  const after = JSON.stringify(sortByCommit(bounded))
  const changed = before !== after

  return {
    ...manifest,
    channel: 'releases',
    generated_at: changed ? Date.now() : manifest.generated_at ?? 0,
    releases: bounded,
  }
}

function sortByCommit(releases) {
  return [...releases].sort((a, b) => String(a?.commit).localeCompare(String(b?.commit)))
}


function log(message) {
  process.stderr.write(`${message}\n`)
}

function die(message) {
  process.stderr.write(`release-server: ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!key?.startsWith('--')) die(`unexpected argument ${key}`)
    args[key.slice(2)] = argv[i + 1]
  }
  return args
}

/// An empty string means absent, not zero.
function optionalInteger(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const n = Number(value)
  return Number.isInteger(n) ? n : undefined
}

/// Decided here so the notes and the tested function cannot disagree.
function rollback(args) {
  const yes = (value) => /^(1|yes|true)$/i.test(String(value ?? ''))
  const verdict = classifyRollback({
    migrationsAdded: yes(args['migrations-added']),
    stateFormatChanged: yes(args['state-format-changed']),
  })
  console.log(`rollbackable=${verdict.rollbackable}`)
  console.log(`rollback_reason=${verdict.reason}`)
}

function inspect(args) {
  const parsed = parseTag(args.tag)
  if (!parsed) die(`--tag must be ${TAG_PREFIX}<major>.<minor>.<patch>, got ${JSON.stringify(args.tag)}`)

  const tags = String(args.tags ?? '').split(/\s+/).filter(Boolean)
  const newest = newestTag(tags)
  const moves = movesLatest(args.tag, tags)

  log(`tag ${args.tag} names version ${parsed.version}`)
  log(`newest release tag is ${newest ?? '(none)'}; this tag ${moves ? 'moves' : 'does not move'} ${LATEST_TAG}`)

  console.log(`version=${parsed.version}`)
  console.log(`moves_latest=${moves}`)
  console.log(`latest_tag=${LATEST_TAG}`)
}

function record(args) {
  const parsed = parseTag(args.tag)
  if (!parsed) die(`--tag must be ${TAG_PREFIX}<major>.<minor>.<patch>`)
  if (!/^[0-9a-f]{40}$/.test(args.commit ?? '')) die('--commit must be 40 lowercase hex')

  const trailers = parseTrailers(args.trailers)
  const artifacts = {}
  for (const arch of ['x86_64', 'aarch64']) {
    const url = args[`artifact-${arch}-url`]
    const sha256 = args[`artifact-${arch}-sha256`]
    const size = Number(args[`artifact-${arch}-size`] ?? 0)
    if (!url) continue
    if (!/^https:\/\//.test(url)) die(`artifact URL for ${arch} is not https`)
    if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) die(`artifact sha256 for ${arch} is not 64 lowercase hex`)
    artifacts[`server-linux-${arch}`] = { url, sha256, size: size || undefined }
  }

  const entry = manifestEntry({
    version: parsed.version,
    commit: args.commit,
    releasedAt: Number(args['released-at']) * 1000,
    summary: args.summary,
    image: args.image,
    trailers,
    protocol: optionalInteger(args.protocol),
    minProtocol: optionalInteger(args['min-protocol']),
    artifacts,
  })

  const path = args.manifest ?? 'deploy/releases.json'
  let manifest = { channel: 'releases', generated_at: 0, releases: [] }
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') die(`${path} is not readable JSON: ${err.message}`)
    log(`${path} does not exist yet; creating it`)
  }

  const next = rewriteManifest(manifest, entry)
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  log(`recorded ${args.tag} at ${args.commit.slice(0, 12)} (${next.releases.length} releases kept)`)
  console.log(`recorded=${parsed.version}`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'inspect') inspect(parseArgs(rest))
  else if (command === 'record') record(parseArgs(rest))
  else if (command === 'rollback') rollback(parseArgs(rest))
  else die(`usage: release-server.mjs <inspect|record|rollback> [options]`)
}
