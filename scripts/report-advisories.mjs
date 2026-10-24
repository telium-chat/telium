#!/usr/bin/env node
// Keeps one tracking issue in step with the weekly advisory sweep; closes when findings clear.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TITLE = 'Dependency advisories'
// Hidden HTML comment marker; the digest after it tells the next run whether anything changed.
const MARKER = '<!-- telium:dependency-advisories -->'
const DIGEST_PREFIX = '<!-- telium:digest '

const gh = (args, { allowFailure = false } = {}) => {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
  } catch (err) {
    if (allowFailure) return null
    throw err
  }
}

const findingsPath = process.argv[2]
if (!findingsPath) {
  console.error('usage: report-advisories.mjs <findings.json>')
  process.exit(2)
}

// A missing findings file means the audit failed, not that nothing was found.
let findings
try {
  findings = JSON.parse(readFileSync(findingsPath, 'utf8'))
} catch (err) {
  console.error(`could not read ${findingsPath}: ${err.message}`)
  console.error('The audit step did not produce a findings file; refusing to report "all clear".')
  process.exit(1)
}

const blocking = findings.blocking ?? []
const expired = findings.expired ?? []
const exempt = findings.exempt ?? []
const stale = findings.stale ?? []
const actionable = [...blocking, ...expired]

// Only actionable findings count, so informational warnings do not notify.
const digest = actionable
  .map((f) => `${f.ecosystem}:${f.target}:${f.package}:${f.id}`)
  .sort()
  .join(',')

const repo = process.env.GITHUB_REPOSITORY
const runUrl = process.env.GITHUB_RUN_ID
  ? `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null

const body = () => {
  const out = [MARKER, `${DIGEST_PREFIX}${digest} -->`, '']
  out.push(`_Updated automatically by the weekly dependency audit${runUrl ? ` ([latest run](${runUrl}))` : ''}._`)
  out.push('')

  if (!actionable.length) {
    out.push('No advisory in any scanned dependency tree currently needs action.')
  }
  if (blocking.length) {
    out.push(`## ${blocking.length} advisory/advisories with no reviewed exemption`, '')
    out.push('| tree | package | advisory | severity | fix |', '|---|---|---|---|---|')
    for (const f of blocking) {
      const id = f.url ? `[${f.id}](${f.url})` : f.id
      out.push(`| \`${f.target}\` | ${f.package} ${f.version} | ${id} | ${f.severity} | ${f.fixed || '_none published_'} |`)
    }
    out.push('')
    out.push(
      'Each of these will also block the next pull request that touches a manifest or',
      'lockfile. Upgrade the dependency, or add a dated entry to',
      '`.github/dependency-audit-allowlist.json` with the reasoning.',
      '',
    )
  }
  if (expired.length) {
    out.push(`## ${expired.length} exemption(s) past their review date`, '')
    for (const f of expired) {
      out.push(`- **${f.id}** (\`${f.package}\`) — expired \`${f.entry.expires}\`, last reviewed \`${f.entry.reviewed}\` by ${f.entry.reviewer}`)
      out.push(`  > ${String(f.entry.reason).replace(/\s+/g, ' ')}`)
    }
    out.push('', 'Re-establish the reasoning and extend the date, or fix the advisory and delete the entry.', '')
  }
  if (exempt.length) {
    out.push('<details><summary>Advisories under a current exemption</summary>', '')
    for (const f of exempt) out.push(`- ${f.id} (\`${f.package}\`, ${f.target}) — review due \`${f.entry.expires}\``)
    out.push('', '</details>', '')
  }
  if (findings.informational?.length) {
    out.push('<details><summary>Informational: unmaintained, yanked and unsound crates</summary>', '')
    for (const f of findings.informational) out.push(`- ${f.id} — ${f.package} ${f.version} (${f.target}, ${f.severity})`)
    out.push('', '</details>', '')
  }
  if (stale.length) {
    out.push('<details><summary>Exemptions that no longer match anything</summary>', '')
    for (const e of stale) out.push(`- ${e.id} (\`${e.package}\`) — the advisory is gone; this entry can be deleted.`)
    out.push('', '</details>', '')
  }
  return out.join('\n')
}

// Search is eventually consistent, so check open and recently closed issues; a miss files a second issue.
const findIssue = () => {
  const raw = gh(
    ['issue', 'list', '--state', 'all', '--limit', '50', '--search', TITLE, '--json', 'number,state,body,title'],
    { allowFailure: true },
  )
  if (!raw) return null
  let list
  try {
    list = JSON.parse(raw)
  } catch {
    return null
  }
  return list.find((i) => typeof i.body === 'string' && i.body.includes(MARKER)) ?? null
}

const withBodyFile = (text, fn) => {
  // A file avoids a multi-kilobyte table through argv and shell quoting.
  const path = join(mkdtempSync(join(tmpdir(), 'advisories-')), 'body.md')
  writeFileSync(path, text)
  return fn(path)
}

const existing = findIssue()
const text = body()

if (!existing) {
  if (!actionable.length) {
    console.log('No actionable advisories and no tracking issue: nothing to do.')
    process.exit(0)
  }
  const url = withBodyFile(text, (path) =>
    gh(['issue', 'create', '--title', TITLE, '--body-file', path]),
  )
  console.log(`Opened ${url}`)
  process.exit(0)
}

const previousDigest = (existing.body.match(/<!-- telium:digest (.*?) -->/) ?? [])[1] ?? ''
const changed = previousDigest !== digest

withBodyFile(text, (path) => gh(['issue', 'edit', String(existing.number), '--body-file', path]))

if (!actionable.length) {
  if (existing.state === 'OPEN') {
    gh([
      'issue',
      'close',
      String(existing.number),
      '--comment',
      'Every advisory that needed action has been resolved. The weekly sweep will reopen this if another appears.',
    ])
    console.log(`Closed #${existing.number}: nothing left to act on.`)
  } else {
    console.log(`#${existing.number} is already closed and there is nothing to act on.`)
  }
  process.exit(0)
}

if (existing.state !== 'OPEN') {
  gh(['issue', 'reopen', String(existing.number)])
  console.log(`Reopened #${existing.number}.`)
} else if (changed) {
  // Editing a body is silent, so comment when a new advisory appears in an open issue.
  const added = actionable
    .map((f) => `${f.ecosystem}:${f.target}:${f.package}:${f.id}`)
    .filter((k) => !previousDigest.split(',').includes(k))
  const summary = added.length
    ? `New since the last sweep: ${added.map((k) => k.split(':').pop()).join(', ')}.`
    : 'The set of advisories needing action has changed.'
  gh(['issue', 'comment', String(existing.number), '--body', `${summary} The description above is current.`])
  console.log(`Commented on #${existing.number}: the finding set changed.`)
} else {
  console.log(`#${existing.number} updated; the finding set is unchanged, so no comment was posted.`)
}
