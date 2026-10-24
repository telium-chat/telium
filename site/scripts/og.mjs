#!/usr/bin/env node
/* Render public/og.png — the card that shows up when someone pastes a link.
 *
 * Drawn in the same browser, with the same font file and the same oklch tokens
 * the site itself uses, so the preview and the page agree. The font is inlined
 * as a data URI because a file:// page cannot fetch a sibling file:// font
 * without loosening Chromium's origin rules, and loosening them to draw a
 * picture is a poor trade.
 *
 * Run: node scripts/og.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = new URL('../', import.meta.url)
const WIDTH = 1200
const HEIGHT = 630

const main = async () => {
  const font = await readFile(
    fileURLToPath(
      new URL('node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2', root),
    ),
  )
  const mark = await readFile(
    fileURLToPath(new URL('public/brand/telium-mark-gradient.svg', root)),
    'utf8',
  )
  const wordmark = await readFile(
    fileURLToPath(new URL('public/brand/telium-wordmark-light.svg', root)),
    'utf8',
  )
  const svgDataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

  const html = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: "IBM Plex Sans Variable";
    src: url(data:font/woff2;base64,${font.toString('base64')}) format("woff2-variations");
    font-weight: 100 700;
  }
  :root {
    --background: oklch(21.5% 0.008 258);
    --foreground: oklch(94.5% 0.004 250);
    --muted: oklch(70.5% 0.012 255);
    --border: oklch(31% 0.011 258);
    --accent: #B68DF0;
    --accent-foreground: #1A1230;
  }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: ${WIDTH}px; height: ${HEIGHT}px;
    background: var(--background); color: var(--foreground);
    font-family: "IBM Plex Sans Variable", sans-serif;
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 72px 80px;
    -webkit-font-smoothing: antialiased;
  }
  .mark { display: flex; align-items: center; gap: 18px; }
  .mark img { display: block; object-fit: contain; }
  .wordmark { width: 120px; height: 48px; }
  h1 {
    font-size: 62px; line-height: 1.1; font-weight: 600; letter-spacing: -0.03em;
    max-width: 20ch; text-wrap: balance;
  }
  footer {
    display: flex; justify-content: space-between; align-items: baseline;
    border-top: 1px solid var(--border); padding-top: 26px;
    font-size: 21px; color: var(--muted);
  }
</style>
<div class="mark">
  <img src="${svgDataUri(mark)}" alt="" width="48" height="48" />
  <img class="wordmark" src="${svgDataUri(wordmark)}" alt="Telium" width="120" height="48" />
</div>
<h1>Group chat your community actually owns.</h1>
<footer><span>Open source, Apache-2.0</span><span>telium.chat</span></footer>`

  const browser = await chromium.launch({
    executablePath: process.env.TELIUM_BROWSER_PATH || undefined,
  })
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  })
  await page.setContent(html)
  await page.waitForFunction(() => document.fonts.status === 'loaded')

  await mkdir(fileURLToPath(new URL('public/', root)), { recursive: true })
  await writeFile(
    fileURLToPath(new URL('public/og.png', root)),
    await page.screenshot({ type: 'png' }),
  )
  await browser.close()
  console.log('wrote public/og.png')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
