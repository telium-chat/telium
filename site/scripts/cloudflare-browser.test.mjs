// The actual portal app running inside a real Chromium browser against local
// Cloudflare Workers Static Assets. Vite's test server cannot reproduce the
// HTML canonicalization that broke production after PR #37.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.TELIUM_ASSET_SMOKE_ORIGIN || 'http://127.0.0.1:8787';
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // A link without a handoff must never open normal chat or canonicalize away
  // the receiver URL; it is the user's exact production reproduction.
  for (const path of ['/receive-move', '/receive-move/']) {
    const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
    assert.equal(response?.status(), 200, path + ': browser navigation must return HTTP 200');
    await page.getByRole('heading', { name: 'Move link expired' }).waitFor({ timeout: 20000 });
    // The client strips the optional slash to one canonical receiver URL.
    assert.equal(new URL(page.url()).pathname, '/receive-move',
      path + ': must remain on the receiver, never /channels/@me or /app');
  }

  // No real credentials or server required: the receiver should open before
  // trying to connect to any source/destination homeserver. The fragment is
  // intentionally synthetic and is never printed into CI logs.
  const fragment = new URLSearchParams({
    h: '01JABCDEFGHJKMNPQRSTVWXYZ0',
    s: 'test-' + 'a'.repeat(28),
    from: 'old.example',
    id: '@alice:old.example',
    to: 'new.example',
  });
  // Real guided moves open a NEW tab. Reusing the empty receiver page and
  // changing only its #fragment would not trigger a document navigation.
  const handoffPage = await context.newPage();
  handoffPage.on('pageerror', (error) => pageErrors.push(error.message));
  const response = await handoffPage.goto(origin + '/receive-move#' + fragment, {
    waitUntil: 'domcontentloaded',
  });
  assert.equal(response?.status(), 200, 'secret-bearing handoff must return HTTP 200');
  await handoffPage.getByRole('heading', { name: 'Continue the move on new.example' })
    .waitFor({ timeout: 20000 });
  const finalUrl = new URL(handoffPage.url());
  assert.equal(finalUrl.pathname, '/receive-move', 'client must retain the receiver URL');
  assert.equal(finalUrl.hash, '', 'handoff secret must be stripped from the address bar');
  await handoffPage.getByRole('button', { name: 'Sign in or create an account on new.example' })
    .waitFor({ timeout: 10000 });
  assert.deepEqual(pageErrors, [], 'portal must boot without JavaScript errors');
  await context.close();
  console.log('Chromium + real Cloudflare runtime: receiver route, expired link, handoff and fragment stripping passed.');
} finally {
  await browser.close();
}
