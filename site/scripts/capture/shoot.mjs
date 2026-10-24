#!/usr/bin/env node
/* Photograph the seeded client, once per theme.
 *
 * The session is installed into localStorage rather than typed into the login
 * form: the shot we want is of the chat view, and driving a form to get there
 * adds a page of Playwright that can break for reasons that have nothing to do
 * with the picture. The client reads `telium.session.v1` on boot, so writing it
 * is the same thing signing in does.
 *
 * Run: node scripts/capture/shoot.mjs <base-url> <session.json> <out-dir>
 */

import { readFile, mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import sharp from 'sharp'

const [, , BASE = 'http://127.0.0.1:8449', SESSION_PATH = '.capture/session.json', OUT = 'public/screenshots'] =
  process.argv

/* Hold a gateway connection open for each seeded account.
 *
 * Presence in Telium is a property of a live connection, not a column someone
 * can set — which is correct, and which means a member list photographed
 * without these is five grey dots and one green one. So the extras are really
 * online for the length of the shoot, and the picture is of a real room.
 */
const connectCrew = (base, crew) => {
  const url = `${base.replace(/^http/, 'ws')}/gateway/v1`
  const sockets = crew.map(({ token, status }) => {
    const socket = new WebSocket(url)
    let heartbeat
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data)
      if (frame.op === 'HELLO') {
        socket.send(JSON.stringify({ op: 'IDENTIFY', d: { token, presence: { status } } }))
        heartbeat = setInterval(
          () => socket.send(JSON.stringify({ op: 'HEARTBEAT' })),
          frame.d.heartbeat_interval_ms / 2,
        )
      }
    })
    socket.addEventListener('close', () => clearInterval(heartbeat))
    return { socket, close: () => { clearInterval(heartbeat); socket.close() } }
  })

  const ready = Promise.all(
    sockets.map(
      ({ socket }) =>
        new Promise((resolve) => {
          const done = (event) => {
            if (JSON.parse(event.data).op !== 'READY') return
            socket.removeEventListener('message', done)
            resolve()
          }
          socket.addEventListener('message', done)
        }),
    ),
  )

  return { ready, close: () => sockets.forEach((s) => s.close()) }
}

const WIDTH = 1440
const HEIGHT = 900
const SCALE = 2

const main = async () => {
  const seed = JSON.parse(await readFile(SESSION_PATH, 'utf8'))
  await mkdir(OUT, { recursive: true })

  const crew = connectCrew(BASE, seed.crew ?? [])
  await crew.ready
  console.log(`${seed.crew?.length ?? 0} accounts online`)

  const browser = await chromium.launch()

  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: SCALE,
      colorScheme: theme,
      // A capture machine's clock and locale should not leak into the image.
      locale: 'en-GB',
      timezoneId: 'UTC',
      reducedMotion: 'reduce',
    })

    await context.addInitScript((session) => {
      localStorage.setItem('telium.session.v1', session)
    }, JSON.stringify(seed.session))

    const page = await context.newPage()
    await page.goto(BASE, { waitUntil: 'networkidle' })

    /* Theme is account state, not browser state — the client reads it from the
       home server's sync store, which is why writing the old localStorage key
       here produced two dark screenshots. It is not written over the API
       either: the first boot seals this account's sync store, and after that
       the server is right to refuse a plaintext value from outside. So the
       theme is set the way the appearance pane sets it, through the client's
       own store, which seals and persists it exactly as a click would. */
    await page.waitForFunction(() => Boolean(window.telium?.savePrefs), null, { timeout: 30_000 })
    await page.evaluate((want) => {
      window.telium.prefs.theme = want
      window.telium.savePrefs()
    }, theme)

    // The client boots to no selection, exactly as it would for a returning
    // user, so the shoot picks a guild and a channel the way a person does.
    await page.getByRole('button', { name: /Foundry/i }).first().click()
    await page.getByRole('button', { name: /^#?\s*general/i }).first().click()

    // Wait for content, not for a timer: the last seeded line being on screen
    // is the only reliable signal that history and the gateway both landed.
    await page.getByText('be there in ten').first().waitFor({ timeout: 30_000 })
    await page.waitForFunction(
      (want) => document.documentElement.dataset.theme === want,
      theme,
      { timeout: 15_000 },
    )
    await page.waitForFunction(() => document.fonts.status === 'loaded')
    /* The client draws emoji as images from a CDN, so a shot taken the instant
       the text lands has empty reaction pills in it. Wait for the pictures too
       — and note that this capture therefore needs network, unlike the site it
       produces. */
    await page.waitForFunction(() =>
      Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0),
    )
    await page.waitForTimeout(300)

    const png = await page.screenshot({ type: 'png' })
    await context.close()

    const base = `${OUT}/client-${theme}`
    await sharp(png).webp({ quality: 82, effort: 6 }).toFile(`${base}@2x.webp`)
    await sharp(png)
      .resize(WIDTH, HEIGHT, { fit: 'inside' })
      .webp({ quality: 84, effort: 6 })
      .toFile(`${base}.webp`)

    console.log(`wrote ${base}.webp and ${base}@2x.webp`)
  }

  await browser.close()
  crew.close()
}

main().catch(async (error) => {
  console.error(error.message)
  process.exit(1)
})

