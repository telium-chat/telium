#!/usr/bin/env node
/* Take the landing-page screenshots, end to end, in one command.
 *
 * Starts a throwaway homeserver in .capture/ — its own config, its own SQLite
 * file, its own media directory, its own port — seeds it, photographs it, and
 * tears it down. It never touches a database anywhere else: a capture run that
 * could write to the server you actually use is a capture run nobody should be
 * willing to execute.
 *
 * Needs, and checks for: a built `telium-server`, a built web client, and a
 * Playwright chromium. Network too — the client draws emoji from a CDN.
 *
 * Run: node scripts/capture/run.mjs [path-to-repository-root]
 */

import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
// The server and the client live beside this directory in the same repository,
// so the default needs no argument. Pass one to shoot a checkout elsewhere.
const TELIUM = resolve(process.argv[2] ?? join(root, '..'))
const WORK = join(root, '.capture')
const PORT = 8449
const BASE = `http://127.0.0.1:${PORT}`

const SERVER_BIN = join(TELIUM, 'server/target/debug/telium-server')
const WEB_DIST = join(TELIUM, 'web/dist')

const exists = async (path) => access(path).then(() => true, () => false)

const run = (command, args, options = {}) =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options })
    let out = ''
    child.stdout?.on('data', (chunk) => (out += chunk))
    child.on('exit', (code) => (code === 0 ? done(out) : fail(new Error(`${command} exited ${code}`))))
  })

const waitForHealth = async (timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/_telium/v1/health`)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`server did not answer on ${BASE} — see .capture/server.log`)
}

const main = async () => {
  for (const [path, hint] of [
    [SERVER_BIN, 'cargo build (in the server directory)'],
    [WEB_DIST, 'bun install --frozen-lockfile && bun run build (in the web directory)'],
  ]) {
    if (!(await exists(path))) throw new Error(`missing ${path} — run: ${hint}`)
  }

  // A fresh database every run, so the shot never depends on what a previous
  // run happened to leave behind.
  await rm(WORK, { recursive: true, force: true })
  await mkdir(WORK, { recursive: true })
  await writeFile(
    join(WORK, 'telium.toml'),
    [
      '# Written by scripts/capture/run.mjs. Scratch only — deleted every run.',
      'server_name = "telium.local"',
      `public_base_url = "${BASE}"`,
      `bind = "127.0.0.1:${PORT}"`,
      'database_url = "sqlite://telium.db?mode=rwc"',
      'media_dir = "media"',
      '',
      '[web]',
      `dir = ${JSON.stringify(WEB_DIST)}`,
      '',
      '[registration]',
      'open = true',
      '',
      '[backup]',
      'enabled = false',
      '',
    ].join('\n'),
  )

  const log = await import('node:fs').then((fs) => fs.openSync(join(WORK, 'server.log'), 'w'))
  const server = spawn(SERVER_BIN, ['--config', 'telium.toml'], {
    cwd: WORK,
    stdio: ['ignore', log, log],
  })
  server.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`server exited ${code} — see .capture/server.log`)
  })

  try {
    await waitForHealth()
    console.log(`scratch server up on ${BASE}`)

    // The database path goes with the URL because the seed has one job the API
    // cannot do for it — see the note on `retime` in seed.mjs — and this is the
    // file it is allowed to do it to.
    const session = await run(process.execPath, [
      join(root, 'scripts/capture/seed.mjs'),
      BASE,
      join(WORK, 'telium.db'),
    ])
    await writeFile(join(WORK, 'session.json'), session)
    console.log('seeded')

    await run(
      process.execPath,
      [
        join(root, 'scripts/capture/shoot.mjs'),
        BASE,
        join(WORK, 'session.json'),
        join(root, 'public/screenshots'),
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    )
    // Only on the way out of a run that worked. A failed run's scratch
    // directory is the only place the server's log exists, and deleting it
    // would leave whoever has to debug this with the exit code and nothing else.
    server.kill('SIGTERM')
    await rm(WORK, { recursive: true, force: true })
  } finally {
    server.kill('SIGTERM')
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
