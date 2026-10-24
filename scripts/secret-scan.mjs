#!/usr/bin/env node
// Secret scanner for the tree and git history; reports a SHA-256 of a match, never the matched text.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Shaped rules match unmistakable formats and carry no entropy floor; only the contextual rule has one.
const SHAPED_RULES = [
  {
    id: 'private-key-block',
    description: 'PEM private key block',
    // Matches the armour, not the body, so reports never quote key material.
    re: /-----BEGIN (?:[A-Z0-9 ]{0,24})?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id',
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'github-token',
    description: 'GitHub personal access / app / refresh token',
    // A token with write access can move the release workflows.
    re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  },
  {
    id: 'github-fine-grained-token',
    description: 'GitHub fine-grained personal access token',
    re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  },
  {
    id: 'slack-token',
    description: 'Slack API token',
    re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g,
  },
  {
    id: 'stripe-live-key',
    description: 'Stripe live secret key',
    // `sk_test_` is deliberately absent: it grants nothing and would fire on docs.
    re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/g,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'openai-key',
    description: 'OpenAI API key',
    // Anchored on the infix; `sk-` alone collides with too much.
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: 'anthropic-key',
    description: 'Anthropic API key',
    re: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/g,
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    re: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: 'pypi-token',
    description: 'PyPI upload token',
    re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/g,
  },
  {
    id: 'gcp-service-account-key',
    description: 'Google service-account key JSON',
    // `private-key-block` catches the key inside; this makes the finding name the file.
    re: /"type"\s*:\s*"service_account"/g,
  },
  {
    id: 'jwt-with-payload',
    description: 'JSON Web Token carrying a signature',
    // Three base64url segments, the first two starting with `eyJ` (`{"`).
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g,
  },
]

// Real Telium secret keys (from `server/src/secrets.rs`) plus generic credential vocabulary; `api_key` is included so `livekit.api_key` is covered.
const SECRET_KEY_WORDS = [
  'api[_-]?key',
  'api[_-]?secret',
  'access[_-]?key',
  'secret[_-]?key',
  'client[_-]?secret',
  'private[_-]?key',
  'auth[_-]?token',
  'access[_-]?token',
  'refresh[_-]?token',
  'bearer[_-]?token',
  'webhook[_-]?token',
  'scrape[_-]?token',
  'guest[_-]?token',
  'turn[_-]?secret',
  'shared[_-]?secret',
  'signing[_-]?key',
  'encryption[_-]?key',
  'backup[_-]?key',
  'passwd',
  'password',
  'passphrase',
  'credential',
  'secret',
  'token',
]

// Key names containing a credential word that never hold one.
const NON_SECRET_KEY_SUFFIXES =
  /(?:_hash|_hashed|_digest|_len|_length|_ttl|_secs|_seconds|_ms|_count|_max|_min|_at|_enabled|_required|_algorithm|_alg|_type|_kind|_name|_file|_path|_dir|_url|_uri|_header|_prefix|_suffix|_env|_var|_code|_error|_reason|_field|_column|_key_id)$/i

const CONTEXTUAL_RULE = {
  id: 'assigned-credential',
  description: 'a long high-entropy literal assigned to a credential-named key',
  // One shape for TOML, YAML, JSON, .env and shell defaults. The value charset excludes `.` so method chains do not match.
  re: new RegExp(
    String.raw`(?<key>[A-Za-z0-9_.\-]*(?:${SECRET_KEY_WORDS.join('|')})[A-Za-z0-9_.\-]*)` +
      String.raw`["']?\s*[:=]\s*` +
      String.raw`(?<quote>["'` + '`' + String.raw`]?)(?<value>[A-Za-z0-9+/=_\-]{20,200})\k<quote>`,
    'gi',
  ),
  // 3.5 bits/char sits between random base64 (~4.5) and English or snake_case (~2.5-3.2).
  minEntropy: 3.5,
}

const PLACEHOLDER_PATTERNS = [
  /example/i,
  /changeme/i,
  /change[_-]?this/i,
  /replace[_-]?(?:me|this|with)/i,
  /\byour[_-]/i,
  /placeholder/i,
  /redacted/i,
  /dummy/i,
  /\bfake\b/i,
  /sample/i,
  /\btodo\b/i,
  /notasecret/i,
  /generated[_-]?at/i,
  /^x{8,}$/i,
  /^[0]+$/,
  /^(.)\1{7,}$/,
  // A segmented identifier such as `bot_credential_revoked`; random secrets are not lowercase words joined by underscores.
  /^[a-z0-9]+(?:[_-][a-z0-9]+)+$/,
  /^[A-Z0-9]+(?:[_-][A-Z0-9]+)+$/,
  /[$}{<>%]/,
  /^[.~]?\//,
  /^[a-z][a-z0-9+.-]*:\/\//i,
]

const SKIP_PATHS = [
  /(^|\/)bun\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)node_modules\//,
  /\.(?:png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|mp[34]|webm|wasm|pdf|zip|gz|xz|tar|jar|apk|keystore)$/i,
  // This file and its test hold literal examples; the blind spot is accepted because fixtures are dead and CODEOWNERS covers `scripts/`.
  /(^|\/)scripts\/secret-scan\.mjs$/,
  /(^|\/)scripts\/secret-scan\.test\.mjs$/,
]

const ALLOWLIST_PATH = resolve(HERE, '..', '.github', 'secret-scan-allowlist.json')


const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

const entropy = (s) => {
  const counts = new Map()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

const looksLikePlaceholder = (value) => PLACEHOLDER_PATTERNS.some((re) => re.test(value))

const skipped = (path) => SKIP_PATHS.some((re) => re.test(path))


const loadAllowlist = (path) => {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const doc = JSON.parse(raw)
  const entries = doc.allowed ?? []
  if (!Array.isArray(entries)) throw new Error(`${path}: "allowed" must be an array`)

  for (const e of entries) {
    for (const field of ['rule', 'path', 'sha256', 'reason', 'reviewed', 'reviewer']) {
      if (typeof e[field] !== 'string' || e[field] === '') {
        throw new Error(`allowlist entry for ${e.path ?? '(no path)'} is missing "${field}"`)
      }
    }
    // Same minimum as the advisory allowlist.
    if (e.reason.length < 80) {
      throw new Error(`allowlist entry for ${e.path} has a reason too short to be a justification`)
    }
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) {
      throw new Error(`allowlist entry for ${e.path} has a sha256 that is not 64 hex characters`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.reviewed)) {
      throw new Error(`allowlist entry for ${e.path} has a "reviewed" that is not YYYY-MM-DD`)
    }
  }
  return entries
}

const isAllowed = (allowlist, finding) =>
  allowlist.some(
    (e) => e.rule === finding.rule && e.path === finding.path && e.sha256 === finding.sha256,
  )


const scanText = (text, path, origin) => {
  const found = []
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  const lineOf = (index) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  for (const rule of SHAPED_RULES) {
    rule.re.lastIndex = 0
    for (const m of text.matchAll(rule.re)) {
      found.push({
        rule: rule.id,
        description: rule.description,
        path,
        origin,
        line: lineOf(m.index),
        sha256: sha256(m[0]),
        length: m[0].length,
      })
    }
  }

  CONTEXTUAL_RULE.re.lastIndex = 0
  for (const m of text.matchAll(CONTEXTUAL_RULE.re)) {
    const value = m.groups.value
    if (NON_SECRET_KEY_SUFFIXES.test(m.groups.key)) continue
    if (looksLikePlaceholder(value)) continue
    if (entropy(value) < CONTEXTUAL_RULE.minEntropy) continue
    found.push({
      rule: CONTEXTUAL_RULE.id,
      description: `${CONTEXTUAL_RULE.description} (\`${m.groups.key}\`)`,
      path,
      origin,
      line: lineOf(m.index),
      sha256: sha256(value),
      length: value.length,
    })
  }

  return found
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0)

const git = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], { maxBuffer: 512 * 1024 * 1024 })

const gitText = (repo, args) => git(repo, args).toString('utf8')

const scanTree = (repo) => {
  const paths = gitText(repo, ['ls-files', '-z']).split('\0').filter(Boolean)
  const findings = []
  for (const path of paths) {
    if (skipped(path)) continue
    let buf
    try {
      buf = readFileSync(resolve(repo, path))
    } catch {
      // Tracked but absent (sparse checkout or uncommitted delete): nothing to scan.
      continue
    }
    if (isBinary(buf)) continue
    findings.push(...scanText(buf.toString('utf8'), path, 'working tree'))
  }
  return findings
}

const scanRange = (repo, range) => {
  const commits = gitText(repo, ['rev-list', '--no-merges', range]).split('\n').filter(Boolean)
  const findings = []
  // Keyed on blob and path: the path is part of the report and the allowlist match.
  const seen = new Set()

  for (const commit of commits) {
    const raw = gitText(repo, [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--no-renames',
      '--diff-filter=AM',
      '-r',
      '-z',
      commit,
    ])
    // `-z` raw format alternates metadata and path.
    const fields = raw.split('\0').filter(Boolean)
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const meta = fields[i]
      const path = fields[i + 1]
      if (!meta.startsWith(':')) continue
      const blob = meta.split(' ')[3]
      if (!blob || /^0+$/.test(blob)) continue
      if (skipped(path)) continue
      const key = `${blob}:${path}`
      if (seen.has(key)) continue
      seen.add(key)

      let buf
      try {
        buf = git(repo, ['cat-file', 'blob', blob])
      } catch {
        // A blob missing from a shallow or partial clone is reported, not a green scan of nothing.
        findings.push({
          rule: 'unreadable-blob',
          description: 'a blob in the range could not be read from this clone',
          path,
          origin: `commit ${commit.slice(0, 12)}`,
          line: 0,
          sha256: sha256(key),
          length: 0,
        })
        continue
      }
      if (isBinary(buf)) continue
      findings.push(
        ...scanText(buf.toString('utf8'), path, `commit ${commit.slice(0, 12)}`),
      )
    }
  }
  return findings
}


const report = (findings, allowlist) => {
  const live = []
  const excused = []
  for (const f of dedupe(findings)) (isAllowed(allowlist, f) ? excused : live).push(f)

  const out = []
  if (excused.length > 0) {
    out.push(`${excused.length} match(es) excused by .github/secret-scan-allowlist.json:`)
    for (const f of excused) out.push(`  - ${f.rule} at ${f.path}:${f.line}`)
    out.push('')
  }

  if (live.length === 0) {
    out.push('No unexplained credentials found.')
    return { ok: true, text: out.join('\n'), live }
  }

  out.push(`${live.length} possible credential(s) found:`)
  out.push('')
  for (const f of live) {
    out.push(`  ${f.rule}  ${f.path}:${f.line}  (${f.origin})`)
    out.push(`    ${f.description}`)
    out.push(`    ${f.length} characters, sha256 ${f.sha256}`)
    out.push('')
  }
  out.push('If any of these is real:')
  out.push('  1. Rotate it. It is in the git history and deleting the line does not')
  out.push('     remove it -- see docs/secrets.md for the rotation runbook.')
  out.push('  2. Then remove it from the tree.')
  out.push('')
  out.push('If it is not a credential, add an entry to')
  out.push('.github/secret-scan-allowlist.json with the rule, the path, the sha256')
  out.push('printed above and a reason somebody can evaluate later.')
  return { ok: false, text: out.join('\n'), live }
}

const dedupe = (findings) => {
  const seen = new Set()
  const out = []
  for (const f of findings) {
    const key = `${f.rule}:${f.path}:${f.sha256}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}


const main = () => {
  const argv = process.argv.slice(2)
  const flag = (name) => argv.includes(name)
  const value = (name, fallback) => {
    const i = argv.indexOf(name)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
  }

  const repo = resolve(value('--repo', resolve(HERE, '..')))
  const allowlistPath = resolve(value('--allowlist', ALLOWLIST_PATH))
  const range = value('--range', null)
  const wantTree = flag('--tree') || !range

  const allowlist = loadAllowlist(allowlistPath)
  const findings = []
  if (wantTree) findings.push(...scanTree(repo))
  if (range) findings.push(...scanRange(repo, range))

  const { ok, text } = report(findings, allowlist)
  process.stdout.write(`${text}\n`)
  if (!ok && !flag('--report-only')) process.exitCode = 1
}

main()
