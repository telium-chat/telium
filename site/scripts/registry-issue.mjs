#!/usr/bin/env node
/* Turn a listing issue into a registry change.
 *
 * The /list wizard on the site files a prefilled GitHub issue (templates
 * `.github/ISSUE_TEMPLATE/list-server.yml` / `list-sfu.yml`, labelled
 * `directory`); the workflow that runs this script turns the issue into a
 * one-entry pull request. The point of the indirection is that an operator
 * should never have to know what a fork is — but the registry itself stays a
 * git file reviewed like any other.
 *
 * The issue body is untrusted input, so nothing in it is carried through
 * as-is: the entry is rebuilt from an allowlist of schema fields, the `added`
 * date is stamped here rather than trusted from the submitter, and the two
 * consent switches (`recommendations` / `feed`) are read only from the issue's
 * own checkboxes, never from the JSON. What the submitter could not set, the
 * rebuild cannot smuggle. The existing validators stay the gate — the rules
 * live in one place.
 *
 * Exit codes: 0 ok · 2 no entry or unparseable · 3 duplicate · 4 ownership not
 * attested · 1 the validator rejected the rebuilt entry.
 *
 * Run: node scripts/registry-issue.mjs --kind server --body-file <f> --created <iso> [--registry <f>]
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Registry and validator paths are URLs when defaulted and strings when given
// on the command line; fs and child_process want plain paths.
const asPath = (value) => (typeof value === 'string' ? value : fileURLToPath(value))

/* GitHub drops display-only markdown elements from the submitted issue.
   Determine the kind from the mutually exclusive JSON identity fields. */

const MAX_BODY_BYTES = 200 * 1024
const MAX_ENTRY_CHARS = 8 * 1024

/* --- reading the rendered issue form -------------------------------------- */

// GitHub renders each form field as a `### Label` heading followed by the
// field's content, up to the next heading. Extract one field's slice.
export const sectionFor = (body, heading) => {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('### ')) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n')
}

// The wizard submits the entry as a fenced json block so it renders as code on
// the issue; a hand-filler may paste bare JSON instead. Take either.
export const parseEntryObject = (section) => {
  if (section === null) throw new Error('no "Registry entry" section in the issue body')
  const fenced = section.match(/```(?:json)?\s*\n([\s\S]*?)```/)
  const candidate = (fenced ? fenced[1] : section).trim()
  if (candidate.length > MAX_ENTRY_CHARS) {
    throw new Error(`the entry is ${candidate.length} characters; the registry expects one small JSON object`)
  }
  try {
    return JSON.parse(candidate)
  } catch (error) {
    throw new Error(`the "Registry entry" section is not valid JSON — ${error.message}. Re-run the wizard at telium.chat/list, or follow site/registry/README.md by hand.`)
  }
}

// Checkbox fields render as `- [X] label`. Required checkboxes are enforced by
// GitHub, but the ownership attestation is load-bearing enough to re-check.
export const checkboxChecked = (body, optionText) => {
  if (body === null) return false
  const norm = (value) => value.replace(/\s+/g, ' ').trim().toLowerCase()
  const wanted = norm(optionText)
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*[-*] \[([xX])\]\s*(.*)$/)
    if (!match) continue
    const label = norm(match[2])
    if (label === wanted || label.startsWith(wanted + ' ')) return true
  }
  return false
}

export const detectKind = (body) => {
  const section = sectionFor(body, 'Registry entry')
  if (section === null) return null
  let entry
  try {
    entry = parseEntryObject(section)
  } catch {
    return null
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
  // Both fields together are ambiguous, even if only one is a string.
  if (typeof entry.domain === 'string' && !('url' in entry)) return 'server'
  if (typeof entry.url === 'string' && !('domain' in entry)) return 'sfu'
  return null
}

/* --- rebuilding the entry from the allowlist ------------------------------- */

// Copy only the string fields the schema knows. A field of the wrong shape is
// left out rather than copied: the validator then reports it in the same plain
// language it uses for a hand-written entry, which is exactly the review the
// issue would have gotten anyway.
const pickStrings = (raw, keys, into) => {
  for (const key of keys) {
    if (typeof raw[key] === 'string') into[key] = raw[key]
  }
}

const pickObject = (raw, key, fields, into) => {
  const value = raw[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  const picked = {}
  for (const field of fields) {
    if (typeof value[field] === 'string') picked[field] = value[field]
  }
  into[key] = picked
}

export const rebuildEntry = (kind, raw, { added, consent }) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('the entry must be a JSON object')
  }
  const entry = {}
  if (kind === 'server') {
    pickStrings(raw, ['domain', 'name', 'description', 'size_band'], entry)
    pickObject(raw, 'region', ['label', 'code'], entry)
    pickObject(raw, 'operator', ['name', 'contact'], entry)
    if (consent) entry.recommendations = { opt_in: true }
  } else {
    // A relay's URL is its identity, so a trailing slash — invisible in a
    // browser, fatal to the validator's duplicate check — is removed here
    // rather than bouncing the issue over it.
    if (typeof raw.url === 'string') entry.url = raw.url.trim().replace(/\/+$/, '')
    pickStrings(raw, ['name', 'description', 'capacity_band'], entry)
    pickObject(raw, 'region', ['label', 'code'], entry)
    pickObject(raw, 'operator', ['name', 'contact'], entry)
    if (consent) entry.feed = { opt_in: true }
  }
  // Consent switches exist only as the issue's checkboxes, and the date is
  // stamped by the machine that merges: neither arrives through the JSON.
  entry.added = added
  return entry
}

/* --- sorted insertion ------------------------------------------------------- */

export const identityOf = (entry, kind) => (kind === 'server' ? entry.domain : entry.url)

const compareIdentities = (kind, a, b) => {
  if (kind === 'server') {
    if (a === 'telium.chat') return -1
    if (b === 'telium.chat') return 1
  }
  return a.localeCompare(b)
}

// Returns a new array with the entry in its validator-approved position. An
// existing entry whose identity is not a string is skipped for placement (the
// validator will already be failing on it; do not crash on top).
export const insertEntry = (entries, entry, kind) => {
  const identity = identityOf(entry, kind)
  let index = entries.length
  for (let i = 0; i < entries.length; i++) {
    const existing = identityOf(entries[i], kind)
    if (typeof existing !== 'string') continue
    if (compareIdentities(kind, identity, existing) < 0) {
      index = i
      break
    }
  }
  return [...entries.slice(0, index), entry, ...entries.slice(index)]
}

export const findDuplicate = (entries, entry, kind) => {
  const identity = identityOf(entry, kind)
  const normalized = kind === 'sfu' ? String(identity).replace(/\/+$/, '') : identity
  return entries.find((existing) => {
    const other = identityOf(existing, kind)
    if (typeof other !== 'string') return false
    return (kind === 'sfu' ? other.replace(/\/+$/, '') : other) === normalized
  })
}

/* --- command line ----------------------------------------------------------- */

const arg = (argv, name) => {
  const index = argv.indexOf(`--${name}`)
  return index !== -1 ? argv[index + 1] : undefined
}

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const slug = (identity) =>
  String(identity).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'entry'

const main = async () => {
  const argv = process.argv.slice(2)
  const bodyFile = arg(argv, 'body-file')
  const created = arg(argv, 'created')
  const registryArg = arg(argv, 'registry')
  const kindArg = arg(argv, 'kind')

  if (!bodyFile || !created) {
    fail('usage: registry-issue.mjs --kind server|sfu --body-file <file> --created <iso-date> [--registry <file>]')
  }

  let body
  try {
    body = await readFile(bodyFile, 'utf8')
    if (body.length > MAX_BODY_BYTES) throw new Error('larger than 200 KB')
  } catch (error) {
    fail(`could not read the issue body — ${error.message}`)
  }

  const kind = kindArg ?? detectKind(body)
  if (kind !== 'server' && kind !== 'sfu') {
    fail('cannot determine the listing type — provide exactly one of "domain" (server) or "url" (relay) in the Registry entry JSON. Use telium.chat/list, or follow site/registry/README.md by hand.')
  }

  const added = new Date(created)
  if (Number.isNaN(added.getTime())) fail(`--created "${created}" is not a date this script understands`)
  const addedDate = added.toISOString().slice(0, 10)

  const ownershipOption = kind === 'server'
    ? 'I run this server myself'
    : 'I run this relay myself'
  if (!checkboxChecked(sectionFor(body, 'Ownership'), ownershipOption)) {
    console.error('the Ownership box is not ticked. The registry lists only servers and relays run by the person listing them; tick the box — honestly — and resubmit.')
    process.exit(4)
  }

  let raw
  try {
    raw = parseEntryObject(sectionFor(body, 'Registry entry'))
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }

  const consentOption = kind === 'server'
    ? 'Also suggest this server automatically'
    : 'Also let guilds in automatic mode route calls'
  const consent = checkboxChecked(sectionFor(body, kind === 'server' ? 'Automatic suggestions' : 'Automatic call routing'), consentOption)

  let entry
  try {
    entry = rebuildEntry(kind, raw, { added: addedDate, consent })
  } catch (error) {
    console.error(`${error.message} Re-run the wizard at telium.chat/list, or follow site/registry/README.md by hand.`)
    process.exit(2)
  }
  const identity = identityOf(entry, kind) || '(no identity given)'

  const registryPath = registryArg ?? new URL(`../registry/${kind === 'server' ? 'servers' : 'sfus'}.json`, import.meta.url)
  let entries
  try {
    entries = JSON.parse(await readFile(registryPath, 'utf8'))
  } catch (error) {
    fail(`could not read the registry to insert into — ${error.message}`)
  }
  if (!Array.isArray(entries)) fail('the registry file is not a JSON array; refusing to touch it')

  const duplicate = findDuplicate(entries, entry, kind)
  if (duplicate) {
    console.error(`${identity} is already listed (as "${duplicate.name}"). This directory is one entry per ${kind === 'server' ? 'domain' : 'origin'}.`)
    console.error(kind === 'server'
      ? 'To correct or update a listing, open an ordinary pull request against site/registry/servers.json.'
      : 'To correct or update a listing, open an ordinary pull request against site/registry/sfus.json.')
    process.exit(3)
  }

  const updated = insertEntry(entries, entry, kind)
  await writeFile(registryPath, `${JSON.stringify(updated, null, 2)}\n`)

  // The validators carry every rule and every plain-language error; the bot
  // adds none of its own. Their output goes back to the issue verbatim.
  const validator = new URL(kind === 'server' ? './validate-registry.mjs' : './validate-sfus.mjs', import.meta.url)
  const check = spawnSync(process.execPath, [asPath(validator), asPath(registryPath)], { encoding: 'utf8' })
  if (check.stderr) process.stderr.write(check.stderr)
  if (check.stdout) process.stdout.write(check.stdout)
  if (check.status !== 0) {
    console.error('the rebuilt entry did not pass the registry validator — nothing will be committed.')
    process.exit(1)
  }

  const title = `List ${identity}`
  console.log(`inserted ${identity} into the ${kind === 'server' ? 'homeserver' : 'relay'} registry`)
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    await appendFile(output, [
      `kind=${kind}`,
      `identity=${identity}`,
      `title=${title}`,
      `slug=${slug(identity)}`,
    ].join('\n') + '\n')
  }
}

// The exports are the testable half (the workflow exercises the CLI itself);
// only run as a command when invoked as one, so importing never exits.
// `node` accepts plain paths and file:// URLs as its entry argument alike.
const entryArg = process.argv[1]
const entryPath = entryArg?.startsWith('file://') ? fileURLToPath(entryArg) : entryArg
if (entryPath && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  main()
}
