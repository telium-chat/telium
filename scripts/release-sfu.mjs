#!/usr/bin/env node
// Decisions behind a tagged SFU release; builds nothing and moves no tag.
//
// The SFU releases on its own train (sfu-v* tags, its own deploy/sfu-releases.json)
// rather than riding the server's, so a relay only nags its operator when the relay
// changed. The rules a tag must satisfy and the shape of a manifest entry are the
// server's, so the component-neutral functions are imported rather than copied:
// two opinions about hostile input was exactly what the updater CLI exists to avoid.

import { readFileSync, writeFileSync } from 'node:fs'
import {
  manifestEntry,
  parseTrailers,
  rewriteManifest,
} from './release-server.mjs'

export const TAG_PREFIX = 'sfu-v'

export const LATEST_TAG = 'sfu-latest'

/// No pre-release suffix, matching `Version::parse` in Rust.
export function parseTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith(TAG_PREFIX)) return null
  const version = tag.slice(TAG_PREFIX.length)
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) return null
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])]
  // Same ceiling as the binary, so an accepted tag is one the binary agrees is a release.
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

const ARTIFACT_ARCHES = ['x86_64', 'aarch64']

function log(message) {
  process.stderr.write(`${message}\n`)
}

function die(message) {
  process.stderr.write(`release-sfu: ${message}\n`)
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
  for (const arch of ARTIFACT_ARCHES) {
    const url = args[`artifact-${arch}-url`]
    const sha256 = args[`artifact-${arch}-sha256`]
    const size = Number(args[`artifact-${arch}-size`] ?? 0)
    if (!url) continue
    if (!/^https:\/\//.test(url)) die(`artifact URL for ${arch} is not https`)
    if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) die(`artifact sha256 for ${arch} is not 64 lowercase hex`)
    artifacts[`sfu-linux-${arch}`] = { url, sha256, size: size || undefined }
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

  const path = args.manifest ?? 'deploy/sfu-releases.json'
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
  else die(`usage: release-sfu.mjs <inspect|record> [options]`)
}
