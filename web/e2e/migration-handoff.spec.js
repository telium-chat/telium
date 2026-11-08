import { test, expect } from '@playwright/test';
import { register } from './onboarding.js';

const APP = 'http://127.0.0.1:5173';
const HOME = 'http://127.0.0.1:8448';
const HANDOFF_SECRET = 'test-handoff-' + 'a'.repeat(20);

// A browser-scoped, two-tab regression. Both old and new account sessions
// share telium.chat's origin. A mock destination API checks the correct token
// and claim body, while the real old tab MUST remain attached to its source.
test('confirm destination in a second tab without switching or restarting the source', async ({ page, context }) => {
  await page.goto(APP);
  await register(page, {
    home: HOME, username: 'migration-handoff-e2e',
    password: 'correct horse battery staple',
  });
  await expect(page.getByRole('heading', { name: 'Save your recovery key' }))
    .toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'I saved my recovery key' }).click();
  await expect(page.getByTitle('Settings')).toBeVisible({ timeout: 20_000 });

  // The real local server's identity is "localhost", not telium.local.
  const source = await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem('telium.session.v1') || 'null');
    return {
      domain: session?.home?.domain || '',
      userId: session?.home?.user_id || '',
      instance: window.telium?.instance,
    };
  });
  expect(source.domain).toBeTruthy();
  expect(source.userId).toBeTruthy();

  // Reuse the production registry API to simulate a remembered destination
  // account. Do not hand-roll credential persistence in the browser test:
  // the helper owns the account format and all session storage behavior.
  await page.evaluate(async () => {
    const { rememberSession } = await import('/src/lib/accounts.js');
    rememberSession({
      home: {
        base: 'https://new.example',
        domain: 'new.example',
        token: 'test-destination-token',
        user_id: '@target:new.example',
        device_id: 'dest-device',
      },
      servers: {},
    }, { touch: true });
  });

  const receivingTab = await context.newPage();
  const received = [];
  await receivingTab.route('https://new.example/**', async (route) => {
    const request = route.request();
    const headers = {
      'Access-Control-Allow-Origin': APP,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Content-Type': 'application/json',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (request.url().endsWith('/_telium/v1/migrate/accept')) {
      received.push({ body: request.postDataJSON(), auth: request.headers().authorization });
      await route.fulfill({
        status: 200, headers,
        body: JSON.stringify({ delivered: true, target_id: '@target:new.example' }),
      });
      return;
    }
    await route.abort();
  });
  const fragment = new URLSearchParams({
    h: '01JABCDEFGHJKMNPQRSTVWXYZ0',
    s: HANDOFF_SECRET,
    from: source.domain,
    id: source.userId,
    to: 'new.example',
  });
  await receivingTab.goto(APP + '/receive-move#' + fragment);
  await expect(receivingTab.getByRole('heading', { name: 'Continue the move on new.example' }))
    .toBeVisible({ timeout: 20_000 });
  await expect(receivingTab.getByText('This move comes from ' + source.domain + '.', { exact: false }))
    .toBeVisible();
  await expect(receivingTab.getByTitle('Settings')).toHaveCount(0);
  await expect(page.getByTitle('Settings')).toBeVisible();

  await receivingTab.getByRole('button', { name: 'Continue as @target:new.example' }).click();
  expect(received).toHaveLength(0); // Selecting is not consent.
  await receivingTab.getByRole('button', { name: 'Receive this account' }).click();
  await expect(receivingTab.getByRole('heading', { name: 'Destination confirmed' }))
    .toBeVisible({ timeout: 15_000 });
  expect(received).toHaveLength(1);
  expect(received[0].auth).toBe('Bearer test-destination-token');
  expect(received[0].body).toEqual({
    subject_type: 'user',
    source: source.domain, source_id: source.userId,
    handoff: { id: '01JABCDEFGHJKMNPQRSTVWXYZ0',
      secret: HANDOFF_SECRET },
  });

  for (const tab of [page, receivingTab]) {
    const state = await tab.evaluate(() => ({
      active: JSON.parse(localStorage.getItem('telium.session.v1') || 'null')?.home?.user_id,
    }));
    expect(state.active).toBe(source.userId);
  }
  expect(await page.evaluate(() => window.telium?.instance)).toBe(source.instance);
  await expect(page.getByTitle('Settings')).toBeVisible();

  // A real source tab periodically refreshes/saves its global session.
  // That storage event must not restart the independent receiver tab.
  const receiverInstance = await receivingTab.evaluate(() => window.telium?.instance);
  await page.evaluate(() => {
    window.telium.session.home.expires_at = Date.now() + 3_600_000;
    window.telium.save();
  });
  await expect(receivingTab.getByRole('heading', { name: 'Destination confirmed' })).toBeVisible();
  expect(await receivingTab.evaluate(() => window.telium?.instance)).toBe(receiverInstance);

  await receivingTab.getByRole('button', { name: 'Close this handoff' }).click();
  await expect(receivingTab.getByRole('heading', { name: 'Handoff closed' })).toBeVisible();
  await receivingTab.close();
});
