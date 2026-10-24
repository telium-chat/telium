import { test, expect } from '@playwright/test';
import { register as createAccount } from './onboarding.js';

const APP = 'http://127.0.0.1:5173';
const HOME = 'http://127.0.0.1:8448';
const PASSWORD = 'correct horse battery staple';

async function register(page, username) {
  await page.goto(APP);
  await createAccount(page, { home: HOME, username, password: PASSWORD });

  await expect(page.getByRole('heading', { name: 'Save your recovery key' }))
    .toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'I saved my recovery key' }).click();
  await expect(page.getByTitle('Settings')).toBeVisible({ timeout: 20_000 });
}

async function emojiNames(page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('span.text-2xs')).toHaveCount(7);
  return dialog.locator('span.text-2xs').allTextContents();
}

test('Alice and Bob reach the same emoji, both finish, and trust survives reload', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  try {
    await Promise.all([
      register(alice, 'alice-e2e'),
      register(bob, 'bob-e2e'),
    ]);

    await alice.goto(`${APP}/friends`);
    await alice.getByLabel('Add friend').fill('@bob-e2e:telium.local');
    await alice.getByRole('button', { name: 'Send request' }).click();

    await bob.goto(`${APP}/friends`);
    await bob.getByRole('button', { name: 'Pending', exact: true }).click();
    await expect(bob.getByTitle('Accept')).toBeVisible({ timeout: 10_000 });
    await bob.getByTitle('Accept').click();

    await alice.goto(`${APP}/friends`);
    await alice.getByRole('button', { name: 'All', exact: true }).click();
    const message = alice.getByRole('button', { name: 'Message', exact: true });
    await expect(message).toBeVisible({ timeout: 10_000 });
    await message.click();

    await expect(alice.getByTitle('Conversation details')).toBeVisible({ timeout: 20_000 });
    await alice.getByTitle('Conversation details').click();
    await expect(alice.getByRole('button', { name: 'Verify', exact: true }))
      .toBeVisible({ timeout: 20_000 });
    await alice.getByRole('button', { name: 'Verify', exact: true }).click();

    await expect(alice.getByRole('heading', { name: 'Verify bob-e2e' }))
      .toBeVisible({ timeout: 20_000 });
    await expect(bob.getByRole('heading', { name: 'Verify alice-e2e' }))
      .toBeVisible({ timeout: 20_000 });

    await expect(alice.getByRole('button', { name: 'They match' }))
      .toBeVisible({ timeout: 20_000 });
    await expect(bob.getByRole('button', { name: 'They match' }))
      .toBeVisible({ timeout: 20_000 });

    expect(await emojiNames(alice)).toEqual(await emojiNames(bob));

    await Promise.all([
      alice.getByRole('button', { name: 'They match' }).click(),
      bob.getByRole('button', { name: 'They match' }).click(),
    ]);

    await expect(alice.getByText(/bob-e2e is verified\./)).toBeVisible({ timeout: 20_000 });
    await expect(bob.getByText(/alice-e2e is verified\./)).toBeVisible({ timeout: 20_000 });

    await alice.getByRole('button', { name: 'Done' }).click();
    // Header close and footer Close both exist; use the footer to avoid ambiguity.
    await alice.locator('.telium-modal-footer').getByRole('button', { name: 'Close' }).click();

    await alice.reload();
    await expect(alice.getByTitle('Conversation details')).toBeVisible({ timeout: 20_000 });
    await alice.getByTitle('Conversation details').click();
    const bobRow = alice.getByText('@bob-e2e:telium.local', { exact: true }).locator('..');
    await expect(bobRow.getByText('verified', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(bobRow.getByRole('button', { name: 'Verify', exact: true })).toHaveCount(0);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
