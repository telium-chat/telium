#!/usr/bin/env node
// Dependency advisory gate: unreviewed or expired-exempt advisories fail; warnings and stale exemptions only report.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWLIST = join(REPO, '.github', 'dependency-audit-allowlist.json')

// Every lockfile is named explicitly; `check-dependency-sources.mjs` fails on any missing here.
const TARGETS = [
  { ecosystem: 'cargo', name: 'server', lock: 'server/Cargo.lock' },
  { ecosystem: 'cargo', name: 'sfu', lock: 'sfu/Cargo.lock' },
  { ecosystem: 'cargo', name: 'telium-protocol', lock: 'telium-protocol/Cargo.lock' },
  { ecosystem: 'cargo', name: 'web/src-tauri', lock: 'web/src-tauri/Cargo.lock' },
  { ecosystem: 'npm', name: 'web', dir: 'web' },
  { ecosystem: 'npm', name: 'web/electron', dir: 'web/electron' },
  { ecosystem: 'npm', name: 'site', dir: 'site' },
]

// `moderate` and below is mostly build-time tooling; gating on it would cost the job its credibility.
const NPM_SEVERITY_FLOOR = 'high'
const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0, none: 0 }
const rank = (s) => SEVERITY_RANK[String(s || '').toLowerCase()] ?? 0

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

const reportOnly = has('--report-only')
const findingsPath = valueOf('--findings')
const inputPath = valueOf('--input')


// `expires` is YYYY-MM-DD at UTC midnight; the expiry day itself is still valid.
const today = () => new Date().toISOString().slice(0, 10)

const loadAllowlist = () => {
  let raw
  try {
    raw = readFileSync(ALLOWLIST, 'utf8')
  } catch (err) {
    // A malformed allowlist must fail: it would look like it exempts something.
    if (err.code === 'ENOENT') return []
    throw err
  }
  const parsed = JSON.parse(raw)
  const entries = Array.isArray(parsed.advisories) ? parsed.advisories : []
  for (const e of entries) {
    for (const field of ['id', 'ecosystem', 'package', 'reason', 'reviewed', 'expires', 'reviewer']) {
      if (!e[field] || typeof e[field] !== 'string') {
        throw new Error(`allowlist entry ${JSON.stringify(e.id ?? e)} is missing a string "${field}"`)
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) {
      throw new Error(`allowlist entry ${e.id} has expires="${e.expires}", which is not YYYY-MM-DD`)
    }
    // The reviewer needs why it was thought safe, not a restatement of the title.
    if (e.reason.length < 80) {
      throw new Error(`allowlist entry ${e.id} has a reason too short to be a justification`)
    }
  }
  return entries
}


const run = (cmd, cmdArgs, cwd) =>
  execFileSync(cmd, cmdArgs, {
    cwd: join(REPO, cwd || '.'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Both exit non-zero on findings, so output decides. stderr stays attached for real failures.
    stdio: ['ignore', 'pipe', 'inherit'],
  })

const runAllowingFailure = (cmd, cmdArgs, cwd) => {
  try {
    return run(cmd, cmdArgs, cwd)
  } catch (err) {
    // Empty stdout means the tool did not run, not a clean result.
    const out = err.stdout ? String(err.stdout) : ''
    if (!out.trim()) throw new Error(`${cmd} produced no output: ${err.message}`)
    return out
  }
}

// A format change should fail loudly, not look like an empty result.
const scanCargo = (target) => {
  const out = runAllowingFailure('cargo', ['audit', '--json', '--file', target.lock])
  const data = JSON.parse(out)
  const findings = []
  for (const v of data?.vulnerabilities?.list ?? []) {
    findings.push({
      ecosystem: 'cargo',
      target: target.name,
      id: v?.advisory?.id ?? 'UNKNOWN',
      package: v?.package?.name ?? 'unknown',
      version: v?.package?.version ?? '',
      severity: v?.advisory?.cvss ? 'high' : 'unknown',
      title: v?.advisory?.title ?? '',
      url: v?.advisory?.id ? `https://rustsec.org/advisories/${v.advisory.id}` : '',
      fixed: (v?.versions?.patched ?? []).join(', '),
      gating: true,
    })
  }
  for (const [kind, list] of Object.entries(data?.warnings ?? {})) {
    for (const w of list ?? []) {
      findings.push({
        ecosystem: 'cargo',
        target: target.name,
        id: w?.advisory?.id ?? kind,
        package: w?.package?.name ?? 'unknown',
        version: w?.package?.version ?? '',
        severity: kind,
        title: w?.advisory?.title ?? kind,
        url: w?.advisory?.id ? `https://rustsec.org/advisories/${w.advisory.id}` : '',
        fixed: (w?.versions?.patched ?? []).join(', '),
        // Never worth failing a PR over: there is no version to upgrade to.
        gating: false,
      })
    }
  }
  return findings
}

const scanNpm = (target) => {
  const out = runAllowingFailure('bun', ['audit', '--json'], target.dir)
  const data = JSON.parse(out || '{}')
  const findings = []
  for (const [pkg, list] of Object.entries(data)) {
    for (const a of Array.isArray(list) ? list : []) {
      findings.push({
        ecosystem: 'npm',
        target: target.name,
        id: a?.url?.split('/').pop() || String(a?.id ?? 'UNKNOWN'),
        package: pkg,
        version: '',
        severity: String(a?.severity ?? 'unknown').toLowerCase(),
        title: a?.title ?? '',
        url: a?.url ?? '',
        fixed: a?.vulnerable_versions ? `not ${a.vulnerable_versions}` : '',
        // Below the floor still prints, so raising it is an informed decision.
        gating: rank(a?.severity) >= rank(NPM_SEVERITY_FLOOR),
      })
    }
  }
  return findings
}


const classify = (findings, allowlist) => {
  const used = new Set()
  const blocking = []
  const expired = []
  const exempt = []
  const informational = []

  for (const f of findings) {
    const entry = allowlist.find(
      (e) => e.id === f.id && e.ecosystem === f.ecosystem && e.package === f.package,
    )
    if (entry) {
      used.add(entry)
      // Expiry first: an expired exemption came due whether or not the advisory would gate today.
      if (entry.expires < today()) expired.push({ ...f, entry })
      else exempt.push({ ...f, entry })
      continue
    }
    if (f.gating) blocking.push(f)
    else informational.push(f)
  }

  const stale = allowlist.filter((e) => !used.has(e))
  return { blocking, expired, exempt, informational, stale }
}

const summarize = (verdict, targets) => {
  const lines = ['### Dependency advisories', '']
  const { blocking, expired, exempt, informational, stale } = verdict

  lines.push(`Scanned ${targets.length} dependency trees: ${targets.map((t) => t.name).join(', ')}.`)
  lines.push('')

  const table = (rows) => {
    const out = ['| tree | package | advisory | severity | fix |', '|---|---|---|---|---|']
    for (const f of rows) {
      const id = f.url ? `[${f.id}](${f.url})` : f.id
      out.push(`| ${f.target} | ${f.package} ${f.version} | ${id} | ${f.severity} | ${f.fixed || '_none published_'} |`)
    }
    return out
  }

  if (blocking.length) {
    lines.push(`#### ${blocking.length} advisory/advisories with no reviewed exemption`, '')
    lines.push(...table(blocking), '')
    lines.push(
      'Upgrade the dependency, or -- if that is not possible and the exposure has',
      'been reasoned about -- add a dated entry to `.github/dependency-audit-allowlist.json`.',
      '',
    )
  }
  if (expired.length) {
    lines.push(`#### ${expired.length} exemption(s) past their review date`, '')
    for (const f of expired) {
      lines.push(`- **${f.id}** (${f.package}) expired \`${f.entry.expires}\`, reviewed \`${f.entry.reviewed}\` by ${f.entry.reviewer}.`)
    }
    lines.push('', 'Re-review and extend the date, or fix the advisory and delete the entry.', '')
  }
  if (exempt.length) {
    lines.push(`#### ${exempt.length} advisory/advisories under a current exemption`, '')
    for (const f of exempt) {
      lines.push(`- ${f.id} (${f.package}, ${f.target}) — review due \`${f.entry.expires}\``)
    }
    lines.push('')
  }
  if (informational.length) {
    lines.push(`#### ${informational.length} informational finding(s), not gated`, '')
    lines.push(...table(informational), '')
  }
  if (stale.length) {
    lines.push(`#### ${stale.length} exemption(s) that no longer match anything`, '')
    for (const e of stale) lines.push(`- ${e.id} (${e.package}) — the advisory is gone; delete this entry.`)
    lines.push('')
  }
  if (!blocking.length && !expired.length && !exempt.length && !informational.length && !stale.length) {
    lines.push('No advisories in any scanned dependency tree.', '')
  }
  return lines.join('\n')
}


const main = () => {
  const allowlist = loadAllowlist()

  let findings
  let targets = TARGETS
  if (inputPath) {
    // Test hook: runs the decision logic against a fixture without the scanners.
    const fixture = JSON.parse(readFileSync(inputPath, 'utf8'))
    findings = fixture.findings ?? []
    targets = fixture.targets ?? TARGETS
  } else {
    findings = []
    for (const t of targets) {
      findings.push(...(t.ecosystem === 'cargo' ? scanCargo(t) : scanNpm(t)))
    }
  }

  const verdict = classify(findings, allowlist)
  const summary = summarize(verdict, targets)
  process.stdout.write(summary + '\n')

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n')
  }
  if (findingsPath) {
    writeFileSync(findingsPath, JSON.stringify({ generated_at: Date.now(), ...verdict }, null, 2) + '\n')
  }

  const fatal = verdict.blocking.length + verdict.expired.length
  if (fatal && !reportOnly) {
    console.error(`\naudit-gate: ${fatal} finding(s) require action.`)
    process.exit(1)
  }
  if (fatal) console.error(`\naudit-gate: ${fatal} finding(s) require action (report-only; not failing).`)
}

main()
